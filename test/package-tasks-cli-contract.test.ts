/**
 * @file Pin the package-task CLI contract at its user-facing interface.
 *
 * ## Why this file exists
 *
 * `scripts/package-tasks.ts` is the only way a developer, or a package's own
 * script, reaches a package task surface. For a bad invocation its argument errors
 * ARE the contract: which task names exist, which packages have a surface, and what
 * a package without a fallow baseline reports. Independent verification measured
 * those four answers by hand; nothing committed pinned them, so a rewrite of the
 * `TASKS` or `PACKAGE_SURFACES` tables could have silently changed the surface the
 * CLI advertises while every gate stayed green.
 *
 * The second reason is S10: `@atomicstrata/llmwiki-core` is transitional and must
 * have no task surface. `test/package-task-selection.test.ts` pins that as
 * manifest data — no `test`/`lint`/`typecheck`/`fallow` script — and the assertion
 * below pins the same boundary where a human actually meets it, in the rejection
 * message the CLI prints, naming the four packages it does accept.
 *
 * ## Every invocation here is an instant path, by construction
 *
 * No case below derives a selection, spawns vitest, type-checks, lints or scans
 * anything: three are argument errors that exit before the first child process, and
 * the fourth is the stated fallow absence, which returns before the derivation
 * precisely because a package with no baseline has nothing to scan. So this file
 * costs one process start per case and cannot be a slow or flaky test. The
 * assertions check exit codes AND message substrings, because an exit-code-only
 * assertion would still pass if the message regressed to an empty string.
 *
 * ## The one repository import, and why it is not `node:`-only
 *
 * {@link PACKAGE_SURFACES} is read so the advertised accept-list is tied to the
 * declaration instead of to a hand-copied pair of strings: the frozen sentences
 * pin the exact wording, and the join of the declared surface names pins that the
 * wording still describes the real list. It also keeps this file in the `meta`
 * bucket of the union guard (`test/package-selection-union.test.ts`) rather than
 * adding a thirtieth orphan to a frozen ratchet that this change must not widen.
 *
 * ## The three rejections share one helper, deliberately
 *
 * All three rejected invocations must prove the SAME four things — exit 1, the
 * expected sentence, the usage line, and no stdout — so they go through
 * {@link expectRejection} instead of repeating the block. The first draft spelled
 * the block out three times and `fallow:ci` failed it as one 11-line clone group,
 * which is the gate working as intended: three copies of one assertion drift apart.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { PACKAGE_SURFACES } from "../scripts/package-selection.js";

/** Absolute repository root, from this test file's location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The accepted task names, in the order `scripts/package-tasks.ts` lists them. */
const TASKS = "test, lint, typecheck, fallow";

/** The accepted package names, in the order `scripts/package-tasks.ts` lists them. */
const PACKAGES = "@repo/foundation, @repo/wiki, @repo/kg, @repo/api";

/** The usage line every argument error carries, so a caller learns the shape. */
const USAGE =
  "usage: node scripts/package-tasks.ts <test|lint|typecheck|fallow> --package <@repo/name>";

/** One invocation's observable result. */
interface CliRun {
  /** Exit status, or null when the child could not be started. */
  readonly status: number | null;
  /** Everything the command printed on stdout. */
  readonly stdout: string;
  /** Everything the command printed on stderr. */
  readonly stderr: string;
}

/**
 * Run the CLI once, exactly as a package script would.
 *
 * `process.execPath` plus the script path means no shell, no exec bit and no
 * reliance on the working directory: `cwd` is the repository root because the CLI
 * resolves its own root from the script's location and every child must run there.
 *
 * @param args - Arguments after the script path.
 * @returns The exit status and both streams.
 */
function runCli(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ["scripts/package-tasks.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Assert a rejected invocation: exit 1, the expected sentence, and nothing run.
 *
 * A rejected task must not report a fallow absence, a lint summary or a test
 * selection, so any stdout at all would be a task that ran despite the error.
 *
 * @param args - Arguments after the script path.
 * @param message - The sentence the rejection must carry; the usage line is
 * checked separately because every argument error carries it.
 */
function expectRejection(args: readonly string[], message: string): void {
  const run = runCli(args);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(message);
  expect(run.stderr).toContain(USAGE);
  expect(run.stdout).toBe("");
}

it("rejects an unknown task, naming the four accepted tasks", () => {
  expectRejection(["bogus", "--package", "@repo/wiki"], `unknown task: bogus; expected one of ${TASKS}`);
});

it("rejects the transitional core package, naming the four accepted packages", () => {
  expectRejection(
    ["test", "--package", "@atomicstrata/llmwiki-core"],
    `unknown package: @atomicstrata/llmwiki-core; expected one of ${PACKAGES}`,
  );
});

it("advertises exactly the package surfaces the selection module declares", () => {
  expect(PACKAGE_SURFACES.map((surface) => surface.name).join(", ")).toBe(PACKAGES);
});

it("states the absence of a fallow surface for a package with no baseline", () => {
  const run = runCli(["fallow", "--package", "@repo/wiki"]);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("no fallow surface: no baseline for @repo/wiki");
  expect(run.stdout).toContain("the whole-repo gate is `pnpm run fallow:ci`");
  expect(run.stderr).toBe("");
});

it("rejects a missing --package selection, naming the accepted packages", () => {
  // MEASURED DISTINCTION, left as a comment rather than an assertion: a DANGLING
  // `--package` with no value never reaches this code — `node:util`'s `parseArgs`
  // rejects it first with `Option '--package <value>' argument missing`, which
  // exits 1 and names no package. That is Node's message, not this repository's
  // contract, so only the case this module owns is pinned here.
  expectRejection(["test"], `unknown package: (none); expected one of ${PACKAGES}`);
});
