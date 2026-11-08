/**
 * @file test/control-gates.test.ts
 * @description Pins the control layer the feature document specifies, so the
 * gates cannot rot back into prose.
 *
 * Spec: odd/tasks/control-gates-ci.md — S1, S2, S3, S5, S6, S7, S8, S10.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { compareViolations, type HouseViolation, type Snapshot } from "../scripts/lint-ratchet.js";

/** One workflow step, as GitHub reads it from the parsed YAML. */
interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

/** The parsed shape of a workflow file, reduced to what these assertions read. */
interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

/** The gates `AGENTS.md` lists, in the order it lists them. */
const GATE_COMMANDS = [
  "npx tsc --noEmit",
  "npm run typecheck:tests",
  "npm run build",
  "npm run test:affected",
  "npm run fallow:ci",
  "npm run lint",
] as const;

/** The commands the README block that follows `anchor` lists, in order. */
function fencedCommands(text: string, anchor: string): string[] {
  const start = text.indexOf(anchor);
  const block = start === -1 ? null : /```bash\n([\s\S]*?)```/.exec(text.slice(start));
  if (!block?.[1]) return [];
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The gate commands an `AGENTS.md` numbered list names, in order. */
function numberedGateCommands(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\d+\. `([^`]+)`/.exec(line))
    .flatMap((match) => (match?.[1] ? [match[1]] : []));
}

/** Read a repository file relative to this test file. */
function readRepositoryFile(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

/** Parse a workflow the way GitHub does: YAML into a plain object. */
function readWorkflow(relative: string): Workflow {
  return load(readRepositoryFile(relative)) as Workflow;
}

/** Step labels, in file order: the name, else the action, else the command. */
function stepLabels(workflow: Workflow, job: string): string[] {
  return (workflow.jobs[job]?.steps ?? []).map((step) => (step.name ?? step.uses ?? step.run ?? "").trim());
}

/** The commands the named job runs, in file order. */
function jobCommands(workflow: Workflow, job: string): string[] {
  return (workflow.jobs[job]?.steps ?? []).flatMap((step) => (step.run ? [step.run.trim()] : []));
}

/** A synthetic snapshot for the ratchet comparison: counts are derived, never passed in. */
function snapshotOf(violations: HouseViolation[]): Snapshot {
  const counts: Record<string, number> = {};
  for (const violation of violations) {
    const key = `${violation.file} ${violation.ruleId}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { violations, counts, filesScanned: 1, configuration: "probe" };
}

/** One violation of a house rule, in a file named by the caller. */
function violationOf(file: string, ruleId: string, line = 1): HouseViolation {
  return { file, line, ruleId, message: "probe" };
}

describe("control gates — CI wiring", () => {
  it("keeps the branch-protection job keys of ci.yml unchanged", () => {
    expect(Object.keys(readWorkflow(".github/workflows/ci.yml").jobs)).toEqual(["build-and-test", "codebase-health"]);
  });

  it("keeps the test-typecheck job key unchanged", () => {
    expect(Object.keys(readWorkflow(".github/workflows/typecheck-tests.yml").jobs)).toEqual(["test-typecheck"]);
  });

  it("runs the type-check, the lint ratchet and the affected tests inside build-and-test", () => {
    const workflow = readWorkflow(".github/workflows/ci.yml");
    expect(jobCommands(workflow, "build-and-test")).toEqual(
      expect.arrayContaining(["npx tsc --noEmit", "npm run lint", "npm run test:affected"]),
    );
  });

  it("keeps the order: root type-check before the build, affected tests before the full suite", () => {
    const labels = stepLabels(readWorkflow(".github/workflows/ci.yml"), "build-and-test");
    const index = (label: string) => labels.indexOf(label);
    expect(index("Type-check the root project")).toBeGreaterThan(index("npm ci"));
    expect(index("Type-check the root project")).toBeLessThan(index("npm run build"));
    expect(index("Lint the house rules against their frozen baseline")).toBeLessThan(index("npm run build"));
    expect(index("Run the tests affected by this change")).toBeGreaterThan(index("Verify tenant isolation is enforced"));
    expect(index("Run the tests affected by this change")).toBeLessThan(index("npm test"));
  });
});

describe("control gates — one source of truth", () => {
  it("no longer tracks CLAUDE.md", () => {
    const tracked = execFileSync("git", ["ls-files", "CLAUDE.md"], { encoding: "utf8" }).trim();
    expect(tracked).toBe("");
    // The target is deliberately absent: this assertion IS that absence, so the analyzer's
    // unresolved-import heuristic is expected to fire on the line below. It is not hidden debt.
    // fallow-ignore-next-line unresolved-import
    expect(existsSync(new URL("../CLAUDE.md", import.meta.url))).toBe(false);
  });

  it("lists the six gates in AGENTS.md", () => {
    expect(numberedGateCommands(readRepositoryFile("AGENTS.md"))).toEqual([...GATE_COMMANDS]);
  });

  it("lists the same gates, in the same order, in README.md", () => {
    const readme = fencedCommands(readRepositoryFile("README.md"), "Before committing code changes, run:");
    expect(readme.length).toBeGreaterThan(0);
    const positions = GATE_COMMANDS.map((command) => readme.indexOf(command));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });
});

describe("control gates — the ESLint ratchet", () => {
  it("fails on a new violation of each house rule", () => {
    for (const ruleId of [
      "max-lines",
      "max-lines-per-function",
      "@typescript-eslint/no-explicit-any",
      "no-restricted-imports",
    ]) {
      const errors = compareViolations(snapshotOf([violationOf("src/probe.ts", ruleId)]), {});
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(ruleId);
    }
  });

  it("passes a run that matches its baseline exactly", () => {
    const baseline = { "src/probe.ts max-lines": 1, "src/other.ts no-restricted-imports": 2 };
    const violations = [
      violationOf("src/probe.ts", "max-lines"),
      violationOf("src/other.ts", "no-restricted-imports", 3),
      violationOf("src/other.ts", "no-restricted-imports", 9),
    ];
    expect(compareViolations(snapshotOf(violations), baseline)).toEqual([]);
  });

  it("fails when a baselined violation disappears, so an allowance cannot linger", () => {
    const errors = compareViolations(snapshotOf([]), { "src/probe.ts max-lines": 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("decreased");
  });

  it("fails on the excess over a baseline count, not on the allowance itself", () => {
    const violations = [violationOf("src/probe.ts", "max-lines", 1), violationOf("src/probe.ts", "max-lines", 2)];
    const errors = compareViolations(snapshotOf(violations), { "src/probe.ts max-lines": 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/probe.ts:2");
  });
});
