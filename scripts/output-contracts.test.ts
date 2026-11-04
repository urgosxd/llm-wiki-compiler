/**
 * @file Prove the affected-run planner always covers the output contracts.
 *
 * These assertions are pure: no CLI is spawned and nothing is built, so the
 * selection logic is provable in milliseconds. The file worth spawning —
 * `test/quickstart-json-stdout.test.ts` — is covered by actually running it.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_CONTRACT_TESTS, planAffectedInvocations, type VitestInvocation } from "./output-contracts.ts";
import { classifyTests } from "./test-partition.ts";

const CONTRACT = "test/quickstart-json-stdout.test.ts";
const UNIT_FILES = ["test/alpha-unit.test.ts", "test/beta-unit.test.ts"];
const CHANGED = ["src/cli/run.ts"];

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

describe("planAffectedInvocations — the contract is always covered", () => {
  it("adds the output contract on a global scope", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "scripts/ affects the whole suite" }, UNIT_FILES);
    expect(testsRun(plan)).toContain(CONTRACT);
    expect(contractsAdded(plan)).toContain(CONTRACT);
  });

  it("adds the output contract on a files/related scope", () => {
    const plan = planAffectedInvocations({ kind: "files", files: CHANGED }, []);
    expect(testsRun(plan)).toContain(CONTRACT);
    expect(contractsAdded(plan)).toContain(CONTRACT);
  });

  it("runs the output contract exactly once when the tier also selects it", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "x" }, [CONTRACT, ...UNIT_FILES]);
    expect(testsRun(plan).filter((file) => file === CONTRACT)).toHaveLength(1);
  });

  it("runs the output contract exactly once when the change IS the contract file", () => {
    const plan = planAffectedInvocations({ kind: "files", files: [CONTRACT] }, []);
    expect(testsRun(plan).filter((file) => file === CONTRACT)).toHaveLength(1);
    // The `related` invocation is told to skip it, so the explicit run is the only one.
    expect(plan.some((invocation) => invocation.argv.includes(`--exclude=${CONTRACT}`))).toBe(true);
  });

  it("adds nothing when the selected tier already holds every contract file", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "x" }, [...UNIT_FILES, CONTRACT]);
    expect(contractsAdded(plan)).toEqual([]);
    expect(plan).toHaveLength(1);
  });
});

describe("planAffectedInvocations — preserved tier selection", () => {
  it("keeps the whole unit tier in order and appends the contract after it", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "x" }, UNIT_FILES);
    expect(plan).toHaveLength(1);
    expect(plan[0].argv).toEqual(["run", ...UNIT_FILES, CONTRACT]);
  });

  it("still selects related tests from the changed files", () => {
    const plan = planAffectedInvocations({ kind: "files", files: CHANGED }, []);
    expect(plan[0].argv.slice(0, 2)).toEqual(["related", `--exclude=${CONTRACT}`]);
    expect(plan[0].argv).toContain(CHANGED[0]);
  });

  it("runs nothing when there is nothing to run", () => {
    expect(planAffectedInvocations({ kind: "none", reason: "no changes" }, [])).toEqual([]);
  });
});

describe("OUTPUT_CONTRACT_TESTS justification", () => {
  it("holds only files the unit tier cannot run, because they spawn", () => {
    const classified = new Map(classifyTests(process.cwd()).map((entry) => [entry.file, entry.spawns]));
    for (const file of OUTPUT_CONTRACT_TESTS) {
      expect(classified.get(file), `${file} must be a test file in the suite`).toBe(true);
    }
  });

  it("uses repository-relative test paths", () => {
    for (const file of OUTPUT_CONTRACT_TESTS) {
      expect(path.isAbsolute(file)).toBe(false);
      expect(file.endsWith(".test.ts")).toBe(true);
    }
  });
});
