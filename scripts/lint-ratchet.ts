/**
 * @file scripts/lint-ratchet.ts
 * @description Command entry for the ESLint house-rule ratchet (`npm run lint`).
 *
 * ## Why a ratchet instead of a plain lint run
 *
 * The house rules in `AGENTS.md` — files smaller than 400 lines, functions
 * smaller than 40, no explicit `any`, and the one-way KG dependency boundary —
 * already have violations in this tree. A hard-fail linter would be red on
 * `main` today and would become the next permanently-red gate, which is the rot
 * this control layer exists to fix. So the violations that exist now are frozen
 * in `eslint-baseline.json` by `(file, rule)` and the gate fails on drift only.
 *
 * ## Both directions are errors
 *
 * This mirrors the house precedents, `scripts/typecheck-tests.ts` and
 * `scripts/kg-typecheck.ts`, exactly:
 *
 * - a violation that is NOT in the baseline fails — a new mistake;
 * - a baselined violation that no longer occurs ALSO fails, so an allowance
 *   cannot linger as slack for the next one.
 *
 * Both point at `npm run lint:update`.
 *
 * ## Keys carry the rule, never the line
 *
 * A file that gains a line must not invalidate its allowances, so a key is
 * `<relative path> <rule id>` — the same reason the KG ratchet keys on
 * `<path> TS<code>`. The line is still named in failure text, because that is
 * what a reader needs to open the file.
 *
 * ## `--update` is reduction-only unless the configuration moved
 *
 * A routine fix may only lower counts, exactly as the precedents refuse an
 * increase on `--update`. A change to `eslint.config.mjs` or to a pinned linter
 * version is a migration rather than a routine fix, so that one case rewrites
 * the whole set; it is named in the stored document and reported before it is
 * accepted.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ESLint } from "eslint";
import ts from "typescript";
import { parseRatchetBaseline } from "./ratchet-baseline.ts";
import type { RatchetBaseline } from "./ratchet-baseline.ts";

/** Baseline file, relative to the repository root the command runs in. */
const BASELINE_FILE = "eslint-baseline.json";

/** The configuration whose contents are part of the pinned configuration digest. */
const CONFIG_FILE = "eslint.config.mjs";

/** The one command that may change the baseline, quoted in every failure. */
const REFRESH_COMMAND = "npm run lint:update";

/** The only rule ids this ratchet collects; any other message is ignored. */
const HOUSE_RULES: readonly string[] = [
  "max-lines",
  "max-lines-per-function",
  "@typescript-eslint/no-explicit-any",
  "no-restricted-imports",
];

/**
 * The trees the house rules cover, matching the flat config's `CODE_FILES`.
 *
 * This list must stay in step with `CODE_FILES` in `eslint.config.mjs`, in the
 * same order. The config decides which rules apply to a file; this list decides
 * which files are read at all, and a tree the config exempts but no pattern
 * reaches is never scanned — a zone the ratchet cannot see, so it can neither
 * freeze nor fail on anything in it. That is why `api/**` is named here even
 * though the directory does not exist yet: the moment it does, its files are in
 * scope without anyone remembering to add them.
 */
const LINT_PATTERNS = [
  "src/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/**/*.{ts,tsx,js,mjs,cjs}",
  "test/**/*.{ts,tsx,js,mjs,cjs}",
  "scripts/**/*.{ts,tsx,js,mjs,cjs}",
  "api/**/*.{ts,tsx,js,mjs,cjs}",
];

/** This ratchet's name for the shared stored document. */
type LintBaseline = RatchetBaseline;

/** One collected house-rule violation, reduced to the fields a report needs. */
export interface HouseViolation {
  /** Repository-relative, POSIX-separated path. */
  file: string;
  /** 1-based line, named in failures and deliberately absent from keys. */
  line: number;
  ruleId: string;
  message: string;
}

/** Everything one lint run measures. */
export interface Snapshot {
  violations: HouseViolation[];
  counts: Record<string, number>;
  filesScanned: number;
  configuration: string;
}

/** The parts of an ESLint lint result this ratchet reads. */
interface ResultLike {
  filePath: string;
  messages: readonly { ruleId: string | null; line?: number; message: string }[];
}

/** Stable baseline key: the file plus the rule id. */
export function violationKey(violation: HouseViolation): string {
  return `${violation.file} ${violation.ruleId}`;
}

/** Deterministic string order, independent of the ICU/locale version. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Count violations per key, sorted so the stored document is byte-stable. */
function countViolations(violations: readonly HouseViolation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const violation of violations) {
    const key = violationKey(violation);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
}

/** Stable repository-relative paths in reports and metadata. */
function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Keep the five house rule ids and drop everything else ESLint reports. */
function isHouseRule(ruleId: string | null): boolean {
  return ruleId !== null && HOUSE_RULES.includes(ruleId);
}

/** Reduce one lint result to the house-rule violations it contains. */
function houseViolations(root: string, result: ResultLike): HouseViolation[] {
  return result.messages
    .filter((message) => isHouseRule(message.ruleId))
    .map((message) => ({
      file: relativeFile(root, result.filePath),
      line: message.line ?? 0,
      ruleId: String(message.ruleId),
      message: message.message,
    }));
}

/** File, then line, then rule: the order a reader fixes them in. */
function sortViolations(violations: HouseViolation[]): HouseViolation[] {
  return violations.sort(
    (left, right) =>
      compareText(left.file, right.file) || left.line - right.line || compareText(left.ruleId, right.ruleId),
  );
}

/** A pinned dependency version, read where npm put it; absence is stated, never guessed. */
function installedVersion(root: string, name: string): string {
  const manifest = path.join(root, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return "not-installed";
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "unknown";
}

/**
 * Pin the effective rule set without embedding checkout paths.
 *
 * The config file's own bytes are hashed, so any change to a rule, an option or
 * an ignore list moves the digest and has to be accepted deliberately. The
 * linter versions are pinned exactly in `package.json`; their resolved versions
 * are hashed here for the same reason.
 */
export function configurationDigest(root: string): string {
  const value = {
    config: readFileSync(path.join(root, CONFIG_FILE), "utf8"),
    eslint: installedVersion(root, "eslint"),
    typescriptEslint: installedVersion(root, "typescript-eslint"),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Lint the repository through the ESLint Node API and reduce the result.
 *
 * @param root - Repository root the paths in the result are relative to.
 */
export async function collectSnapshot(root: string): Promise<Snapshot> {
  /*
   * `errorOnUnmatchedPattern` is off because a declared zone may be empty:
   * `api/` does not exist yet, and ESLint treats a pattern that matches no file
   * as an error rather than as an empty set. Turning it off keeps an empty zone
   * from breaking the gate. It does not make a tree silently invisible: a file
   * that appears under any pattern here is scanned and counted, which the probes
   * for each zone check.
   */
  const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([...LINT_PATTERNS]);
  const violations = sortViolations(results.flatMap((result) => houseViolations(root, result)));
  return {
    violations,
    counts: countViolations(violations),
    filesScanned: results.length,
    configuration: configurationDigest(root),
  };
}

/** Every file the stored baseline holds an allowance for. */
function baselinedFiles(baseline: Record<string, number>): Set<string> {
  return new Set(Object.keys(baseline).map((key) => key.slice(0, key.lastIndexOf(" "))));
}

/** The violations of one key beyond what the baseline allows, in line order. */
function excessFor(violations: readonly HouseViolation[], key: string, allowed: number): HouseViolation[] {
  return violations.filter((violation) => violationKey(violation) === key).slice(allowed);
}

/**
 * Say what an excess actually means, without claiming anything about the filesystem.
 *
 * The previous wording called every file absent from the baseline "brand-new", but
 * absence from the baseline is a statement about ALLOWANCES, not about provenance:
 * a key is missing for every file the baseline never recorded a violation of, and
 * that is most of the tracked tree. An engineer who adds an `any` to `src/index.ts`
 * was told their existing file was new and went looking in the wrong place. So the
 * message names the missing allowance instead, and keeps the one distinction a
 * reader can act on: a file the baseline knows, where this is a new violation, or a
 * file it holds nothing for at all.
 */
function classify(violation: HouseViolation, files: Set<string>): string {
  if (files.has(violation.file)) return "new violation in an existing file";
  return `no frozen allowance for ${violation.ruleId} in this file`;
}

/** One failure line, naming the file, line, rule, count and the command that accepts it. */
function excessMessage(
  violation: HouseViolation,
  current: number,
  allowed: number,
  files: Set<string>,
): string {
  return (
    `${violation.file}:${violation.line} ${violation.ruleId} ${violation.message} ` +
    `(${violationKey(violation)}: ${current} exceeds baseline ${allowed}; ${classify(violation, files)}); ` +
    `if this is deliberate, refresh with ${REFRESH_COMMAND}`
  );
}

/** One failure line, naming the allowance that was dropped instead of earned. */
function decreaseMessage(key: string, current: number, allowed: number): string {
  return `${key}: violations decreased from ${allowed} to ${current}; drop the allowance with ${REFRESH_COMMAND}`;
}

/** Both directions for a single key: more than allowed, fewer than allowed, or neither. */
function keyErrors(snapshot: Snapshot, key: string, allowed: number, files: Set<string>): string[] {
  const current = snapshot.counts[key] ?? 0;
  if (current > allowed) {
    return excessFor(snapshot.violations, key, allowed).map((violation) =>
      excessMessage(violation, current, allowed, files),
    );
  }
  if (current < allowed) return [decreaseMessage(key, current, allowed)];
  return [];
}

/** Every key either side knows about, in a fixed order. */
function mergedKeys(counts: Record<string, number>, baseline: Record<string, number>): string[] {
  return [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort(compareText);
}

/** Compare a run against its baseline; an empty list means the gate passes. */
export function compareViolations(
  snapshot: Snapshot,
  baseline: Record<string, number>,
  allowReplace = false,
): string[] {
  if (allowReplace) return [];
  const files = baselinedFiles(baseline);
  return mergedKeys(snapshot.counts, baseline).flatMap((key) => keyErrors(snapshot, key, baseline[key] ?? 0, files));
}

/** Validate the stored format before treating any value as an allowance. */
function readStoredBaseline(root: string): LintBaseline | null {
  const file = path.join(root, BASELINE_FILE);
  if (!existsSync(file)) return null;
  return parseRatchetBaseline(readFileSync(file, "utf8"), `Invalid ESLint baseline (${BASELINE_FILE})`);
}

/** Serialize the stored document identically for every writing mode. */
function writeBaseline(root: string, baseline: LintBaseline): void {
  writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
}

/** The stored document this run would write: the live measurement plus its pins. */
function storedBaseline(snapshot: Snapshot): LintBaseline {
  return { version: 1, typescript: ts.version, configuration: snapshot.configuration, counts: snapshot.counts };
}

/** A configuration or TypeScript change is a migration, not a routine reduction. */
function configurationMoved(stored: LintBaseline | null, snapshot: Snapshot): boolean {
  if (stored === null) return false;
  return stored.typescript !== ts.version || stored.configuration !== snapshot.configuration;
}

/**
 * Refuse a missing baseline: there is nothing to compare against.
 *
 * Freezing the current violations is a deliberate act, so it is named.
 */
function assertBaselinePresent(stored: LintBaseline | null, update: boolean): void {
  if (stored === null && !update) {
    throw new Error(`No ${BASELINE_FILE}; freeze the violations that exist today with ${REFRESH_COMMAND}`);
  }
}

/** Refuse a moved configuration: it would compare this run against rules that no longer exist. */
function assertConfigurationPinned(migrated: boolean, update: boolean): void {
  if (migrated && !update) {
    throw new Error(
      `The pinned linter configuration moved (${CONFIG_FILE} or a linter version); ` +
        `review the run and accept it deliberately with ${REFRESH_COMMAND}`,
    );
  }
}

/** Sum one allowance map so the success line can state the frozen total. */
function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** One line, in the shape the sibling ratchets print, stating the frozen totals. */
function successLine(snapshot: Snapshot): string {
  const entries = Object.keys(snapshot.counts).length;
  const files = new Set(snapshot.violations.map((violation) => violation.file)).size;
  return (
    `ESLint ratchet: ${snapshot.filesScanned} files scanned; ` +
    `${totalCount(snapshot.counts)} baseline violations in ${files} files across ${entries} rule/file entries; ` +
    "no regression."
  );
}

/** Parse the small CLI surface: a plain check, or a baseline rewrite. */
function readOptions(): { update: boolean } {
  const { values } = parseArgs({ options: { update: { type: "boolean" } } });
  return { update: values.update === true };
}

/** A rewrite is allowed only for a first freeze or a configuration migration. */
function acceptsReplace(stored: LintBaseline | null, migrated: boolean, update: boolean): boolean {
  if (!update) return false;
  return stored === null || migrated;
}

/** Fail the gate unless the run matches the stored allowances exactly. */
function assertNoRegression(snapshot: Snapshot, stored: LintBaseline | null, allowReplace: boolean): void {
  const errors = compareViolations(snapshot, stored?.counts ?? {}, allowReplace);
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Compare the live run with the stored allowances, rewriting only when allowed. */
async function main(): Promise<void> {
  const root = process.cwd();
  const update = readOptions().update;
  const snapshot = await collectSnapshot(root);
  const stored = readStoredBaseline(root);
  const migrated = configurationMoved(stored, snapshot);
  assertBaselinePresent(stored, update);
  assertConfigurationPinned(migrated, update);
  assertNoRegression(snapshot, stored, acceptsReplace(stored, migrated, update));
  if (update) writeBaseline(root, storedBaseline(snapshot));
  console.log(successLine(snapshot));
}

/** Only the command entry runs the gate; importing this module for its comparison does not. */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
