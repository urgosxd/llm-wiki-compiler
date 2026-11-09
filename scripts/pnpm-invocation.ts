/**
 * @file Resolve pnpm by executing it, never by trusting its name.
 *
 * ## Why this exists
 *
 * Two gates in this repository used to spawn the bare program name `pnpm`:
 * `scripts/run-affected-tests.ts` (the `test:affected` gate) and
 * `.husky/pre-commit` (`fallow:ci`, `tsc --noEmit`). Assuming one name resolves
 * to one working pnpm is what made both of them silently blind here: the global
 * launcher on this machine is a shell wrapper whose `exec` target was deleted, so
 * `command -v pnpm` succeeds and `pnpm --version` exits 127. Every affected-test
 * run was red for every branch regardless of the change, and commits required a
 * hand-built PATH shim — which is the first step towards `--no-verify`.
 *
 * It is not only a broken install that breaks the assumption. On CI a bare
 * `pnpm` works because `pnpm/action-setup` put it on PATH; a corepack-managed
 * pnpm, a standalone install, a version manager, and a stale shim all answer the
 * same name differently.
 *
 * ## The rule
 *
 * A candidate counts as a pnpm only when it EXITS 0 from `<command> <args>
 * --version`. A `which`-style lookup is exactly the check that failed, so no
 * candidate is trusted for existing: each is probed by running it.
 *
 * ## The order, and why each slot is where it is
 *
 * 1. `npm_execpath` — when the caller is itself a pnpm lifecycle script, this is
 *    the pnpm that started it, so a nested invocation uses the same one. It is
 *    spawned as `node <npm_execpath>` so it does not depend on the script's exec
 *    bit or on any shell wrapper in front of it. Skipped, and therefore not
 *    reported as tried, when the variable is unset or does not name pnpm.
 * 2. `corepack pnpm` — Node's own pnpm launcher, which is what a developer
 *    machine is expected to have and what `corepack enable pnpm` fixes.
 * 3. `node_modules/.bin/pnpm` — a workspace-local install, independent of PATH.
 * 4. `pnpm` — the bare name, kept last as the conventional fallback.
 *
 * ## Failure is loud
 *
 * {@link resolvePnpm} returns the message built by {@link describeFailure}, which
 * names every candidate tried and the failure each one produced, plus one
 * actionable line. Silence plus a generic 127 is how this stayed invisible.
 *
 * ## Two consumers, one file
 *
 * House convention is `.ts` scripts run by bare `node` on Node's type stripping,
 * so this file serves both without a build step: the hook and
 * `run-affected-tests.ts` each take the resolved command and args and spawn
 * them, and the command line below (`node scripts/pnpm-invocation.ts <args…>`)
 * spawns `<command> <args> <args…>` with inherited stdio from the caller's cwd.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { isEntryPoint } from "./cli-root.ts";

/** One way to reach pnpm: the program to start, the args that select it, its label. */
export interface PnpmCandidate {
  /** Executable to start. */
  command: string;
  /** Arguments that come BEFORE the caller's own arguments. */
  args: readonly string[];
  /** Human name used in messages, one per defined slot. */
  label: string;
  /** 1-based slot in the defined order; a skipped candidate leaves a gap. */
  rank: number;
}

/** A candidate that was probed and rejected, with the failure that was observed. */
export interface RejectedCandidate {
  label: string;
  reason: string;
}

/** The first candidate whose `--version` exited 0. */
export interface PnpmResolved {
  ok: true;
  invocation: PnpmCandidate;
  /** True when the answer is past candidate 1, which the caller may want to report. */
  fellBack: boolean;
}

/** Nothing answered, so the caller has a message to print and no command to run. */
export interface PnpmUnresolved {
  ok: false;
  message: string;
}

/** Discriminated result of {@link resolvePnpm}. */
export type PnpmResolution = PnpmResolved | PnpmUnresolved;

/** Options for {@link buildPnpmCandidates}; the defaults are the runtime values. */
export interface CandidateOptions {
  /** Repository root: base for the workspace-local candidate. */
  root: string;
  /** Defaults to `process.env.npm_execpath`. */
  npmExecPath?: string;
  /** Defaults to `process.execPath`. */
  execPath?: string;
}

/** The probe: a candidate is working only when this exits 0. */
const PROBE_ARGS: readonly string[] = ["--version"];

/** Basenames that mean "this `npm_execpath` is pnpm", compared lower-cased. */
const PNPM_SCRIPT_BASENAMES: readonly string[] = ["pnpm", "pnpm.cjs", "pnpm.mjs", "pnpm.js"];

/** Longest stderr detail quoted in a reason, so one failure stays one line. */
const DETAIL_LIMIT = 120;

/** Actionable closing line: a failure message must leave the reader a next step. */
const REMEDY = "Install pnpm (e.g. `corepack enable pnpm`) or fix the pnpm on PATH.";

/**
 * True when a path names a pnpm script rather than another package manager.
 * @param value - A path, typically `process.env.npm_execpath`.
 */
function isPnpmScriptPath(value: string): boolean {
  return PNPM_SCRIPT_BASENAMES.includes(path.basename(value).toLowerCase());
}

/**
 * The pnpm a workspace-local install exposes.
 * @param root - Repository root.
 */
function localPnpm(root: string): PnpmCandidate {
  return {
    command: path.join(root, "node_modules", ".bin", "pnpm"),
    args: [],
    label: "node_modules/.bin/pnpm",
    rank: 3,
  };
}

/**
 * Build the candidate list in the defined order.
 *
 * Exported so the order is assertable without spawning anything: it is the
 * contract the gates depend on, not an implementation detail.
 * @param options - Root plus optional overrides of the ambient environment.
 * @returns Candidates in the order they are tried.
 */
export function buildPnpmCandidates(options: CandidateOptions): PnpmCandidate[] {
  const { root, npmExecPath = process.env.npm_execpath, execPath = process.execPath } = options;
  const candidates: PnpmCandidate[] = [];
  if (npmExecPath !== undefined && isPnpmScriptPath(npmExecPath)) {
    candidates.push({ command: execPath, args: [npmExecPath], label: `npm_execpath (${npmExecPath})`, rank: 1 });
  }
  candidates.push({ command: "corepack", args: ["pnpm"], label: "corepack pnpm", rank: 2 });
  candidates.push(localPnpm(root), { command: "pnpm", args: [], label: "pnpm", rank: 4 });
  return candidates;
}

/**
 * The one line of a failing probe worth quoting.
 * @param stderr - Captured stderr of the probe.
 */
function firstStderrLine(stderr: string): string {
  const line = stderr.split("\n").map((entry) => entry.trim()).find((entry) => entry !== "") ?? "";
  return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT)}…` : line;
}

/**
 * The reason a failed spawn gives, preferring the errno code over its prose.
 * @param error - `error` from a failed `spawnSync`.
 */
function failureCode(error: Error): string {
  return (error as NodeJS.ErrnoException).code ?? error.message;
}

/**
 * Probe one candidate by executing it.
 * @param candidate - Candidate to run.
 * @param root - Working directory for the probe.
 * @returns null when it answered `--version` with exit 0, otherwise the reason it did not.
 */
function probeCandidate(candidate: PnpmCandidate, root: string): string | null {
  const result = spawnSync(candidate.command, [...candidate.args, ...PROBE_ARGS], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) return `not found (${failureCode(result.error)})`;
  if (result.status === 0) return null;
  if (result.status === null) return `killed by ${result.signal ?? "an unknown signal"}`;
  const detail = firstStderrLine(result.stderr);
  return detail === "" ? `exited ${result.status}` : `exited ${result.status} — ${detail}`;
}

/**
 * Format the total-failure message: every candidate tried, why each failed, and
 * what to do about it.
 * @param rejected - Candidates in the order they were tried.
 */
export function describeFailure(rejected: readonly RejectedCandidate[]): string {
  const lines = rejected.map((entry, index) => `  ${index + 1}. ${entry.label} — ${entry.reason}`);
  const header = `pnpm-invocation: no working pnpm found (tried ${rejected.length} candidates):`;
  return [header, ...lines, REMEDY].join("\n") + "\n";
}

/**
 * Resolve pnpm by probing the candidates in order and taking the first that runs.
 * @param root - Repository root: the probe's cwd and the workspace-local base.
 */
export function resolvePnpm(root: string): PnpmResolution {
  const rejected: RejectedCandidate[] = [];
  for (const candidate of buildPnpmCandidates({ root })) {
    const reason = probeCandidate(candidate, root);
    if (reason === null) return { ok: true, invocation: candidate, fellBack: candidate.rank > 1 };
    rejected.push({ label: candidate.label, reason });
  }
  return { ok: false, message: describeFailure(rejected) };
}

/**
 * Command entry: resolve pnpm, then hand the rest of argv to it.
 *
 * A doomed spawn is never attempted: an unresolved probe has already proven that
 * the bare name exits non-zero, so the message is printed instead.
 * @param argv - Arguments after the script path, passed to pnpm verbatim.
 * @returns The child's exit status, or 1 when pnpm could not be resolved or started.
 */
function main(argv: readonly string[]): number {
  const cwd = process.cwd();
  const resolution = resolvePnpm(cwd);
  if (!resolution.ok) {
    process.stderr.write(resolution.message);
    return 1;
  }
  const { command, args, label } = resolution.invocation;
  const child = spawnSync(command, [...args, ...argv], { cwd, env: process.env, stdio: "inherit" });
  if (child.error) {
    process.stderr.write(`pnpm-invocation: could not start ${label} — ${child.error.message}\n`);
    return 1;
  }
  return child.status ?? 1;
}

if (isEntryPoint(process.argv[1], import.meta.url)) process.exitCode = main(process.argv.slice(2));
