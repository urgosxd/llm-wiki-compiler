/**
 * @file test/control-gates.test.ts
 * @description Pins the control layer the feature document specifies, so the
 * gates cannot rot back into prose.
 *
 * Spec: odd/tasks/control-gates-ci.md — S1, S2, S3, S5, S6, S7, S8, S10.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { compareViolations, type HouseViolation, type Snapshot } from "../scripts/lint-ratchet.js";

/** One workflow step, as GitHub reads it from the parsed YAML. */
interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** The parsed shape of a workflow file, reduced to what these assertions read. */
interface Workflow {
  jobs: Record<string, { env?: Record<string, string>; steps?: WorkflowStep[] }>;
}

/**
 * The two steps that now enter the task graph, by their `ci.yml` step label.
 *
 * Labels, not `run` strings: a step that carries a `name` is identified by it, and both
 * turbo invocations carry one so the workflow reads as an intent rather than as a command.
 */
const TURBO_BUILD_LABEL = "Build the distribution and the @repo/kg artefact through the task graph";
const TURBO_TEST_LABEL = "Run the full suite through the task graph";

/**
 * The commands those two steps run, in the bare `pnpm` form.
 *
 * `ci.yml` mentions `corepack` nowhere: both jobs provision pnpm and Node through
 * `pnpm/action-setup@v4` + `actions/setup-node@v4`, so neither depends on what the runner
 * image happens to ship. `corepack` survives only as a workaround for a developer host
 * whose bare `pnpm` is broken — never as a CI form.
 */
const TURBO_BUILD_COMMAND = "pnpm exec turbo run build";
const TURBO_TEST_COMMAND = "pnpm exec turbo run test --filter=//";

/**
 * Job `env:` keys that deliberately do NOT reach a turbo task, each with its reason.
 *
 * EMPTY TODAY, and that is the finding rather than an oversight: every variable the
 * `build-and-test` job sets is one the suite reads, so all three must be forwarded.
 * An entry here is a decision a reviewer can see; the assertion below fails closed for
 * any key that is neither forwarded nor listed, so a variable added to that env block
 * tomorrow cannot join silently.
 */
const ENV_EXEMPT: Readonly<Record<string, string>> = {};

/** A string literal (kept) or a comment (dropped), so a `//` inside a string survives. */
const STRING_OR_COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** The gates `AGENTS.md` lists, in the order it lists them. */
const GATE_COMMANDS = [
  "pnpm exec tsc --noEmit",
  "pnpm run typecheck:tests",
  "pnpm run build",
  "pnpm run test:affected",
  "pnpm run fallow:ci",
  "pnpm run lint",
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

/** Parse `turbo.json` the way its JSONC readers do, so comments never break the parse. */
function turboGraph(): { globalEnv?: string[]; globalPassThroughEnv?: string[] } {
  const stripped = readRepositoryFile("turbo.json").replace(STRING_OR_COMMENT, (match) =>
    match.startsWith('"') ? match : "",
  );
  return JSON.parse(stripped) as { globalEnv?: string[]; globalPassThroughEnv?: string[] };
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

  it("runs the type-check, the lint ratchet and the full suite inside build-and-test", () => {
    const workflow = readWorkflow(".github/workflows/ci.yml");
    expect(jobCommands(workflow, "build-and-test")).toEqual(
      expect.arrayContaining(["pnpm exec tsc --noEmit", "pnpm run lint", TURBO_TEST_COMMAND]),
    );
  });

  it("leaves test:affected out of CI, so `pnpm test` stays the only test verdict", () => {
    const workflow = readWorkflow(".github/workflows/ci.yml");
    expect(jobCommands(workflow, "build-and-test")).not.toContain("pnpm run test:affected");
    expect(stepLabels(workflow, "build-and-test")).not.toContain("Run the tests affected by this change");
  });

  // The two ordered steps are found by LABEL because both carry a `name`; an unnamed
  // step resolves to `-1`, which is why every pair below asserts BOTH endpoints exist
  // before comparing them — a missing label cannot make an ordering pass by accident.
  it("keeps the order: root type-check before the build, the suite after the schema steps", () => {
    const workflow = readWorkflow(".github/workflows/ci.yml");
    const labels = stepLabels(workflow, "build-and-test");
    const index = (label: string) => labels.indexOf(label);
    expect(jobCommands(workflow, "build-and-test"), "the build step must still enter the graph").toContain(
      TURBO_BUILD_COMMAND,
    );
    const order: readonly (readonly [string, string])[] = [
      ["pnpm install --frozen-lockfile", "Type-check the root project"],
      ["Type-check the root project", TURBO_BUILD_LABEL],
      ["Lint the house rules against their frozen baseline", TURBO_BUILD_LABEL],
      [TURBO_BUILD_LABEL, "Build and smoke-test both container images"],
      ["Verify tenant isolation is enforced", TURBO_TEST_LABEL],
    ];
    for (const [before, after] of order) {
      expect(index(before), `${before} must be a step label in ci.yml`).toBeGreaterThan(-1);
      expect(index(after), `${after} must be a step label in ci.yml`).toBeGreaterThan(-1);
      expect(index(before), `${before} must precede ${after}`).toBeLessThan(index(after));
    }
  });
});

/** The one step that gates the codebase, by its `ci.yml` label. */
const FALLOW_STEP_LABEL = "Gate the codebase health of this changeset";

/**
 * The variable that makes a vacuous base fatal.
 *
 * CI is its ONLY legitimate home: with it unset, `scripts/fallow-ci.sh` warns and proceeds,
 * which is what a developer on a branch with no commits yet needs (`.husky/pre-commit` runs
 * that script, and `AGENTS.md` forbids `--no-verify`). So dropping this one `env:` line from
 * the workflow would NOT fail the script's own tests — it would silently return CI to
 * warn-and-proceed, green having compared nothing. That is why the declaration itself is
 * pinned below, and why every pin names the property it protects.
 */
const STRICT_BASE_ENV = "FALLOW_CI_REQUIRE_DISTINCT_BASE";

/** The parsed `codebase-health` job of `ci.yml`. */
function codebaseHealthJob(): { env?: Record<string, string>; steps?: WorkflowStep[] } {
  return readWorkflow(".github/workflows/ci.yml").jobs["codebase-health"] ?? {};
}

/** Every step in every workflow that declares `key` in its `env`, as `<file>:<label>`. */
function stepsDeclaringEnv(key: string): string[] {
  const dir = new URL("../.github/workflows/", import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) => {
      const workflow = load(readFileSync(new URL(name, dir), "utf8")) as Workflow;
      return Object.entries(workflow.jobs).flatMap(([, job]) =>
        (job.steps ?? [])
          .filter((step) => step.env !== undefined && key in step.env)
          .map((step) => `${name}:${(step.name ?? step.uses ?? "").trim()}`),
      );
    })
    .sort();
}

describe("control gates — the codebase-health job shape", () => {
  // Provisioning is pinned positionally AND by index, as `build-and-test` does it: a required
  // check that leaned on the runner image's toolchain would gate with something unverified.
  it("keeps four steps: full-history checkout, pnpm, Node 24, then the gate, and no fallow action", () => {
    const steps = codebaseHealthJob().steps ?? [];
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } });
    expect(steps[1]).toMatchObject({ uses: "pnpm/action-setup@v4" });
    expect(steps[2]).toMatchObject({ uses: "actions/setup-node@v4", with: { "node-version": 24, cache: "pnpm" } });
    expect(steps[3]?.name).toBe(FALLOW_STEP_LABEL);
    const uses = steps.map((step) => step.uses ?? "");
    expect(uses.indexOf("pnpm/action-setup@v4")).toBeLessThan(uses.indexOf("actions/setup-node@v4"));
    expect(JSON.stringify(codebaseHealthJob()), "the pinned fallow action is not the gate").not.toContain("fallow-rs");
  });

  it("runs the project's own gate command with the pnpm the job provisioned, not corepack", () => {
    const runs = (codebaseHealthJob().steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("pnpm run fallow:ci");
    expect(runs[0], "the job provisions pnpm; it must not assume the runner image's corepack").not.toContain("corepack");
  });

  it("takes the event's own base, refuses an absent one, and detaches HEAD before repointing main", () => {
    const steps = codebaseHealthJob().steps ?? [];
    const gate = steps.find((step) => step.name === FALLOW_STEP_LABEL);
    const run = gate?.run ?? "";
    expect(gate?.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha || github.event.before }}");
    expect(run, "no fallback to a base the event did not name").not.toContain("origin/main");
    expect(run).toContain("::error::");
    expect(run).toContain("exit 1");
    const order = ["0000000000000000000000000000000000000000", "git checkout --detach", "git update-ref refs/heads/main"]
      .map((needle) => run.indexOf(needle));
    expect(order, `missing from the gate step: ${order}`).not.toContain(-1);
    expect([...order].sort((left, right) => left - right), "detach before repointing main").toEqual(order);
  });

  it("declares the strict distinct-base mode on that one CI step, because its absence makes CI vacuous", () => {
    expect(stepsDeclaringEnv(STRICT_BASE_ENV), "CI-only strictness, on exactly one step").toEqual([
      `ci.yml:${FALLOW_STEP_LABEL}`,
    ]);
    const gate = (codebaseHealthJob().steps ?? []).find((step) => step.name === FALLOW_STEP_LABEL);
    expect(gate?.env?.[STRICT_BASE_ENV], "the exact value, not mere presence").toBe("1");
  });
});

// The env half of the same wiring, and it fails CLOSED: turbo 2 runs tasks in strict env
// mode, so a variable this job sets and `turbo.json` does not declare never reaches
// `//#test`. Measured: with the list absent, a probe task printed
// `LLMWIKI=UNSET DATABASE_URL=UNSET AKS=UNSET` while turbo exited 0 — a silent strip.
// The subject is the JOB'S ENV BLOCK, not a name pattern: every key must be accounted
// for, so a new variable cannot join by having an unrecognised name.
describe("control gates — turbo env pass-through", () => {
  it("forwards every env key of the build-and-test job into the turbo test task", () => {
    const keys = Object.keys(readWorkflow(".github/workflows/ci.yml").jobs["build-and-test"]?.env ?? {});
    expect(keys.length, "an empty env block would make this assertion vacuous").toBeGreaterThan(0);
    const graph = turboGraph();
    const forwarded = new Set([...(graph.globalEnv ?? []), ...(graph.globalPassThroughEnv ?? [])]);
    const unaccounted = keys.filter((key) => !forwarded.has(key) && !(key in ENV_EXEMPT));
    expect(unaccounted, "declare these in turbo.json globalPassThroughEnv, or exempt each in ENV_EXEMPT").toEqual([]);
    // The exemption path needs teeth of its own: an entry that can be blank would turn the
    // assertion above into a way to silence a variable instead of a way to decide about one.
    for (const [key, reason] of Object.entries(ENV_EXEMPT)) {
      expect(reason.trim(), `ENV_EXEMPT[${key}] must carry a reason`).not.toBe("");
    }
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
});

describe("control gates — the ratchet's failure messages", () => {
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

  it("names the missing allowance instead of calling a pre-existing file brand-new", () => {
    const errors = compareViolations(snapshotOf([violationOf("src/index.ts", "@typescript-eslint/no-explicit-any")]), {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no frozen allowance for @typescript-eslint/no-explicit-any in this file");
    expect(errors[0]).not.toContain("brand-new");
  });

  it("still reports an exceeded allowance in a file the baseline knows", () => {
    const violations = [violationOf("src/index.ts", "max-lines", 1), violationOf("src/index.ts", "max-lines", 2)];
    const errors = compareViolations(snapshotOf(violations), { "src/index.ts max-lines": 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("new violation in an existing file");
  });
});
