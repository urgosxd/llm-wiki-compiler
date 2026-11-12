/**
 * The local health gate must make the same decision as `fallow audit --gate
 * new-only`, which the KG gate and CI's PR runs already use, so a report that
 * only carries pre-existing debt passes locally while an introduced finding
 * still blocks. Each case feeds a synthetic audit document to the report
 * boundary on stdin; no analyzer, no network, no git base ref.
 *
 * The second half drives `scripts/fallow-ci.sh` itself, because the refusal it
 * owns cannot be a fixture: the audit document names its base with a ref NAME
 * (`base_ref: "main"`) and carries an abbreviated `head_sha`, never the resolved
 * base commit, so "the base is HEAD" is only decidable where git is. Those cases
 * run the real script in a scratch repository whose analyzer is a stub, which is
 * what keeps them independent of this checkout's git state.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

/** This checkout's root, so a scratch repository can link the two gate scripts. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Scratch repositories a case builds, removed when that case ends. */
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Git in a scratch repository: pinned identity and no signing, so commits never depend on this host. */
function gitAt(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, ...args], { cwd, stdio: "ignore" });
}

/**
 * A scratch repository that runs the REAL `scripts/fallow-ci.sh` against a stub analyzer.
 *
 * `branch` is the only local branch created, so `refs/heads/main` exists exactly when the
 * case says `main`: the guard's subject is that ref, not a default this host happens to use.
 */
function scratchGateRepo(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), "fallow-gate-"));
  scratchRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  for (const name of ["fallow-ci.sh", "check-fallow-report.mjs"]) {
    symlinkSync(join(REPO_ROOT, "scripts", name), join(root, "scripts", name));
  }
  writeFileSync(join(root, "node_modules", ".bin", "fallow"), '#!/usr/bin/env bash\ncat "$FAKE_REPORT"\n', { mode: 0o755 });
  gitAt(root, "init", "--quiet", "-b", branch);
  gitAt(root, "commit", "--quiet", "--allow-empty", "-m", "base");
  return root;
}

/** Add one commit on a new branch, so HEAD moves past the base the script will resolve. */
function commitOn(root: string, branch: string): void {
  gitAt(root, "checkout", "--quiet", "-b", branch);
  gitAt(root, "commit", "--quiet", "--allow-empty", "-m", branch);
}

/** Run the real gate script in `root`, with the stub analyzer emitting `report`. */
function runScript(root: string, report: unknown, extraEnv: Record<string, string> = {}) {
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const env = { ...process.env, FAKE_REPORT: reportPath, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ...extraEnv };
  return spawnSync("bash", ["scripts/fallow-ci.sh"], { cwd: root, encoding: "utf8", env });
}

/** The env CI sets, and the only value that turns the vacuous base into a fatal error. */
const CI_STRICT = { FALLOW_CI_REQUIRE_DISTINCT_BASE: "1" };

/** A scratch repository whose local `main` is one commit AHEAD of a detached HEAD. */
function mainAheadOfHead(): string {
  const root = scratchGateRepo("main");
  gitAt(root, "commit", "--quiet", "--allow-empty", "-m", "landed on main");
  gitAt(root, "checkout", "--quiet", "--detach", "HEAD~1");
  return root;
}

describe("local Fallow gate: a base that is HEAD", () => {
  it("refuses a changeset whose base is HEAD when CI asks for a distinct base", () => {
    const root = scratchGateRepo("main");
    const result = runScript(root, audit(), CI_STRICT);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refusing to run");
    expect(result.stderr).toContain("compared nothing");
    expect(result.stdout).not.toContain("Fallow CI:");
  });

  it("warns loudly and still runs the gate when the base is HEAD and CI did not ask", () => {
    const root = scratchGateRepo("main");
    const result = runScript(root, audit());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("WARNING");
    expect(result.stderr).toContain("compared nothing");
    expect(result.stderr).toContain("refs/heads/main");
    expect(result.stderr).toContain("FALLOW_CI_REQUIRE_DISTINCT_BASE=1");
    expect(result.stdout).toContain("Fallow CI: 0 dead-code");
  });

  it("proceeds when the base is an earlier commit than HEAD", () => {
    const root = scratchGateRepo("main");
    commitOn(root, "feature");
    const result = runScript(root, audit());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced");
    expect(result.stderr).not.toContain("refusing to run");
  });

  it("refuses a report that cannot name its base, without blaming HEAD for it", () => {
    const root = scratchGateRepo("trunk");
    const result = runScript(root, audit({ base_ref: "" }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing base ref; cannot attribute findings");
    expect(result.stderr).not.toContain("refusing to run");
  });
});

// The shape the equality wording got wrong: `main` holds commits this checkout does not, so
// the two commits are NOT equal, and the gate has still compared nothing. The guard's subject
// is merge-base(main, HEAD) == HEAD, never SHA equality (S7, S10).
describe("local Fallow gate: local main ahead of HEAD", () => {
  it("refuses when local main is AHEAD of HEAD, because merge-base(main, HEAD) is still HEAD", () => {
    const result = runScript(mainAheadOfHead(), audit(), CI_STRICT);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refusing to run");
    expect(result.stdout).not.toContain("Fallow CI:");
  });

  it("warns without claiming main and HEAD are the same commit, because they are not", () => {
    const result = runScript(mainAheadOfHead(), audit());
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("compared nothing");
    expect(result.stderr).not.toContain("are the same commit");
  });

  // S10: the printed SHA must be HEAD's, so the message never hands a reader the wrong commit.
  it("prints exactly one Fallow CI line naming HEAD's own SHA, never the commit main points at", () => {
    const root = mainAheadOfHead();
    const rev = (ref: string) => execFileSync("git", ["rev-parse", ref], { cwd: root, encoding: "utf8" }).trim();
    const head = rev("HEAD");
    const main = rev("refs/heads/main");
    expect(head).not.toBe(main);
    for (const strict of [{}, CI_STRICT]) {
      const result = runScript(root, audit(), strict);
      const lines = result.stderr.split("\n").filter((line) => line.startsWith("Fallow CI:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`(merge-base(refs/heads/main, HEAD) is HEAD, ${head})`);
      expect(lines[0]).not.toContain(main);
      expect(result.status).toBe(strict === CI_STRICT ? 2 : 0);
    }
  });
});
