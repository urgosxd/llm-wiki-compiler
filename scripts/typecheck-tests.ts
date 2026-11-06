/**
 * @file scripts/typecheck-tests.ts
 * @description Command entry for the public test type-check ratchet.
 *
 * Three modes, deliberately kept separate because they mean different things:
 * - the default run compares live diagnostics with the stored allowances and fails on any upward
 *   count, so a pull request cannot quietly accept a new test type error;
 * - `--update` accepts reductions only and still refuses a TypeScript version or configuration
 *   change, so routine fixes cannot re-anchor the metadata;
 * - `--rebaseline` re-anchors the stored metadata AND the allowances to the live measurement. It is
 *   the reviewable migration for an intentional configuration change or a stale document. Without
 *   `--confirm` it is a dry run that reports the full per-file delta and writes nothing, because a
 *   baseline is an acceptance decision and should be read before it is stored.
 *
 * `--rebaseline` ignores `--base-ref`: the recording is the reviewed live state, and the PR-base
 * ratchet keeps guarding the committed document through the ordinary CI run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import ts from "typescript";
import { parseRatchetBaseline } from "./ratchet-baseline.ts";
import type { RatchetBaseline } from "./ratchet-baseline.ts";
import { collectTestDiagnostics } from "./test-typecheck-program.ts";
import { compareDiagnosticCounts } from "./test-typecheck-ratchet.ts";

const BASELINE_FILE = "test-typecheck-baseline.json";
/** Reported as the old pin when the ratchet has never been anchored in this checkout. */
const NO_STORED_CONFIGURATION = "none (no baseline file)";

/** This ratchet's name for the shared stored document. */
type Baseline = RatchetBaseline;

/** One file whose stored and live diagnostic counts differ in one direction. */
interface CountChange {
  file: string;
  before: number;
  after: number;
}

/** Per-file changes grouped by direction, so a re-baseline can be reviewed before it is stored. */
interface ChangeGroups {
  added: CountChange[];
  removed: CountChange[];
  increased: CountChange[];
  decreased: CountChange[];
}

/** Everything a re-baseline report states; the groups are derived from the two count maps. */
interface RebaselineReport {
  stored: Baseline | null;
  current: Baseline;
  confirmed: boolean;
  groups: ChangeGroups;
}

/** The flags this command accepts, named as the parser reports them. */
interface RatchetOptions {
  init?: boolean;
  update?: boolean;
  rebaseline?: boolean;
  confirm?: boolean;
  "base-ref"?: string;
}

/** Validate the stored format before treating any value as an allowance. */
function parseBaseline(text: string): Baseline {
  return parseRatchetBaseline(text, "Invalid test type-check baseline");
}

/** Read the stored baseline, or null when this ratchet has never been anchored here. */
function readStoredBaseline(): Baseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  return parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
}

/** Serialize the stored document identically for every writing mode. */
function writeBaseline(baseline: Baseline): void {
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
}

/** Read a baseline at a resolved commit; absence is allowed only for first introduction. */
function baselineAt(ref: string): Baseline | null {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!git(["ls-tree", "--name-only", commit, "--", BASELINE_FILE])) return null;
  return parseBaseline(git(["show", `${commit}:${BASELINE_FILE}`]));
}

/** Keep comparison failures readable without a process stack trace. */
function requireNoErrors(errors: string[]): void {
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Parse the small CLI surface and keep bootstrap, reduction and migration modes apart. */
function readOptions() {
  const { values } = parseArgs({ options: {
    init: { type: "boolean" }, update: { type: "boolean" }, rebaseline: { type: "boolean" },
    confirm: { type: "boolean" }, "base-ref": { type: "string" },
  } });
  assertModeChoice(values);
  assertBootstrapAllowed(values.init === true);
  return values;
}

/** Reject flag combinations that would mean two different things at once. */
function assertModeChoice(values: Pick<RatchetOptions, "init" | "update" | "rebaseline" | "confirm">): void {
  if (values.init && values.update) throw new Error("Choose --init or --update, not both");
  if (values.rebaseline && (values.init || values.update)) throw new Error("Choose --rebaseline or a baseline bump, not both");
  if (values.confirm && !values.rebaseline) throw new Error("--confirm requires --rebaseline");
}

/** Bootstrap may create the document; it must never clear a backlog that already exists. */
function assertBootstrapAllowed(initialize: boolean): void {
  if (initialize && existsSync(BASELINE_FILE)) throw new Error("Baseline already exists; use --update for reductions");
}

/** A metadata change requires explicit migration, not an automatic allowance update. */
function readCompatibleBaseline(current: Baseline, initialize: boolean): Baseline {
  const stored = initialize ? current : parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
  if (stored.typescript !== current.typescript || stored.configuration !== current.configuration) {
    throw new Error("TypeScript version or test configuration changed; review and regenerate the baseline explicitly");
  }
  return stored;
}

/** Prevent a PR from editing its baseline upward to conceal a new diagnostic. */
function checkPriorBaseline(stored: Baseline, ref: string | undefined): void {
  if (!ref) return;
  const prior = baselineAt(ref);
  if (prior) requireNoErrors(compareDiagnosticCounts(stored.counts, prior.counts, true));
}

/** Sum one allowance map so a report can state the total before and after. */
function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** Partition every stored and live entry by direction; an absent side counts as zero. */
function groupCountChanges(stored: Record<string, number>, live: Record<string, number>): ChangeGroups {
  const groups: ChangeGroups = { added: [], removed: [], increased: [], decreased: [] };
  for (const file of [...new Set([...Object.keys(stored), ...Object.keys(live)])].sort()) {
    const before = stored[file] ?? 0;
    const after = live[file] ?? 0;
    if (before === after) continue;
    if (before === 0) groups.added.push({ file, before, after });
    else if (after === 0) groups.removed.push({ file, before, after });
    else if (after > before) groups.increased.push({ file, before, after });
    else groups.decreased.push({ file, before, after });
  }
  return groups;
}

/** A stored document that already matches the live measurement; rewriting it would change nothing. */
function isCurrentBaseline(stored: Baseline, current: Baseline): boolean {
  const unchanged = Object.entries(current.counts).every(([file, count]) => stored.counts[file] === count);
  return stored.typescript === current.typescript
    && stored.configuration === current.configuration
    && Object.keys(stored.counts).length === Object.keys(current.counts).length
    && unchanged;
}

/** Keep report counts readable without inventing plural forms at every call site. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Describe one file's shift: a whole count for an added or removed file, an arrow for drift. */
function formatChangeDetail(change: CountChange): string {
  if (change.before === 0) return plural(change.after, "diagnostic");
  if (change.after === 0) return plural(change.before, "diagnostic");
  return `${change.before} -> ${change.after}`;
}

/** One group heading plus one line per file, so a reviewer reads counts instead of a JSON diff. */
function formatChangeGroup(label: string, changes: CountChange[]): string[] {
  return [`${label}: ${plural(changes.length, "file")}`, ...changes.map((change) => `  ${change.file}: ${formatChangeDetail(change)}`)];
}

/** State what happened, because a dry run, a write and a no-op read the same until the last line. */
function formatRebaselineOutcome(confirmed: boolean, alreadyCurrent: boolean): string {
  if (!confirmed) return "Run again with --confirm to write the new baseline.";
  return alreadyCurrent ? "Baseline is already current; nothing written." : `Wrote ${BASELINE_FILE}.`;
}

/** Full re-baseline report: both metadata pins, the four groups, and the total shift. */
function formatRebaselineReport(report: RebaselineReport): string {
  const { stored, current, groups } = report;
  const alreadyCurrent = stored !== null && isCurrentBaseline(stored, current);
  return [
    report.confirmed ? "Test type-check re-baseline (confirmed)" : "Test type-check re-baseline (dry run; nothing written)",
    `Old configuration: ${stored?.configuration ?? NO_STORED_CONFIGURATION}`,
    `New configuration: ${current.configuration}`,
    ...formatChangeGroup("ADDED", groups.added),
    ...formatChangeGroup("REMOVED", groups.removed),
    ...formatChangeGroup("INCREASED", groups.increased),
    ...formatChangeGroup("DECREASED", groups.decreased),
    `Total errors: ${totalCount(stored?.counts ?? {})} -> ${totalCount(current.counts)}`,
    formatRebaselineOutcome(report.confirmed, alreadyCurrent),
  ].join("\n");
}

/** Report the migration, and write the live measurement as the baseline only when confirmed. */
function rebaseline(current: Baseline, confirmed: boolean): void {
  const stored = readStoredBaseline();
  const report: RebaselineReport = { stored, current, confirmed, groups: groupCountChanges(stored?.counts ?? {}, current.counts) };
  console.log(formatRebaselineReport(report));
  if (!confirmed) return;
  if (stored && isCurrentBaseline(stored, current)) return;
  writeBaseline(current);
}

/** Compare current diagnostics, update only downward, re-anchor explicitly, or enforce the PR-base ratchet. */
function main(): void {
  const values = readOptions();
  const snapshot = collectTestDiagnostics(process.cwd());
  const current: Baseline = { version: 1, typescript: ts.version, configuration: snapshot.configuration, counts: snapshot.counts };
  if (values.rebaseline) {
    rebaseline(current, values.confirm === true);
    return;
  }
  const stored = readCompatibleBaseline(current, values.init === true);
  checkPriorBaseline(stored, values["base-ref"]);
  requireNoErrors(compareDiagnosticCounts(current.counts, stored.counts, values.update === true));
  if (values.init || values.update) writeBaseline(current);
  const total = totalCount(current.counts);
  console.log(`Test type-check: ${snapshot.checkedFiles.length} files checked; ${total} baseline diagnostics in ${Object.keys(current.counts).length} files; no regression.`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
