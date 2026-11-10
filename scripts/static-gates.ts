/**
 * @file Run the independent static gates concurrently behind one command.
 *
 * ## Why this exists
 *
 * The six gates below share no state and no ordering: each one reads the tree
 * and reports. They used to run one after another out of habit, so the serial
 * baseline on this host — `tsc` 5.1 s, `typecheck:tests` 12.5 s,
 * `typecheck:kg` 5.2 s, `lint` 10.2 s, `fallow:ci` 2.1 s, `fallow:kg` 0.5 s,
 * 35.6 s total — was six independent measurements queued for no reason. Behind
 * this command the same six gates cost 26.5 s and 2209 MB of peak RSS, which is
 * the reduction {@link MAX_CONCURRENT_GATES} is set to buy and no more.
 *
 * ## `build` is NOT in this set, and must not be added
 *
 * Every gate here is read-only over the checkout. `pnpm run build` is not: it
 * writes `dist/`, and anything that spawns `dist/api.js` — the launcher and
 * viewer suites, the packed-consumer suites — reads what it writes. A build running
 * beside those readers is a race whose losing runs look like product bugs, so
 * `build` stays ordered BEFORE anything that spawns `dist/`, in the hook and in
 * CI, and never becomes a member of {@link STATIC_GATES}.
 *
 * ## Attribution instead of interleaving
 *
 * Several concurrent processes writing to one terminal produce a log nobody can
 * read: a gate's error line arrives between two other gates' progress lines, and
 * which gate failed becomes a puzzle. So each gate's stdout and stderr are
 * BUFFERED and printed as one contiguous block, labelled, the moment that gate
 * finishes, and the run ends with a summary table whose last line names every
 * failed gate. The cost is that nothing is shown live while a gate runs; the
 * benefit is that the output is attributable, which is the whole point.
 *
 * ## Nothing here writes what another gate reads
 *
 * Verified by observation, not assumed: the working tree plus every
 * `*.tsbuildinfo`, `.eslintcache`, `.fallow*` and `node_modules/.cache` path was
 * captured before and after a concurrent run and around a serial one, and both
 * runs write the same set — the two fallow caches, one under the repository root
 * and one under `packages/llmwiki-kg/ts`, one per fallow gate. No compiler here
 * is incremental, so no gate emits a build-info file, and no gate shares a cache
 * with another. If a gate ever starts writing a path a sibling reads, it comes
 * OUT of this set rather than being made to race.
 *
 * ## pnpm is resolved, never assumed
 *
 * Every child is spawned through the invocation `scripts/pnpm-invocation.ts`
 * proved working, because on this machine the bare name `pnpm` resolves and then
 * exits 127 — the failure that made two gates red for every branch while
 * reporting a code failure. Resolution happens once, reused by all six gates.
 *
 * ## A timeout is a failure, and it says so
 *
 * A concurrent run must not be able to hang forever, and a hung gate must not be
 * reported as a generic error. Each gate is bounded by {@link GATE_TIMEOUT_MS}
 * and reported as `timeout after N s`, which is a distinct fact from a failing
 * assertion and has a different remedy.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { isEntryPoint, readRoot } from "./cli-root.ts";
import { resolvePnpm, type PnpmCandidate } from "./pnpm-invocation.ts";

/** One gate: what it is called, and the pnpm arguments that run it. */
export interface StaticGate {
  /** Short label, used in the block header and in the summary table. */
  label: string;
  /** Arguments passed to pnpm, AFTER the arguments that select pnpm itself. */
  args: readonly string[];
}

/** One gate's finished run: what it printed, whether it passed, and how long it took. */
export interface GateOutcome {
  /** The gate's label, so a block or a row can attribute itself. */
  label: string;
  /** The child's exit status; `null` when a signal ended it or it never started. */
  status: number | null;
  /** True when {@link GATE_TIMEOUT_MS} expired, which is a failure with its own wording. */
  timedOut: boolean;
  /** Wall time of this gate alone, from spawn to close. */
  durationMs: number;
  /** Everything the gate wrote, stdout and stderr interleaved in arrival order. */
  output: string;
}

/**
 * 300 s per gate, not a tight bound.
 *
 * The slowest gate measured on this host is `typecheck:tests` at 12.5 s, so a
 * bound anywhere near that would turn a loaded machine into a false failure. It
 * fires only on a gate that is genuinely stuck, and it fires as a reported
 * timeout rather than as a silent hang.
 */
export const GATE_TIMEOUT_MS = 300_000;

/**
 * How many gates may be in flight at once.
 *
 * SIZED FROM MEASURED PEAK RSS, NOT FROM THE GATE COUNT. Peak was taken as the
 * cgroup `memory.peak` of the run's scope, which counts descendants, one run per
 * configuration on this host:
 *
 *   6 lanes at once: 3387 MB, 20.9 s wall
 *   3 lanes:         2748 MB and 2754 MB (two runs), 22.1 s and 23.1 s
 *   2 lanes:         2209 MB, 26.5 s
 *   serial:          1532 MB, 40.8 s
 *
 * Six lanes buy one second over three and spend a gigabyte for it. Three still
 * measures above the ~2.5 GB a single verification run may hold on a host that
 * also carries other sessions, so the cap is two: the pool is what makes the set
 * cost less than serial without making two deliveries fight. What remains is
 * `typecheck:tests`, which dominates at every lane count, so a higher cap would
 * not buy much even if the memory were free.
 */
export const MAX_CONCURRENT_GATES = 2;

/**
 * The independent static gates, and the one source of truth for that set.
 *
 * Exported as one constant so the pinned contract in `static-gates.test.ts` reads
 * the same list the runner executes: a gate that disappears from here fails a
 * test, instead of quietly making every run cheaper and less true.
 */
export const STATIC_GATES: readonly StaticGate[] = [
  { label: "tsc", args: ["exec", "tsc", "--noEmit"] },
  { label: "typecheck:tests", args: ["run", "typecheck:tests"] },
  { label: "typecheck:kg", args: ["run", "typecheck:kg"] },
  { label: "lint", args: ["run", "lint"] },
  { label: "fallow:ci", args: ["run", "fallow:ci"] },
  { label: "fallow:kg", args: ["run", "fallow:kg"] },
];

/** Seconds with one decimal — the unit every timing in this repository's reports uses. */
function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** Human status for one gate: pass, exit code, or timeout. */
export function describeStatus(run: GateOutcome): string {
  if (run.timedOut) return `timeout after ${Math.round(GATE_TIMEOUT_MS / 1000)} s`;
  return run.status === 0 ? "ok" : `failed (exit ${run.status ?? "unknown"})`;
}

/** Every gate that did not pass, in completion order. */
export function failedLabels(runs: readonly GateOutcome[]): string[] {
  return runs.filter((run) => run.timedOut || run.status !== 0).map((run) => run.label);
}

/** One gate's contiguous, labelled block: the header names it, the body is its own output. */
function formatBlock(run: GateOutcome): string {
  const header = `\n=== ${run.label} — ${describeStatus(run)} in ${formatSeconds(run.durationMs)} ===\n`;
  if (run.output === "") return `${header}(no output)\n`;
  return `${header}${run.output.endsWith("\n") ? run.output : `${run.output}\n`}`;
}

/**
 * The table a reader scans instead of scrolling, and the verdict as its last line.
 *
 * The final line repeats the failing gates deliberately: an exit status is
 * invisible in a pasted log, and "which gate failed" must not depend on the
 * reader replaying the run.
 * @param runs - Completed gates, in the order they finished.
 * @param wallMs - Wall time of the whole run, so the summary and the rows add up.
 */
export function formatSummary(runs: readonly GateOutcome[], wallMs: number): string {
  const width = Math.max(...runs.map((run) => run.label.length));
  const rows = runs.map(
    (run) => `  ${run.label.padEnd(width)}  ${describeStatus(run).padEnd(16)}  ${formatSeconds(run.durationMs)}`,
  );
  const failed = failedLabels(runs);
  const verdict =
    failed.length === 0
      ? `static gates: all ${runs.length} passed in ${formatSeconds(wallMs)}`
      : `static gates: ${failed.length} of ${runs.length} failed — ${failed.join(", ")} (${formatSeconds(wallMs)} wall)`;
  return ["\nstatic gates — summary", ...rows, verdict, ""].join("\n");
}

/**
 * Kill the gate and everything it started.
 *
 * The children run in their own process group for exactly this: a timeout that
 * killed only the `pnpm` wrapper would leave the real compiler running, and a
 * gate that outlived its own timeout is the state a timeout exists to escape.
 */
function killGateGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * A gate run being observed: buffered output, whether its timeout fired, and the
 * one-shot settle that turns it into a {@link GateOutcome}.
 */
interface GateRecorder {
  pieces: string[];
  /** Set by the timeout before the kill, so the outcome reports a timeout, not a signal. */
  timedOut: boolean;
  settle(status: number | null): void;
}

/**
 * Build the recorder for one gate run.
 *
 * `error` and `close` can both fire for a child that never started, so settling
 * is guarded here instead of in each handler: a second settle is a no-op rather
 * than a second outcome.
 * @param gate - The gate being run, for its label.
 * @param startedAt - `performance.now()` at spawn, so the duration is the gate's own.
 * @param resolve - The promise's resolver.
 */
function createRecorder(gate: StaticGate, startedAt: number, resolve: (run: GateOutcome) => void): GateRecorder {
  let settled = false;
  const recorder: GateRecorder = {
    pieces: [],
    timedOut: false,
    settle(status: number | null): void {
      if (settled) return;
      settled = true;
      resolve({
        label: gate.label,
        status: recorder.timedOut ? null : status,
        timedOut: recorder.timedOut,
        durationMs: performance.now() - startedAt,
        output: recorder.pieces.join(""),
      });
    },
  };
  return recorder;
}

/**
 * Run one gate to completion, buffering its output.
 * @param root - Repository root, used as the child's cwd.
 * @param pnpm - The pnpm invocation proven to work, shared by every gate.
 * @param gate - The gate to run.
 * @returns Its status, duration and buffered output; never rejects.
 */
function runGate(root: string, pnpm: PnpmCandidate, gate: StaticGate): Promise<GateOutcome> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(pnpm.command, [...pnpm.args, ...gate.args], {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const recorder = createRecorder(gate, startedAt, resolve);
    // Both streams land in one buffer on purpose: inside a single gate, arrival
    // order is the order the tool meant, and splitting them would move a stack
    // trace away from the line that explains it.
    const collect = (chunk: Buffer): void => {
      recorder.pieces.push(chunk.toString("utf8"));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      recorder.timedOut = true;
      killGateGroup(child);
    }, GATE_TIMEOUT_MS);
    child.on("error", (error: Error) => {
      recorder.pieces.push(`static-gates: could not start ${gate.label} — ${error.message}\n`);
      clearTimeout(timer);
      recorder.settle(1);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      recorder.settle(status);
    });
  });
}

/**
 * Run every gate with at most {@link MAX_CONCURRENT_GATES} in flight.
 *
 * A fixed number of lanes pulling from one cursor, rather than one promise per
 * gate: the queue is what makes a lower cap a one-constant change if the
 * measured peak RSS ever says the whole set is too much for the host.
 * @param root - Repository root.
 * @param pnpm - The resolved pnpm invocation.
 * @param gates - The gate list to run.
 * @param report - Called with each gate as it finishes, so its block prints at once.
 * @returns Every outcome, in completion order.
 */
async function runGates(
  root: string,
  pnpm: PnpmCandidate,
  gates: readonly StaticGate[],
  report: (run: GateOutcome) => void,
): Promise<GateOutcome[]> {
  const outcomes: GateOutcome[] = [];
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < gates.length) {
      const gate = gates[cursor];
      cursor += 1;
      if (gate === undefined) return;
      const outcome = await runGate(root, pnpm, gate);
      outcomes.push(outcome);
      report(outcome);
    }
  };
  const lanes = Math.min(MAX_CONCURRENT_GATES, gates.length);
  await Promise.all(Array.from({ length: lanes }, lane));
  return outcomes;
}

/**
 * Command entry: run the gates, print their blocks and the summary, report the verdict.
 * @param argv - Arguments after the script path; `--root` is honoured.
 * @returns 0 when every gate passed, 1 when any failed or pnpm could not be resolved.
 */
async function main(argv: readonly string[]): Promise<number> {
  const root = readRoot(argv);
  const resolution = resolvePnpm(root);
  if (!resolution.ok) {
    process.stderr.write(resolution.message);
    return 1;
  }
  if (resolution.fellBack) {
    process.stderr.write(`static-gates: pnpm resolved via ${resolution.invocation.label}\n`);
  }
  const startedAt = performance.now();
  const runs = await runGates(root, resolution.invocation, STATIC_GATES, (run) => {
    process.stdout.write(formatBlock(run));
  });
  const wallMs = performance.now() - startedAt;
  process.stdout.write(formatSummary(runs, wallMs));
  const failed = failedLabels(runs);
  if (failed.length === 0) return 0;
  process.stderr.write(`static gates: failed — ${failed.join(", ")}\n`);
  return 1;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  void main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}
