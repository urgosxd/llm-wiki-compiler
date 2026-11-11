/**
 * @file Pin, by running it, WHICH checker `@repo/kg`'s package `typecheck` task runs.
 *
 * ## Why this file exists
 *
 * `@repo/kg#typecheck` and the root gate `typecheck:kg` are the same command today:
 * `scripts/package-tasks-runners.ts` routes that one package name to
 * `scripts/kg-typecheck.ts` — the two-direction ratchet — and every other package to a
 * generated tsconfig plus `tsc`. That equivalence is the whole point of
 * `odd/tasks/kg-task-parity.md` (S3-S4): a package task that is not its gate is a green
 * that answered a different question, the defect class this repository spent a week
 * removing.
 *
 * The equivalence was real and UNPINNED. Nothing ran the CLI and reported which checker
 * answered, so an edit that sent `@repo/kg` back to the weaker `tsc` lookalike would keep
 * every gate green while the package task stopped being the gate. These two tests are
 * that pin.
 *
 * ## Why the pin is behaviour, never source text
 *
 * The tempting pin — read `scripts/package-tasks-runners.ts` and assert that some line
 * mentions the ratchet — is the brittle shape this slice exists to avoid (S14). It
 * matches TEXT while the BEHAVIOUR drifts: a comment could satisfy it, a rename could
 * break it without any routing change, and a genuine re-route that restated the spawn
 * could still pass it by spelling the same filename. So nothing here reads any script's
 * source. The only evidence is the exit status and printed output of a spawned CLI.
 *
 * ## The observable that separates the two branches
 *
 * The ratchet prints one summary sentence of its own, and `tsc` never does:
 * `KG package type-check: <N> files checked; <M> diagnostics baselined across <K> entries
 * in packages/llmwiki-kg/ts/tsconfig.json; no regression.` Only the stable literal
 * fragments are asserted — the leading `KG package type-check:`, the trailing
 * `no regression.`, and the configuration the run pinned — because the counts measure
 * today's tree: a test that froze them would go red for adding a source file rather than
 * for the routing change it guards.
 *
 * ## The second test is what makes the first worth having
 *
 * A test asserting only "the banner appears for `@repo/kg`" would still pass if the
 * banner were ever emitted unconditionally, or if the CLI printed both branches' output.
 * So {@link NON_KG_PACKAGE} — measured as the cheapest non-KG surface that derives a
 * non-empty selection, because an empty one makes the CLI exit 1 and proves nothing about
 * routing — goes through the SAME invocation, and its output is asserted to carry no
 * banner. This is the idiom the project already applies to a guard that has to be shown
 * to bite (`test/package-selection-union.test.ts`, "proves the coverage guard bites"): the
 * discriminating case is part of the guard, not an optional extra.
 *
 * ## What is deliberately NOT asserted
 *
 * `stderr` is asserted nowhere. `deriveSelection` legitimately writes an
 * unattributed-tests note there whenever the partition has an uncovered test, so pinning
 * that stream empty would couple a routing guard to the orphan ratchet that owns that
 * question.
 *
 * ## Cost, and why the timeout is only a hang guard
 *
 * Both cases derive the package's test selection over the whole collected suite (823 test
 * files at this commit) and then type-check, so each takes seconds rather than
 * milliseconds: measured 10.9 s for `@repo/kg` and 7.6 s for `@repo/foundation` on an idle
 * host. {@link SPAWN_TIMEOUT_MS} is therefore not a timing assertion and states no budget
 * for how fast this should be; it exists so a wedged child fails the run instead of
 * stalling the suite.
 *
 * ## Why it imports one repository module
 *
 * {@link PACKAGE_SURFACES} is read so the contrast package is tied to the declaration
 * instead of to a hand-copied string: an undeclared name would make the CLI exit 1 with
 * `unknown package`, which is a different failure from the routing change these tests
 * guard. It also keeps this file in the `meta` bucket of the union guard
 * (`test/package-selection-union.test.ts`) instead of adding an orphan to a frozen ratchet
 * this change must not widen.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { PACKAGE_SURFACES } from "../scripts/package-selection.js";

/** Absolute repository root, from this test file's location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The CLI entry, relative because the child's `cwd` is the repository root. */
const CLI_SCRIPT = path.join("scripts", "package-tasks.ts");

/** The one package whose `typecheck` surface IS the two-direction ratchet. */
const KG_PACKAGE = "@repo/kg";

/**
 * The contrast package: a surface that takes the generated-tsconfig branch.
 *
 * MEASURED as the cheapest of the three non-KG surfaces on an idle host —
 * `@repo/foundation` 7.6 s, `@repo/api` 10.7 s, and `@repo/wiki` is the largest of the
 * three — with a non-empty derived selection and a clean `tsc` run, which is what an
 * exit-0 contrast case needs. Any of them answers this question; the cheapest keeps the
 * guard's cost down.
 */
const NON_KG_PACKAGE = "@repo/foundation";

/** Leading fragment of the ratchet's summary sentence: no `tsc` run can print it. */
const RATCHET_BANNER_PREFIX = "KG package type-check:";

/** Trailing fragment of the same sentence, so a truncated one cannot satisfy Test 1. */
const RATCHET_CLEAN_SUFFIX = "no regression.";

/** The configuration the successful run pinned, named inside the same sentence. */
const RATCHET_CONFIG_FILE = "packages/llmwiki-kg/ts/tsconfig.json";

/** Hang guard only: a wedged child must fail the run, not stall the suite. */
const SPAWN_TIMEOUT_MS = 300_000;

/** One invocation's observable result. */
interface CliRun {
  /** Exit status, or null when the child could not be started. */
  readonly status: number | null;
  /** Everything the command printed on stdout. */
  readonly stdout: string;
  /** Everything the command printed on stderr; never asserted, see the file header. */
  readonly stderr: string;
}

/**
 * Run the CLI's `typecheck` task for one package, exactly as that package's script does.
 *
 * `process.execPath` plus the script path means no shell and no exec bit; `cwd` is the
 * repository root because the CLI resolves its own root from the script's location and
 * every child it spawns must run there.
 *
 * @param packageName - A declared package surface name.
 * @returns The exit status and both streams.
 */
function runTypecheckFor(packageName: string): CliRun {
  const args = [CLI_SCRIPT, "typecheck", "--package", packageName];
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

it(
  "runs the KG ratchet for @repo/kg's typecheck task, observed by its own success sentence",
  { timeout: SPAWN_TIMEOUT_MS },
  () => {
    const run = runTypecheckFor(KG_PACKAGE);
    expect(run.status, `package-tasks typecheck for ${KG_PACKAGE} printed:\n${run.stdout}`).toBe(0);
    expect(run.stdout).toContain(RATCHET_BANNER_PREFIX);
    expect(run.stdout).toContain(RATCHET_CLEAN_SUFFIX);
    expect(run.stdout).toContain(`in ${RATCHET_CONFIG_FILE};`);
  },
);

it(
  "prints no ratchet sentence for a non-KG package, so the assertion above discriminates",
  { timeout: SPAWN_TIMEOUT_MS },
  () => {
    // An undeclared name would exit 1 with `unknown package`, which looks like the
    // routing change this file guards; the name must be a real surface for the
    // contrast to mean anything.
    expect(PACKAGE_SURFACES.map((surface) => surface.name)).toContain(NON_KG_PACKAGE);
    const run = runTypecheckFor(NON_KG_PACKAGE);
    expect(run.status, `package-tasks typecheck for ${NON_KG_PACKAGE} printed:\n${run.stdout}`).toBe(0);
    // The generated-tsconfig branch runs `tsc`, which prints nothing on a clean tree.
    // Were that sentence ever emitted unconditionally, Test 1 would pass for every
    // package and pin nothing.
    expect(run.stdout).not.toContain(RATCHET_BANNER_PREFIX);
  },
);
