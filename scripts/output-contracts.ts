/**
 * @file Plan the vitest invocations for an affected-test scope.
 *
 * `scripts/test-affected.ts` decides WHICH tier to run and
 * `scripts/run-affected-tests.ts` executes that decision. This module is the
 * pure seam in between: it turns a resolved scope plus the unit tier's file list
 * into the exact set of `npx vitest …` invocations, so the selection can be
 * asserted in a test without spawning anything.
 *
 * Output contracts are added here rather than in the tier selection.
 */

import type { AffectedScope } from "./test-affected.ts";

/**
 * Tests whose whole point is a BYTE-LEVEL contract on the spawned CLI's stdout
 * and stderr. They are always run, on top of whatever tier the scope selects.
 *
 * WHY A SEPARATE LIST. `scripts/test-partition.ts` classifies these files
 * `integration` because they spawn `node dist/cli.js`, and the affected runner
 * only runs the spawn-free unit tier on a global change — so without this list
 * such a file is unreachable from `npm run test:affected` by construction and
 * can only go green when somebody runs it by hand. That is exactly how
 * `test/quickstart-json-stdout.test.ts` regressed invisibly: it pins that
 * `--json` stdout stays one envelope while the warning goes to stderr, and any
 * change to CLI option handling or Stack resolution can break it silently.
 * The unit tier cannot hold it, because a real spawned process is the only
 * thing that produces those bytes.
 *
 * HOW TO ADD A FILE (the list is deliberately minimal — one costly spawn per
 * entry on every affected run):
 *
 *   1. The assertion must be a byte-level stdout/stderr contract of a spawned
 *      CLI, i.e. something no in-process unit test can produce.
 *   2. It must be a contract a plausible change (option parsing, Stack
 *      resolution, output formatting) can break while every other gate stays
 *      green.
 *   3. If a spawn-free assertion can pin the same contract, add it to the unit
 *      tier instead and do NOT list the file here.
 *
 * The list is exact, repository-relative paths. A missing or misspelled entry
 * fails the run closed: vitest is handed the path explicitly and errors on it.
 */
export const OUTPUT_CONTRACT_TESTS: readonly string[] = [
  "test/quickstart-json-stdout.test.ts",
];

/** One `npx vitest …` invocation, as argv after the `vitest` binary. */
export interface VitestInvocation {
  /** Arguments after the binary, e.g. `["run", "test/a.test.ts"]`. */
  argv: string[];
  /** Output-contract files this invocation ADDS to the selected tier. */
  addedContracts: string[];
}

/**
 * Append every output-contract file the selection does not already hold.
 *
 * De-duplication is by exact path, so a contract the tier already selected is
 * not passed twice: vitest would otherwise run that file twice and pay the
 * spawn cost twice for the same result.
 *
 * @param selected - Files the tier selection chose, in their order.
 * @returns The merged list, plus the contracts this merge had to add.
 */
function mergeOutputContracts(selected: readonly string[]): { files: string[]; added: string[] } {
  const present = new Set(selected);
  const added = OUTPUT_CONTRACT_TESTS.filter((file) => !present.has(file));
  return { files: [...selected, ...added], added };
}

/** `--exclude=<glob>` for one contract file, so a `related` run cannot double-run it. */
function excludeFlag(file: string): string {
  return `--exclude=${file}`;
}

/**
 * Compute the invocations an affected run must make for `scope`.
 *
 * A `global` scope runs one invocation: the whole unit tier plus any contract
 * file the tier did not already contain. A `files` scope runs two, because
 * `vitest related` takes SOURCE filters, not extra test files — there is no way
 * to hand it a test to run unconditionally. So the `related` invocation is told
 * to exclude the contract files (a related hit must not run them a second time)
 * and a second `run` invocation executes them explicitly. Either way every
 * contract file runs exactly once per scope.
 *
 * @param scope - The tier decision from `scripts/test-affected.ts`.
 * @param unitFiles - Unit tier file list; only read for a `global` scope.
 * @returns Zero or more invocations, in the order they should run.
 */
export function planAffectedInvocations(
  scope: AffectedScope,
  unitFiles: readonly string[],
): VitestInvocation[] {
  // An `unresolved` scope plans nothing: the change set was never computed, so
  // there is nothing to plan. The branch is behaviour-neutral rather than dead:
  // `scripts/run-affected-tests.ts` exits with its own status (69) before
  // planning, so production never reaches here with `unresolved` — the case
  // exists so the union stays exhaustive and no member can fall through into the
  // `files` path and plan a `related` run for a computation that never happened.
  if (scope.kind === "none" || scope.kind === "unresolved") return [];
  if (scope.kind === "global") {
    const { files, added } = mergeOutputContracts(unitFiles);
    return [{ argv: ["run", ...files], addedContracts: added }];
  }
  // `related` sets `passWithNoTests`, so an all-excluded selection still exits 0.
  const related: VitestInvocation = {
    argv: ["related", ...OUTPUT_CONTRACT_TESTS.map(excludeFlag), ...scope.files],
    addedContracts: [],
  };
  if (OUTPUT_CONTRACT_TESTS.length === 0) return [related];
  return [
    related,
    { argv: ["run", ...OUTPUT_CONTRACT_TESTS], addedContracts: [...OUTPUT_CONTRACT_TESTS] },
  ];
}
