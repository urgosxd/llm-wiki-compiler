/**
 * @file Shared repository-root resolution for the test-scope scripts.
 *
 * `test-partition.ts` and `run-affected-tests.ts` both accept `--root` and both
 * fall back to the working directory. They had identical copies of that logic,
 * which is one definition of "where the repo is" too many: they must agree, or
 * one would classify files in the repo while the other ran tests somewhere else.
 */

import path from "node:path";

/**
 * Resolve the repository root from a `--root <dir>` flag.
 * @param argv - Arguments to scan (the flag and its value are the last two when present).
 * @returns The resolved absolute root, or the current working directory.
 */
export function readRoot(argv: readonly string[]): string {
  const flag = argv.indexOf("--root");
  return flag === -1 ? process.cwd() : path.resolve(argv[flag + 1] ?? process.cwd());
}

/**
 * True when this module is the process entry point rather than an import.
 * @param entry - `process.argv[1]`; may be undefined under some runners.
 * @param moduleUrl - The caller's `import.meta.url`.
 */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  return Boolean(entry) && moduleUrl === `file://${path.resolve(entry as string)}`;
}
