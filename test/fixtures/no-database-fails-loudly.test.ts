/**
 * @file test/fixtures/no-database-fails-loudly.test.ts
 * @description Prove BY A RUN, not by inspection, that an unobtainable database fails the suites.
 *
 * ## Why this test spawns vitest instead of importing a fixture
 *
 * The defect being closed is a property of the RUN, not of a function: with no database the
 * database-backed suites SKIPPED, and a skip is a PASS, so `npm test` reported green while asserting
 * nothing. Asserting on a helper's return value would prove nothing about that outcome — the helper
 * could return an error that every suite then discards, which is exactly what used to happen. So the
 * child runs the project's own vitest over real gated suites and this file judges what the OS
 * reports: the exit status, and whether the run declared its cases skipped.
 *
 * ## Why an explicit override and not "no variable at all"
 *
 * No variable at all makes the run try to start a container, which would make this test depend on
 * Docker and on pull time. `LLMWIKI_TEST_DATABASE_URL` pointing at port 1 is a database that cannot
 * be obtained without asking Docker anything: the override wins, nothing is started, and every
 * connection is refused immediately. `127.0.0.1:1` is syntactically valid and nothing listens there.
 *
 * ## The two traps in the child environment
 *
 * `AKS_TEST_DATABASE_URL` outranks `LLMWIKI_TEST_DATABASE_URL` inside the ingest harness, so an
 * inherited value would point that suite at a live server and the run would prove the opposite of
 * what it claims. `AKS_DATABASE_URL` is pinned to the same unreachable URL so the production paths
 * that read it directly cannot reach a real server either. The `VITEST*` variables are stripped
 * because a nested vitest that believes it is a worker of its parent misreports its own run.
 *
 * ## Why the child gets a handoff record of its OWN
 *
 * The child's global setup republishes the handoff record — the channel a run uses to publish its
 * database to its workers. Writing the record the PARENT's run uses moved the database under the run
 * that spawned this test: sibling workers boot their setup file during this child's lifetime, read
 * `127.0.0.1:1` from the record, and fail with `missingTestDatabase` for a reason no suite owns.
 * Measured before the fix: 317 of the samples of `.llmwiki/test-database.json` taken during one run of
 * this file held the unreachable URL. So the child is pointed at a temp record through
 * `LLMWIKI_TEST_DB_HANDOFF_FILE`, and the parent's record is not opened at all.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_HANDOFF_FILE_ENV_VAR } from "./test-database-handoff.js";

/** Repository root, resolved from this file so the child runs from the same tree. */
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The project's own vitest. A PATH lookup could resolve a different one. */
const VITEST_BIN = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "vitest");

/** A valid URL that no server answers: connection refused, immediately, on loopback. */
const UNREACHABLE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/**
 * The suites whose whole content is database-backed, one from each way a run used to go green
 * without a database: the ingest route harness, the dimension end-to-end suites, a store suite with
 * its own probe, and a suite gated on the application role.
 */
const DATABASE_SUITES = [
  "packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts",
  "test/dimensions/kg-runtime-e2e.test.ts",
  "test/dimensions/source-documents-store.test.ts",
  "test/dimensions/compile-config-isolation.test.ts",
] as const;

/** Generous next to the ~10 s these four files need, so a timeout means a hang, not a slow box. */
const CHILD_TIMEOUT_MS = 300_000;

/**
 * Colour escapes vitest writes around every count.
 *
 * Stripped before matching, and not cosmetically: `Tests \u001b[22m \u001b[33m38 skipped` would make
 * `/Tests\s+\d+ skipped/` fail while the report plainly says 38 skipped — a test that asserts nothing.
 */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/** What a child run reported. */
interface ChildRun {
  /** Exit status, or `-1` when the child could not be started or timed out. */
  readonly status: number;
  /** Everything the child wrote, stdout first. */
  readonly output: string;
}

/**
 * The environment one child run gets: no inherited database, an unreachable override, and a handoff
 * record of its own so it cannot republish the record its parent's workers are reading.
 */
function childEnvironment(optOut: boolean, handoffFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("VITEST") || name === "AKS_TEST_DATABASE_URL") continue;
    env[name] = value;
  }
  env["LLMWIKI_TEST_DATABASE_URL"] = UNREACHABLE_URL;
  env["AKS_DATABASE_URL"] = UNREACHABLE_URL;
  env[TEST_DATABASE_HANDOFF_FILE_ENV_VAR] = handoffFile;
  if (optOut) env["LLMWIKI_TEST_ALLOW_NO_DATABASE"] = "1";
  return env;
}

/**
 * Run the database suites in a child vitest that owns a handoff record of its own.
 *
 * The record lives in a fresh temp directory and is removed as soon as the child exits: it has no
 * meaning afterwards, and leaving it behind would litter `os.tmpdir()` once per run.
 */
function runSuites(optOut: boolean): ChildRun {
  const handoffDirectory = mkdtempSync(path.join(tmpdir(), "llmwiki-child-handoff-"));
  try {
    const result = spawnSync(VITEST_BIN, ["run", ...DATABASE_SUITES], {
      cwd: REPOSITORY_ROOT,
      env: childEnvironment(optOut, path.join(handoffDirectory, "test-database.json")),
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    const output = `${result.stdout}${result.stderr}`.replace(ANSI_ESCAPE, "");
    return { status: result.status ?? -1, output };
  } finally {
    rmSync(handoffDirectory, { recursive: true, force: true });
  }
}

/** The failing-mode run, spawned once however many cases read it. */
let withoutDatabase: ChildRun | undefined;

/** The failing-mode run's result. */
function failingRun(): ChildRun {
  withoutDatabase ??= runSuites(false);
  return withoutDatabase;
}

describe("a database-backed run with no obtainable database", () => {
  it("exits non-zero instead of reporting the cases as skipped", () => {
    const run = failingRun();

    expect(run.status).not.toBe(0);
    // The defect: exit 0 with `Tests 40 skipped (40)`. A skip is a pass, so both lines are refuted.
    expect(run.output).not.toMatch(/Tests\s+\d+ skipped/);
    expect(run.output).not.toMatch(/Tests\s+\d+ passed/);
  });

  it("names the override, the pinned image, Docker and the opt-out", () => {
    const { output } = failingRun();

    expect(output).toContain("LLMWIKI_TEST_DATABASE_URL");
    expect(output).toContain("pgvector/pgvector:pg16");
    expect(output).toContain("Docker");
    expect(output).toContain("LLMWIKI_TEST_ALLOW_NO_DATABASE=1");
  });

  it("keeps the documented opt-out skipping green", () => {
    const run = runSuites(true);

    expect(run.status).toBe(0);
    expect(run.output).toMatch(/Tests\s+\d+ skipped/);
  });

  it("lists only suite paths that exist, because vitest ignores a path that does not", () => {
    for (const suite of DATABASE_SUITES) {
      expect(existsSync(path.join(REPOSITORY_ROOT, suite)), suite).toBe(true);
    }
  });
});
