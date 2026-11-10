/**
 * @file Prove the affected-run planner's output-contract mechanism, and prove
 * the list that drives it is honest about the tree it points into.
 *
 * These assertions are pure: no CLI is spawned and nothing is built, so the
 * selection logic is provable in milliseconds.
 *
 * ## Why the mechanism is driven with a SYNTHETIC entry
 *
 * `OUTPUT_CONTRACT_TESTS` is empty, and empty is its correct state: every entry
 * it ever held was a byte-level contract on the CLI's stdout, and the CLI left
 * the product. A test that pinned a real file here — this file used to pin
 * `test/quickstart-json-stdout.test.ts` — rots the moment that file is deleted,
 * which is exactly how this file went red. A test that only read the empty list
 * would prove nothing either: the add, exclude and de-duplicate branches that
 * `scripts/run-affected-tests.ts` still depends on would never run, and the
 * machinery would be uncovered until the day somebody repopulates the list and
 * discovers it is broken. So the mechanism is exercised with a contract file
 * created in a temp directory, and the REAL list is asserted against its own
 * invariant below: every path it names must exist, and an empty list must be a
 * valid, fully supported state rather than a special case.
 *
 * Nothing here re-points the mechanism at a test the repository does not have,
 * and nothing here repopulates the list to make an assertion easier.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTPUT_CONTRACT_TESTS, planAffectedInvocations, type VitestInvocation } from "./output-contracts.ts";
import { classifyTests } from "./test-partition.ts";

/** Repository root, resolved from this file's location so the walk is cwd-independent. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const UNIT_FILES = ["test/alpha-unit.test.ts", "test/beta-unit.test.ts"];
const CHANGED = ["packages/wiki/src/sdk/core.ts"];

/** Scratch directory for the synthetic contract; never inside the worktree. */
let scratch: string;

/** The synthetic contract file, a real path on disk that the repository does not own. */
let synthetic: string;

/** A second one, so de-duplication is proved against a list longer than the tier's overlap. */
let secondSynthetic: string;

/** The synthetic contract list, so each case reads as "a list holding one entry". */
let contracts: readonly string[];

/** Two entries, for the case that proves why a contract is de-duplicated by exact path. */
let bothContracts: readonly string[];

/**
 * Every file the plan runs UNCONDITIONALLY, i.e. from a `run` invocation.
 *
 * A `related` invocation's positionals are SOURCE filters — vitest decides
 * which tests import them — so they are not selections this test can count.
 */
function testsRun(plan: readonly VitestInvocation[]): string[] {
  return plan
    .filter((invocation) => invocation.argv[0] === "run")
    .flatMap((invocation) => invocation.argv.slice(1))
    .filter((arg) => !arg.startsWith("-"));
}

/** Every contract file the plan reports as added, so the audit line is provable too. */
function contractsAdded(plan: readonly VitestInvocation[]): string[] {
  return plan.flatMap((invocation) => invocation.addedContracts);
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "output-contracts-"));
  synthetic = path.join(scratch, "synthetic-contract.test.ts");
  secondSynthetic = path.join(scratch, "second-synthetic-contract.test.ts");
  await writeFile(synthetic, "// A spawned-process contract stand-in; the planner never reads it.\n", "utf8");
  await writeFile(secondSynthetic, "// A second stand-in, only ever compared by path.\n", "utf8");
  contracts = [synthetic];
  bothContracts = [synthetic, secondSynthetic];
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("planAffectedInvocations — the contract is always covered", () => {
  it("adds the contract on a global scope, after the whole unit tier", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "scripts/ affects the whole suite" }, UNIT_FILES, contracts);
    expect(plan).toHaveLength(1);
    expect(plan[0].argv).toEqual(["run", ...UNIT_FILES, synthetic]);
    expect(contractsAdded(plan)).toEqual([synthetic]);
  });

  it("adds the contract on a files/related scope as a second invocation that excludes it from the related run", () => {
    const plan = planAffectedInvocations({ kind: "files", files: CHANGED }, [], contracts);
    expect(plan).toHaveLength(2);
    expect(plan[0].argv, "the related run must skip the contract it will not own").toEqual(["related", `--exclude=${synthetic}`, ...CHANGED]);
    expect(plan[1].argv).toEqual(["run", synthetic]);
    expect(contractsAdded(plan)).toEqual([synthetic]);
  });

  it("adds only the contracts the tier does not already hold, and runs each exactly once", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "x" }, [synthetic, ...UNIT_FILES], bothContracts);
    expect(testsRun(plan).filter((file) => file === synthetic), "a contract the tier already selected must not run twice").toHaveLength(1);
    expect(plan[0].argv, "the tier's order is preserved and only the missing contract is appended").toEqual(["run", synthetic, ...UNIT_FILES, secondSynthetic]);
    expect(contractsAdded(plan), "only the contract this merge had to add is reported").toEqual([secondSynthetic]);
    expect(plan).toHaveLength(1);
  });

  it("runs the contract exactly once when the change IS the contract file", () => {
    const plan = planAffectedInvocations({ kind: "files", files: [synthetic] }, [], contracts);
    expect(testsRun(plan).filter((file) => file === synthetic)).toHaveLength(1);
    // The `related` invocation is told to skip it, so the explicit run is the only one.
    expect(plan[0].argv).toContain(`--exclude=${synthetic}`);
  });

  it("names a contract file that really exists, so the temp-dir stand-in is not theoretical", () => {
    expect(existsSync(synthetic)).toBe(true);
  });
});

describe("planAffectedInvocations — an empty contract list is a valid state", () => {
  it("plans exactly the unit tier on a global scope, adding nothing", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "scripts/ affects the whole suite" }, UNIT_FILES, []);
    expect(plan).toEqual([{ argv: ["run", ...UNIT_FILES], addedContracts: [] }]);
  });

  it("plans one related run and no second invocation on a files scope", () => {
    const plan = planAffectedInvocations({ kind: "files", files: CHANGED }, [], []);
    expect(plan).toEqual([{ argv: ["related", ...CHANGED], addedContracts: [] }]);
  });

  it("runs nothing when there is nothing to run", () => {
    expect(planAffectedInvocations({ kind: "none", reason: "no changes" }, [], contracts)).toEqual([]);
  });
});

describe("OUTPUT_CONTRACT_TESTS — the list must be honest about the tree", () => {
  it("names only repository-relative paths that exist", () => {
    for (const file of OUTPUT_CONTRACT_TESTS) {
      expect(path.isAbsolute(file), `${file} must be repository-relative`).toBe(false);
      expect(file.endsWith(".test.ts"), `${file} must name a test file`).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} must exist: a dead entry fails the affected run closed`).toBe(true);
    }
  });

  it("holds only files the unit tier cannot run, because they spawn", () => {
    const classified = new Map(classifyTests(process.cwd()).map((entry) => [entry.file, entry.spawns]));
    for (const file of OUTPUT_CONTRACT_TESTS) {
      expect(classified.get(file), `${file} must be a test file in the suite`).toBe(true);
    }
  });

  it("is a list the planner can read as-is, whatever its length", () => {
    expect(Array.isArray(OUTPUT_CONTRACT_TESTS)).toBe(true);
    const plan = planAffectedInvocations({ kind: "global", reason: "x" }, UNIT_FILES);
    expect(testsRun(plan)).toEqual([...UNIT_FILES, ...OUTPUT_CONTRACT_TESTS]);
  });
});
