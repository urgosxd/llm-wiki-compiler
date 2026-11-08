/**
 * @file scripts/kg-typecheck.ts
 * @description Command entry for the KG package type-check ratchet.
 *
 * ## The blind spot this closes
 *
 * `packages/llmwiki-kg/ts` carries its own `tsconfig.json`, and nothing read it:
 * root `tsc` includes only `src/**`, `.fallowrc.json` ignores the package, and
 * the package's own `typecheck`/`build` scripts were invoked by no gate. It
 * therefore accumulated diagnostics that no reviewer, no CI run and no local
 * command could see — the defect this script exists to fix, and the reason
 * widening an ignore list is explicitly NOT the fix.
 *
 * ## Why a baseline instead of a clean tree
 *
 * The honest sequence is "make it visible, then drain it", not "hide it until it
 * is perfect". The diagnostics the configuration already had are pinned in
 * `kg-typecheck-baseline.json` by file and TypeScript code, so they are visible
 * without blocking every unrelated change. Two directions are both errors:
 *
 * - a diagnostic that is NOT in the baseline fails the gate (a new mistake);
 * - a diagnostic that is IN the baseline but no longer occurs also fails, so an
 *   allowance cannot linger as slack for the next one.
 *
 * Both point at `pnpm run typecheck:kg:update`, which only ever rewrites the
 * baseline downward — the update path rejects an increase, exactly as a normal
 * run does.
 *
 * ## Keys carry the code, never the line
 *
 * A file that gains a line must not invalidate its allowances, so a key is
 * `<relative path> TS<code>`. The line is still named in the failure text,
 * because that is what a reader needs to open the file.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { parseRatchetBaseline } from "./ratchet-baseline.ts";
import type { RatchetBaseline } from "./ratchet-baseline.ts";

/** Baseline file, relative to the repository root the command runs in. */
const BASELINE_FILE = "kg-typecheck-baseline.json";

/** The configuration this ratchet pins; the same one `pnpm exec tsc -p` is run on. */
const CONFIG_FILE = "packages/llmwiki-kg/ts/tsconfig.json";

/** The one command that may change the baseline, quoted in every failure. */
export const REFRESH_COMMAND = "pnpm run typecheck:kg:update";

/** One error diagnostic, reduced to the fields a reader and the baseline need. */
export interface KgDiagnostic {
  /** Repository-relative, POSIX-separated path. */
  file: string;
  /** 1-based line, named in failures and deliberately absent from keys. */
  line: number;
  /** TypeScript error code, e.g. 6133. */
  code: number;
  message: string;
}

/** Stored baseline; `counts` is the whole allowance, in the shared document shape. */
export type KgBaseline = RatchetBaseline;

/** Stable baseline key: the file plus the diagnostic code. */
export function diagnosticKey(diagnostic: KgDiagnostic): string {
  return `${diagnostic.file} TS${String(diagnostic.code)}`;
}

/** Count diagnostics per key, so one key never borrows another's allowance. */
function countKgDiagnostics(diagnostics: readonly KgDiagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

/** The diagnostics a key has beyond what the baseline allows, in line order. */
function excessFor(
  diagnostics: readonly KgDiagnostic[],
  key: string,
  allowed: number,
): KgDiagnostic[] {
  return diagnostics
    .filter((diagnostic) => diagnosticKey(diagnostic) === key)
    .sort((left, right) => left.line - right.line)
    .slice(allowed);
}

/**
 * Compare a diagnostic set against its baseline.
 *
 * @param actual - Diagnostics this run produced.
 * @param baseline - Allowed counts, keyed by {@link diagnosticKey}.
 * @param allowDecrease - Set while updating: a lower count is the intent, not a fault.
 * @returns Human-readable failures; an empty list means the gate passes.
 */
export function compareKgDiagnostics(
  actual: readonly KgDiagnostic[],
  baseline: Record<string, number>,
  allowDecrease = false,
): string[] {
  const counts = countKgDiagnostics(actual);
  const keys = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  const errors: string[] = [];
  for (const key of keys) {
    const current = counts[key] ?? 0;
    const allowed = baseline[key] ?? 0;
    if (current > allowed) {
      for (const diagnostic of excessFor(actual, key, allowed)) {
        errors.push(
          `${diagnostic.file}:${String(diagnostic.line)} TS${String(diagnostic.code)} ` +
            `${diagnostic.message} (${key}: ${String(current)} exceeds baseline ${String(allowed)}); ` +
            `if this is deliberate, refresh with ${REFRESH_COMMAND}`,
        );
      }
    } else if (current < allowed && !allowDecrease) {
      errors.push(
        `${key}: diagnostics decreased from ${String(allowed)} to ${String(current)}; ` +
          `drop the allowance with ${REFRESH_COMMAND}`,
      );
    }
  }
  return errors;
}

/** Stable repository-relative paths in diagnostic output and metadata. */
function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** A configuration error cannot be baselined per file, so it fails loudly. */
function rejectConfigErrors(diagnostics: readonly ts.Diagnostic[], root: string): void {
  if (!diagnostics.length) return;
  throw new Error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}

/** Pin effective options and selection without embedding checkout paths. */
function configurationDigest(root: string, config: ts.ParsedCommandLine): string {
  const value = { options: config.options, include: config.raw.include, exclude: config.raw.exclude };
  const serialized = JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" && path.isAbsolute(entry) ? relativeFile(root, entry) : entry,
  );
  return createHash("sha256").update(serialized).digest("hex");
}

/** Load the package configuration exactly as `tsc -p <config> --noEmit` would. */
function readConfig(root: string): ts.ParsedCommandLine {
  const file = path.join(root, CONFIG_FILE);
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error) rejectConfigErrors([loaded.error], root);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(file), undefined, file);
  rejectConfigErrors(config.errors, root);
  if (!config.fileNames.length) throw new Error(`No files selected by ${CONFIG_FILE}`);
  return config;
}

/** Turn one TypeScript diagnostic into the reduced, baseline-friendly shape. */
function toKgDiagnostic(root: string, diagnostic: ts.Diagnostic): KgDiagnostic {
  const source = diagnostic.file as ts.SourceFile;
  const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  return {
    file: relativeFile(root, source.fileName),
    line: line + 1,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  };
}

/**
 * Type-check the KG package without emitting anything.
 *
 * @param root - Repository root the paths in the result are relative to.
 */
export function collectKgDiagnostics(root: string): {
  diagnostics: KgDiagnostic[];
  checkedFiles: string[];
  configuration: string;
} {
  const config = readConfig(root);
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  );
  rejectConfigErrors(diagnostics.filter((entry) => !entry.file), root);
  return {
    diagnostics: diagnostics
      .map((diagnostic) => toKgDiagnostic(root, diagnostic))
      .sort((left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.code - right.code,
      ),
    checkedFiles: config.fileNames.map((file) => relativeFile(root, file)).sort(),
    configuration: configurationDigest(root, config),
  };
}

/** Validate the stored format before treating any value as an allowance. */
function parseBaseline(text: string): KgBaseline {
  return parseRatchetBaseline(text, `Invalid KG package type-check baseline (${BASELINE_FILE})`);
}

/** A metadata change requires an explicit migration, not an automatic allowance update. */
function readCompatibleBaseline(current: KgBaseline, initialize: boolean): KgBaseline {
  const stored = initialize
    ? current
    : parseBaseline(readFileSync(path.join(process.cwd(), BASELINE_FILE), "utf8"));
  if (stored.typescript !== current.typescript || stored.configuration !== current.configuration) {
    throw new Error(
      `TypeScript version or ${CONFIG_FILE} changed; review the diagnostics and regenerate ` +
        `the baseline deliberately with ${REFRESH_COMMAND}`,
    );
  }
  return stored;
}

/** Parse the small CLI surface and keep bootstrap separate from routine reductions. */
function readOptions() {
  const { values } = parseArgs({
    options: { init: { type: "boolean" }, update: { type: "boolean" } },
  });
  if (values.init === true && values.update === true) throw new Error("Choose --init or --update, not both");
  if (values.init === true && existsSync(path.join(process.cwd(), BASELINE_FILE))) {
    throw new Error(`${BASELINE_FILE} already exists; use --update for reductions`);
  }
  return values;
}

/** Compare current diagnostics, update only downward, and summarize the run. */
function main(): void {
  const values = readOptions();
  const root = process.cwd();
  const snapshot = collectKgDiagnostics(root);
  const current: KgBaseline = {
    version: 1,
    typescript: ts.version,
    configuration: snapshot.configuration,
    counts: countKgDiagnostics(snapshot.diagnostics),
  };
  const stored = readCompatibleBaseline(current, values.init === true);
  const errors = compareKgDiagnostics(snapshot.diagnostics, stored.counts, values.update === true);
  if (errors.length) throw new Error(errors.join("\n"));
  if (values.init === true || values.update === true) {
    writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify(current, null, 2)}\n`);
  }
  const baselined = Object.values(current.counts).reduce((sum, count) => sum + count, 0);
  console.log(
    `KG package type-check: ${String(snapshot.checkedFiles.length)} files checked; ` +
      `${String(baselined)} diagnostics baselined across ${String(Object.keys(current.counts).length)} ` +
      `entries in ${CONFIG_FILE}; no regression.`,
  );
}

/** Only the command entry runs the gate; importing this module for its comparison does not. */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
