/**
 * @file Execute the test selection decided by `scripts/test-affected.ts`.
 *
 * Kept separate from the resolver so the scoping logic stays a pure, testable
 * function while this module owns the one impure step: spawning vitest. The
 * split also keeps each file under the size budget.
 *
 * FOUR outcomes, matching {@link AffectedScope}. The difference between them is
 * the whole point of this module, so none of them may borrow another's wording:
 *
 *   - `files`      → `vitest related <changed files>`, which runs only tests
 *                    that import them.
 *   - `global`     → DECLINED. A build/test-config change CAN reach any file, so
 *                    the scope resolved and the escalation decision stands, but
 *                    the full unit tier is a subset of `pnpm test` and running it
 *                    here pays for the same files twice. This prints
 *                    {@link FULL_TIER_LINE} and exits {@link EXIT_FULL_TIER_DECLINED}.
 *   - `unresolved` → the changed set could not be computed at all (no base ref,
 *                    or a failed merge-base/diff). Not an escalation and not a
 *                    `none`: it prints which step failed and exits
 *                    {@link EXIT_SCOPE_UNRESOLVED}.
 *   - `none`       → exit 0 without running anything, and reachable ONLY by a
 *                    computation that succeeded and found nothing relevant.
 *
 * EVERY `files` outcome also runs the output contracts listed in
 * {@link OUTPUT_CONTRACT_TESTS}; `scripts/output-contracts.ts` explains why that
 * list exists and how to justify an entry. Which invocations that produces is
 * decided by the pure `planAffectedInvocations`, so the coverage is asserted by
 * `scripts/output-contracts.test.ts` without spawning anything.
 *
 * IMPORTING THIS MODULE RUNS NOTHING. The entry is {@link runAffectedTests}, and
 * it takes the scope decision and the runner as injected dependencies, so the
 * three statuses are assertable without a child process
 * (`test/run-affected-tests-outcomes.test.ts`). The top-level call sits behind the
 * invoked-directly guard this repository's scripts use.
 *
 * pnpm is RESOLVED, not assumed: every child below is spawned through the
 * invocation `scripts/pnpm-invocation.ts` proved working, because the bare name
 * `pnpm` resolves and then exits 127 on a machine with a stale launcher, which
 * made this gate red for every branch while reporting a code failure.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readRoot } from "./cli-root.ts";
import { OUTPUT_CONTRACT_TESTS, planAffectedInvocations, type VitestInvocation } from "./output-contracts.ts";
import { resolvePnpm, type PnpmCandidate } from "./pnpm-invocation.ts";
import { resolveAffectedScope, type AffectedScope } from "./test-affected.ts";

/**
 * The resolved full unit tier was declined rather than run: EX_CONFIG (78).
 *
 * A dedicated non-zero status, not 0, because this command ran ZERO tests. A
 * note plus a green exit would read as "verified" to a script, a hook, or an
 * agent under time pressure, which is the silent-green shape to refuse.
 */
export const EXIT_FULL_TIER_DECLINED = 78;

/**
 * The changed set could not be computed: EX_UNAVAILABLE (69).
 *
 * Deliberately distinct from {@link EXIT_FULL_TIER_DECLINED}: nothing was
 * resolved here, so claiming "the full tier applies" would be false, and
 * borrowing the `none` wording would be a clean run over a set nobody read.
 */
export const EXIT_SCOPE_UNRESOLVED = 69;

/**
 * What the full-tier refusal prints, byte for byte, on stderr.
 *
 * The `affected:` prefix is NOT this module's `test-affected:` convention and
 * must not be normalised to it: the mandated contract is asserted byte-exactly.
 */
const FULL_TIER_LINE = 'affected: scope resolves to the full unit tier; run `pnpm test` instead\n';

/** Runs a plan; the seam a test replaces so it can count invocations without spawning. */
export type AffectedRunner = (plan: readonly VitestInvocation[]) => number;

/** Dependencies a caller may inject; absent fields fall back to the real implementations. */
export interface AffectedRunDeps {
  /** The resolved scope decision, instead of resolving it from git. */
  scope?: AffectedScope;
  /** The invocation runner, instead of spawning vitest. */
  runner?: AffectedRunner;
}

/** The `files` outcome, which is the only one that plans invocations. */
type FilesScope = Extract<AffectedScope, { kind: "files" }>;

/**
 * Spawn a command, inheriting stdio so the hook shows real progress.
 * @param root - Repository root, used as the child's cwd.
 * @param command - Executable to start.
 * @param args - Arguments for that executable.
 * @param label - Human name for the command, used in the failure message.
 * @returns The child's exit status, or 1 when it could not be started.
 */
function spawnInherit(root: string, command: string, args: readonly string[], label: string): number {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`test-affected: could not start ${label} — ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Run one pnpm command through the resolved invocation.
 *
 * The resolved command and its own arguments are kept together so every call
 * site reaches pnpm the same way; a call site that named `pnpm` again would
 * reintroduce exactly the resolution failure this module fixed.
 * @param root - Repository root, used as the child's cwd.
 * @param pnpm - The invocation proven to work.
 * @param args - Arguments after the ones that select pnpm.
 * @param label - Human name for the command, used in the failure message.
 */
function spawnPnpm(root: string, pnpm: PnpmCandidate, args: readonly string[], label: string): number {
  return spawnInherit(root, pnpm.command, [...pnpm.args, ...args], label);
}

/**
 * Run vitest.
 * @param root - Repository root.
 * @param pnpm - The resolved pnpm invocation.
 * @param argv - Full argv AFTER the `vitest` binary (`run …` or `related …`).
 */
function runVitest(root: string, pnpm: PnpmCandidate, argv: readonly string[]): number {
  return spawnPnpm(root, pnpm, ["exec", "vitest", ...argv], "vitest");
}

/**
 * Build `dist/` when a contract file needs it and it is absent.
 *
 * The output contracts spawn `node dist/cli.js`, so a checkout that was never
 * built cannot run them. Skipping them would turn a real byte-contract check
 * into a silent no-op, so this BUILDS ONCE instead, and a failing build fails
 * the hook. (vitest's own `globalSetup` also builds; this covers the case where
 * the contract list is the reason a build is needed at all.)
 *
 * @param root - Repository root.
 * @param pnpm - The resolved pnpm invocation.
 * @returns Process status: 0 when a build was unnecessary or succeeded.
 */
function ensureBuiltCli(root: string, pnpm: PnpmCandidate): number {
  if (OUTPUT_CONTRACT_TESTS.length === 0 || existsSync(path.join(root, "dist", "cli.js"))) return 0;
  process.stderr.write(
    "test-affected: dist/cli.js is missing — running `pnpm run build` once for the output contracts\n",
  );
  return spawnPnpm(root, pnpm, ["run", "build"], "the build");
}

/**
 * Say what the selection covers, so the log explains the run it is about to pay for.
 * @param scope - The `files` selection being run.
 */
function announceTier(scope: FilesScope): void {
  process.stderr.write(`test-affected: ${scope.files.length} changed file(s); running related tests only\n`);
}

/** Say which output contracts the run adds, so the extra work is auditable. */
function announceContracts(plan: readonly VitestInvocation[]): void {
  const added = [...new Set(plan.flatMap((invocation) => invocation.addedContracts))];
  if (added.length === 0) return;
  process.stderr.write(`test-affected: adding output-contract file(s) — ${added.join(", ")}\n`);
}

/**
 * Run every planned invocation.
 *
 * A failure does not stop the remaining ones — the next invocation may show that
 * the failure is isolated — but the first failing status is the one returned.
 */
function runPlan(root: string, pnpm: PnpmCandidate, plan: readonly VitestInvocation[]): number {
  let status = 0;
  for (const invocation of plan) {
    const code = runVitest(root, pnpm, invocation.argv);
    if (code !== 0 && status === 0) status = code;
  }
  return status;
}

/**
 * Resolve pnpm once and report a fallback, so the ordinary path stays quiet.
 * @param root - Repository root the resolver probes from.
 * @returns The invocation, or null after the failure message was written.
 */
function resolveOrReport(root: string): PnpmCandidate | null {
  const resolution = resolvePnpm(root);
  if (!resolution.ok) {
    process.stderr.write(resolution.message);
    return null;
  }
  if (resolution.fellBack) {
    process.stderr.write(`test-affected: pnpm resolved via ${resolution.invocation.label}\n`);
  }
  return resolution.invocation;
}

/**
 * The real runner: resolve pnpm, ensure the contracts have a build, then spawn vitest.
 * @param root - Repository root.
 * @returns The runner, or null after the failure message was written.
 */
function createDefaultRunner(root: string): AffectedRunner | null {
  const pnpm = resolveOrReport(root);
  if (pnpm === null) return null;
  return (plan) => {
    const buildStatus = ensureBuiltCli(root, pnpm);
    if (buildStatus !== 0) return buildStatus;
    return runPlan(root, pnpm, plan);
  };
}

/**
 * Plan and run the `files` selection.
 * @param root - Repository root.
 * @param scope - The selection to run.
 * @param deps - Injected dependencies; the real runner is built when none is given.
 * @returns The status this run reports.
 */
function runFilesScope(root: string, scope: FilesScope, deps: AffectedRunDeps): number {
  const plan = planAffectedInvocations(scope, []);
  announceTier(scope);
  announceContracts(plan);
  const runner = deps.runner ?? createDefaultRunner(root);
  if (runner === null) return 1;
  return runner(plan);
}

/**
 * Report the outcome the scope selected, and run only what still needs running.
 * @param argv - Process argv after the script name; `--root` is honoured.
 * @param deps - Injected scope decision and runner; both default to the real ones.
 * @returns The exit status this run reports.
 */
export function runAffectedTests(argv: readonly string[], deps: AffectedRunDeps = {}): number {
  const root = readRoot(argv);
  const scope = deps.scope ?? resolveAffectedScope(root);
  if (scope.kind === "none") {
    process.stderr.write(`test-affected: nothing to run — ${scope.reason}\n`);
    return 0;
  }
  if (scope.kind === "unresolved") {
    process.stderr.write(`test-affected: could not compute the changed file set — ${scope.reason}\n`);
    return EXIT_SCOPE_UNRESOLVED;
  }
  if (scope.kind === "global") {
    process.stderr.write(FULL_TIER_LINE);
    return EXIT_FULL_TIER_DECLINED;
  }
  return runFilesScope(root, scope, deps);
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exitCode = runAffectedTests(process.argv.slice(2));
}
