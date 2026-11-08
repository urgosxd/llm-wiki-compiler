/**
 * The local health gate must make the same decision as `fallow audit --gate
 * new-only`, which the KG gate and CI's PR runs already use, so a report that
 * only carries pre-existing debt passes locally while an introduced finding
 * still blocks. Each case feeds a synthetic audit document to the report
 * boundary on stdin; no analyzer, no network, no git base ref.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Execute the report boundary without running the analyzer or fetching Git. */
function gate(report: unknown) {
  return spawnSync(process.execPath, ["scripts/check-fallow-report.mjs"], {
    input: JSON.stringify(report), encoding: "utf8",
  });
}

/** Build a passing audit document, the shape `fallow audit --format json` emits. */
function audit(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 6, version: "2.82.0", command: "audit", verdict: "pass",
    changed_files_count: 0, base_ref: "main", head_sha: "9fad205",
    summary: { dead_code_issues: 0, complexity_findings: 0, duplication_clone_groups: 0 },
    attribution: {
      gate: "new-only", dead_code_introduced: 0, dead_code_inherited: 0,
      complexity_introduced: 0, complexity_inherited: 0,
      duplication_introduced: 0, duplication_inherited: 0,
    },
    ...overrides,
  };
}

/** Replace the attribution block, keeping the rest of the document valid. */
function withAttribution(overrides: Record<string, unknown>, ...rest: object[]) {
  const [head] = rest as [Record<string, unknown>];
  return audit({ ...head, attribution: { ...audit().attribution, ...overrides } });
}

describe("local Fallow report gate", () => {
  it("passes the measured clean-tree report with 20 below-threshold clone groups", () => {
    const report = withAttribution({ duplication_inherited: 20 }, {
      changed_files_count: 1,
      dupes: { stats: { clone_groups: 20, duplication_percentage: 0.17885532591414946 } },
      check: { total_issues: 0 },
      health: { summary: { functions_above_threshold: 0 } },
    });
    const result = gate(report);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 duplication");
    expect(result.stderr).toBe("");
  });

  it("fails when the changeset introduces a duplication clone group", () => {
    const report = withAttribution({ duplication_introduced: 1 }, {
      verdict: "fail", changed_files_count: 2,
    });
    expect(gate(report).status).toBe(1);
  });

  it("fails when the changeset introduces a dead-code finding", () => {
    const report = withAttribution({ dead_code_introduced: 1 }, {
      verdict: "fail", changed_files_count: 1,
    });
    expect(gate(report).status).toBe(1);
  });

  it("passes when dead code is inherited rather than introduced", () => {
    const report = withAttribution({ dead_code_inherited: 5 }, { changed_files_count: 4 });
    expect(gate(report).status).toBe(0);
  });

  it("ignores the legacy combined-report totals the old checker summed", () => {
    const report = withAttribution({}, {
      changed_files_count: 1, verdict: "pass",
      check: { total_issues: 7 },
      dupes: { stats: { clone_groups: 20 } },
      health: { summary: { functions_above_threshold: 5 } },
    });
    expect(gate(report).status).toBe(0);
  });

  it("fails on introduced findings even when the verdict is warn", () => {
    const report = withAttribution({ duplication_introduced: 20 }, { verdict: "warn" });
    expect(gate(report).status).toBe(1);
  });

  it("fails on a failing verdict with no introduced finding", () => {
    expect(gate(withAttribution({}, { verdict: "fail" })).status).toBe(1);
  });

  it("sums every introduced category and prints each", () => {
    const report = withAttribution({
      dead_code_introduced: 1, complexity_introduced: 1, duplication_introduced: 1,
    }, { verdict: "warn" });
    const result = gate(report);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 dead-code, 1 complexity, 1 duplication introduced");
  });

  it("fails closed on a missing report schema", () => {
    expect(gate({}).status).toBe(2);
  });

  it("fails closed when the document cannot prove new-only attribution", () => {
    const unattributable = [
      withAttribution({}, { command: "check" }),
      withAttribution({}, { base_ref: "" }),
      withAttribution({ gate: "all" }),
      withAttribution({}, { verdict: undefined }),
    ];
    expect(unattributable.map(report => gate(report).status)).toEqual([2, 2, 2, 2]);
  });

  it("fails closed on malformed counters and an unknown verdict", () => {
    const malformed = [
      withAttribution({ dead_code_introduced: -1 }),
      withAttribution({ duplication_inherited: 1.5 }),
      withAttribution({}, { verdict: "green" }),
    ];
    expect(malformed.map(report => gate(report).status)).toEqual([2, 2, 2]);
  });

  it("invokes the pinned audit gate only", () => {
    const script = readFileSync("scripts/fallow-ci.sh", "utf8");
    expect(script).toContain("audit --format json --gate new-only");
    expect(script).not.toContain('--changed-since "$BASE_SHA"');
    expect(script).not.toContain("npx fallow");
  });
});
