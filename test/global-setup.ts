/**
 * Vitest globalSetup: build dist/ once before any test file loads.
 *
 * Several test files spawn `node dist/api.js` to exercise the launcher and the
 * viewer/MCP surfaces it carries. Without a shared setup, each file's own
 * beforeAll would call tsup, and vitest's parallel-by-default test workers would
 * race on dist/api.js (tsup's per-entry `clean` wipes the file mid-write).
 * Building once globally eliminates the race and saves ~1s per spawning file.
 *
 * THE BUILD IS SKIPPED WHEN ITS INPUTS ARE UNCHANGED. The full build costs
 * ~42s (~36s of it `packages/llmwiki-core`, mostly `dts: true`), which a
 * developer paid again on every run even to execute a single 7ms unit file. A
 * content hash of the build inputs in `.llmwiki/build-stamp.json` decides this;
 * see `scripts/build-stamp.ts`. Every uncertainty rebuilds — a stale build
 * silently tests the wrong code, which is far worse than a slow run.
 *
 * Set `LLMWIKI_TEST_FORCE_BUILD=1` to bypass the cache entirely, e.g. after
 * suspecting a stale artifact.
 *
 * Invokes tsup's CLI with the Node binary ALREADY running this process, rather
 * than through `npx`. On Windows `npx` is `npx.cmd`, and since the Node 22
 * hardening for CVE-2024-27980 `child_process` no longer resolves `.cmd`/`.bat`
 * without `shell: true` — so `execFile("npx", …)` failed with ENOENT there,
 * aborting collection before a single test loaded. vitest then reported the
 * confusingly unrelated "No test files found", which points nowhere near the
 * cause. CI is Linux-only today, so nothing caught it.
 *
 * `shell: true` would also fix it, but re-opens the argument-quoting hole that
 * hardening closed. Resolving the CLI entry and running it directly needs no
 * shell at all and behaves identically on every platform.
 *
 * ## The database, and why its resolution lives in a fixture
 *
 * Database-backed suites used to run against whatever Postgres the machine happened to have, and
 * SKIPPED when there was none — so CI could be green while asserting nothing. This setup now
 * resolves ONE pgvector container per run and publishes its URL in `.llmwiki/test-database.json`
 * for every worker to read (`test/setup/test-database-url.ts`).
 *
 * Resolution order is owned by `test/fixtures/testcontainers-postgres.ts`: an explicit
 * `LLMWIKI_TEST_DATABASE_URL` wins and starts nothing, `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` opts out of
 * a container entirely, otherwise a reusable container is started (or the one an earlier run left
 * behind is adopted). Resolution NEVER throws here: an unobtainable database is recorded as
 * `unavailable` with its reason, and the loud failure is raised by the database chokepoint.
 *
 * `teardown` gives the container back, but deliberately leaves a reusable one running: stopping it
 * would delete it (`stop()` implies `remove`) and throw away the ~1.4 s the next run would pay.
 */

import { execFile } from "child_process";
import { resolveTsupCli } from "../scripts/tsup-command.js";
import { clearStamp, isBuildFresh, writeStamp } from "../scripts/build-stamp.js";
import { publishSharedTestDatabase, releaseSharedTestDatabase } from "./fixtures/testcontainers-postgres.js";
import { promisify } from "util";
import path from "path";

const exec = promisify(execFile);

/** Escape hatch for a deliberately forced rebuild. */
const FORCE_BUILD_ENV_VAR = "LLMWIKI_TEST_FORCE_BUILD";

/** True when the caller asked to bypass the cache. */
function forcedBuild(): boolean {
  return process.env[FORCE_BUILD_ENV_VAR] === "1";
}

/** Build once, then record the inputs it was built from. */
async function build(root: string): Promise<void> {
  await exec(process.execPath, [resolveTsupCli()], { cwd: root });
  writeStamp(root);
}

/** Build dist/ unless the recorded inputs are unchanged. */
async function prepareBuild(): Promise<void> {
  const root = path.resolve(".");
  if (!forcedBuild() && isBuildFresh(root)) return;
  // Clear first so a failed build cannot leave a stamp that claims success.
  clearStamp(root);
  await build(root);
}

/**
 * Resolve this run's database, then build once. Both are needed before any test file loads.
 *
 * The database is resolved first so its log line is the first thing a failing run prints, and
 * because a 120 ms adoption is cheap next to a 40 s rebuild. Resolution logs its own outcome,
 * including the reason when nothing answered, and never throws.
 */
export async function setup(): Promise<void> {
  await publishSharedTestDatabase();
  await prepareBuild();
}

/** Give the database container back when the run ends. Safe when setup started nothing. */
export async function teardown(): Promise<void> {
  await releaseSharedTestDatabase();
}
