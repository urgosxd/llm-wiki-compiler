/**
 * @file test/hatch-means-no-database.test.ts
 * @description Prove BY A RUN that `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` means exactly one thing:
 * this run has no database — all the way into every worker's environment.
 *
 * ## The defect this closes
 *
 * The hatch had three documented effects, and NONE of them touched the channel that puts a
 * connection string into a worker: an unobtainable database becomes a skip instead of a failure
 * (`test/fixtures/test-database-handoff.ts`), global setup starts no container and adopts no
 * documented server (`test/fixtures/testcontainers-postgres.ts`), and no chokepoint throws. But
 * `vitest.config.ts` seeds `AKS_DATABASE_URL` into every worker unconditionally, so a hatch run
 * still handed production code a configured database and answered "yes, a database is configured"
 * to every consumer of that question — the one answer the hatch contradicts.
 *
 * The ruling is that the hatch is enforced in the TEST SEEDING CHAIN
 * (`test/setup/test-database-url.ts`), not by teaching production code about a test-only variable:
 * production must never depend on a variable only the suite sets. So the proof is a spawned run —
 * the child's exit status, its skipped count, and the environment its own worker reports.
 *
 * The seed is gone: the setup file is the ONLY channel that puts a database into a worker's
 * environment, so the run's declared state and the run's variable cannot drift apart. That is why
 * the last describe block here also pins the seeding decisions directly. Importing the setup module
 * re-runs its import-time publication in this worker, which is idempotent: it publishes the same
 * record this worker already adopted, or the same override/fallback value.
 *
 * ## Why a child vitest, and why an unreachable override
 *
 * The property belongs to the RUN, not to a function, so the only honest observation is a real
 * nested run's outcome. `LLMWIKI_TEST_DATABASE_URL` pointing at `127.0.0.1:1` makes the database
 * unobtainable without asking Docker for anything and without depending on whether a developer
 * happens to have the documented local container up — the override wins, nothing is started, and
 * every connection is refused immediately. That override is deliberately LEFT in place: it is what
 * drives the skip diagnostics, and the rule under test removes `AKS_DATABASE_URL` only.
 *
 * ## What the child does NOT inherit
 *
 * `AKS_DATABASE_URL` is stripped from the child's inherited environment, so the only way a worker
 * can hold one is the setup file — the runner seeds nothing statically any more (see the last
 * describe block, which pins that). That is what makes the assertion mean "the seeding chain
 * removed it" rather than "the parent did not have one".
 * `AKS_TEST_DATABASE_URL` outranks the test URL inside the ingest harness, and the `VITEST*`
 * variables are stripped because a nested vitest that believes it is a worker of its parent
 * misreports its own run.
 *
 * ## Why the child owns its handoff record
 *
 * The child's global setup republishes the record that publishes a run's database to its workers.
 * Writing the PARENT's record would move the database under the run that spawned this test, which
 * is a documented incident (`test/fixtures/test-database-handoff.ts`). `LLMWIKI_TEST_DB_HANDOFF_FILE`
 * points the child at a fresh temp file instead, removed as soon as the child exits.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AKS_DATABASE_URL_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";
import vitestConfig from "../vitest.config.js";
import { publishTestDatabaseUrl } from "../test/setup/test-database-url.js";
import {
  DATABASE_OPT_OUT_ENV_VAR,
  TEST_DATABASE_HANDOFF_FILE_ENV_VAR,
  buildHandoff,
  writeTestDatabaseHandoff,
} from "./fixtures/test-database-handoff.js";
import { TEST_DATABASE_URL_ENV_VAR, testDatabaseUrl } from "./fixtures/test-database.js";

/** Repository root, resolved from this file so the child runs from the same tree. */
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The project's own vitest. A PATH lookup could resolve a different one. */
const VITEST_BIN = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "vitest");

/** A valid URL that no server answers: connection refused, immediately, on loopback. */
const UNREACHABLE_URL = "postgresql://aks:aks@127.0.0.1:1/aks";

/** The URL a fake handoff record carries; distinct from the override so the two cannot be confused. */
const RECORDED_URL = "postgresql://aks:aks@127.0.0.1:1/recorded";

/** The probe that reports a spawned worker's own environment (see its own header). */
const PROBE_FILE = "test/fixtures/hatch-worker-env-probe.test.ts";

/**
 * A small suite whose whole content needs a database.
 *
 * Every case is `it.skipIf(!reachable)` against a module-scope harness that throws when the
 * database cannot be obtained, so with the hatch set the file must report its cases as SKIPPED —
 * the behaviour the hatch exists to preserve. A file that ran its bodies file-backed would pass
 * while proving nothing, which is the false green the sibling loud-failure test closes from the
 * other direction.
 */
const DATABASE_SUITE = "test/dimensions/kg-forget.test.ts";

/** Generous next to the few seconds these runs need, so a timeout means a hang, not a slow box. */
const CHILD_TIMEOUT_MS = 300_000;

/** Colour escapes vitest writes around every count; stripped so a regex cannot fail on paint. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/**
 * One count off the reporter's `Tests` summary line, e.g. `Tests  1 passed | 4 skipped (5)`.
 *
 * Parsed rather than matched whole, because vitest lists only the labels that happened: a run where
 * every case skipped prints no `passed` count at all, and a regex for the one shape this run
 * happens to produce would fail for a reason unrelated to the rule.
 */
function summaryCount(output: string, label: "passed" | "skipped"): number {
  const summary = /^\s*Tests\s+(.+)$/m.exec(output)?.[1] ?? "";
  const counted = new RegExp(`(\\d+)\\s+${label}`).exec(summary);
  return counted === null ? 0 : Number(counted[1]);
}

/** What one child run reported. */
interface ChildRun {
  /** Exit status, or `-1` when the child could not be started or timed out. */
  readonly status: number;
  /** Everything the child wrote, stdout first. */
  readonly output: string;
}

/** The environment one child run gets: an unobtainable database and a handoff record of its own. */
function childEnvironment(expectation: string, handoffFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("VITEST")) continue;
    if (name === "AKS_TEST_DATABASE_URL" || name === AKS_DATABASE_URL_ENV_VAR) continue;
    env[name] = value;
  }
  env[TEST_DATABASE_URL_ENV_VAR] = UNREACHABLE_URL;
  env[TEST_DATABASE_HANDOFF_FILE_ENV_VAR] = handoffFile;
  if (expectation === "no-database") env[DATABASE_OPT_OUT_ENV_VAR] = "1";
  return env;
}

/**
 * Run `files` in a child vitest that owns a handoff record of its own.
 *
 * The record lives in a fresh temp directory and is removed as soon as the child exits: it has no
 * meaning afterwards, and leaving it behind would litter `os.tmpdir()` once per run.
 */
function runChild(expectation: string, files: readonly string[]): ChildRun {
  const handoffDirectory = mkdtempSync(path.join(tmpdir(), "llmwiki-hatch-child-"));
  try {
    const env = childEnvironment(expectation, path.join(handoffDirectory, "test-database.json"));
    // The expectation is installed through the probe's own variable, which the parent file
    // deliberately does not share: importing a test module would re-register its cases here.
    env["LLMWIKI_TEST_HATCH_PROBE"] = expectation;
    const result = spawnSync(VITEST_BIN, ["run", ...files], {
      cwd: REPOSITORY_ROOT,
      env,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}`.replace(ANSI_ESCAPE, "") };
  } finally {
    rmSync(handoffDirectory, { recursive: true, force: true });
  }
}

/** The hatch run, spawned once however many cases read it. */
let hatchRun: ChildRun | undefined;

/** The hatch run's result: the hatch set, the probe and a database-backed suite together. */
function withoutDatabase(): ChildRun {
  hatchRun ??= runChild("no-database", [PROBE_FILE, DATABASE_SUITE]);
  return hatchRun;
}

/** The control run, spawned once: the same probe with the hatch NOT taken. */
let controlRun: ChildRun | undefined;

/** The control run's result: no hatch, so the seeding must be exactly what it always was. */
function withDatabaseSeeded(): ChildRun {
  controlRun ??= runChild("database", [PROBE_FILE]);
  return controlRun;
}

describe("LLMWIKI_TEST_ALLOW_NO_DATABASE means this run has no database", () => {
  it("reports the database-backed cases as skipped, with the reason, and exits 0", () => {
    const run = withoutDatabase();

    expect(run.status).toBe(0);
    // A skip is the behaviour the hatch exists to preserve: debugging with no database at all.
    // NON-ZERO, not a fixed number: the rule is "these cases did not run", and the case that runs
    // them file-backed would report 0 here (or exit non-zero, above).
    expect(summaryCount(run.output, "skipped")).toBeGreaterThan(0);
    expect(run.output).toContain("every case in this file will be skipped");
    // The printed reason names the hatch itself, and is quoted back on stderr.
    expect(run.output).toContain(DATABASE_OPT_OUT_ENV_VAR);
  });

  it("leaves no database URL in the worker environment", () => {
    const run = withoutDatabase();

    // Printed by the probe from INSIDE the child's worker; presence only, never a value.
    expect(run.output).toContain("[hatch-probe] AKS_DATABASE_URL=absent isDatabaseConfigured=false");
    expect(run.output).not.toContain("[hatch-probe] AKS_DATABASE_URL=present");
  });

  it("seeds the worker exactly as before when the hatch is not taken", () => {
    const run = withDatabaseSeeded();

    expect(run.status).toBe(0);
    expect(run.output).toContain("[hatch-probe] AKS_DATABASE_URL=present isDatabaseConfigured=true");
  });
});

// One channel. `vitest.config.ts` used to seed `AKS_DATABASE_URL` into every worker through a static
// `env` object, which is a SECOND source of the same fact and the reason a hatch run still held a
// database. The seed is gone; these cases pin that the setup file alone decides, for every way a run
// can come by a URL — and that it carries the value the static seed used to carry, because removing
// a channel that every worker depended on must not remove the value it delivered.

/** Temp directories the cases below create, removed when this file's worker finishes. */
const seedingScratchDirectories: string[] = [];

/** Every scratch directory this file created, gone. */
afterAll(() => {
  for (const directory of seedingScratchDirectories) rmSync(directory, { recursive: true, force: true });
});

/**
 * An environment for one seeding decision: no inherited database, and a record of its own.
 *
 * The record path is a fresh temp location that holds nothing, which is the "no global-setup
 * record" state (a caller that runs a worker without one). It is never the repository's own
 * record, so these cases cannot move the database under the run that spawned this worker.
 */
function seedingEnvironment(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(path.join(tmpdir(), "llmwiki-seed-channel-"));
  seedingScratchDirectories.push(directory);
  return {
    [TEST_DATABASE_HANDOFF_FILE_ENV_VAR]: path.join(directory, "test-database.json"),
  } as NodeJS.ProcessEnv;
}

describe("the setup file is the only channel that seeds a worker", () => {
  it("seeds the caller's explicit URL when this run published no record", () => {
    // The regression the collapse could have caused: with the static seed gone, an operator's
    // explicit override must still reach the code under test, record or no record.
    const env = seedingEnvironment();
    env[TEST_DATABASE_URL_ENV_VAR] = UNREACHABLE_URL;

    expect(publishTestDatabaseUrl(env)).toBe(UNREACHABLE_URL);
    expect(env[AKS_DATABASE_URL_ENV_VAR]).toBe(UNREACHABLE_URL);
  });

  it("adopts the URL this run recorded when the caller gave no override", () => {
    const env = seedingEnvironment();
    writeTestDatabaseHandoff(
      buildHandoff({ source: "container", url: RECORDED_URL, container: null, reused: false }),
      env,
    );

    expect(publishTestDatabaseUrl(env)).toBe(RECORDED_URL);
    // Both variables, always: publishing into one splits the run in two (see the module's header).
    expect(env[AKS_DATABASE_URL_ENV_VAR]).toBe(RECORDED_URL);
    expect(env[TEST_DATABASE_URL_ENV_VAR]).toBe(RECORDED_URL);
  });

  it("keeps the documented local default when there is neither a record nor an override", () => {
    // This is the value the static seed in `vitest.config.ts` used to deliver to every worker of a
    // run whose record it could not read. The channel moved; the answer must not.
    const env = seedingEnvironment();

    expect(publishTestDatabaseUrl(env)).toBe(testDatabaseUrl({}));
    expect(env[AKS_DATABASE_URL_ENV_VAR]).toBe(testDatabaseUrl({}));
  });
});

describe("the hatch outranks every seed, and the runner seeds none", () => {
  it("removes a seeded URL from a worker of a run that declared it has no database", () => {
    const env = seedingEnvironment();
    env[TEST_DATABASE_URL_ENV_VAR] = UNREACHABLE_URL;
    env[DATABASE_OPT_OUT_ENV_VAR] = "1";
    env[AKS_DATABASE_URL_ENV_VAR] = UNREACHABLE_URL;

    expect(publishTestDatabaseUrl(env)).toBeUndefined();
    // DELETED, not blanked: an empty value reads as "use the vendored default" to production code.
    expect(AKS_DATABASE_URL_ENV_VAR in env).toBe(false);
  });

  it("seeds no database URL statically in the runner configuration", () => {
    // The pin against the defect returning: one channel, and it is the setup file.
    const seeded = (vitestConfig.test?.env ?? {}) as Record<string, unknown>;

    expect(seeded[AKS_DATABASE_URL_ENV_VAR]).toBeUndefined();
  });
});
