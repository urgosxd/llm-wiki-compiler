/**
 * Vitest globalSetup: build dist/ once before any test file loads.
 *
 * Several test files spawn `node dist/api.js` to exercise the launcher and the
 * viewer/MCP surfaces it carries. Without a shared setup, each file's own
 * beforeAll would call tsup, and vitest's parallel-by-default test workers would
 * race on dist/api.js (tsup's per-entry `clean` wipes the file mid-write).
 * Building once globally eliminates the race and saves ~1s per spawning file.
 *
 * THE BUILD IS SKIPPED WHEN ITS INPUTS ARE UNCHANGED. The full build used to cost
 * ~42s (~36s of it the separately-built `packages/llmwiki-core`, mostly `dts: true`),
 * which a developer paid again on every run even to execute a single 7ms unit file.
 * `odd/tasks/collapse-core-package.md` deleted that package, so one root build is the
 * whole distribution; the skip still matters, and it now actually happens — while that
 * package existed, `scripts/build-stamp.ts` also REQUIRED its `dist/index.js`, so the
 * freshness check was a permanent miss and every run rebuilt regardless. A content hash
 * of the build inputs in `.llmwiki/build-stamp.json` decides this; see
 * `scripts/build-stamp.ts`. Every uncertainty rebuilds — a stale build silently tests
 * the wrong code, which is far worse than a slow run.
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
 *
 * ## The install preflight, and why it runs first
 *
 * A checkout pnpm did not install fails while THIS MODULE IS BEING LOADED, not while it runs: a
 * static import of the database fixture reaches `@repo/kg/testing/per-run-database`, and ESM
 * evaluates every static import before the module body, so a guard written inside `setup()` was
 * dead code. Hence the two halves: the preflight is the first statement of `setup()`, and the three
 * project-internal imports — tsup, the build stamp and the database fixture — became `await import()`
 * inside the functions that use them, so no static edge reaches the workspace ahead of the guard.
 * The decision itself is pure (`test/fixtures/install-preflight.ts`); this file only reads paths.
 * There is deliberately NO environment-variable opt-out: an uninstallable tree can never pass a
 * test, so an escape hatch would only hide the diagnosis and restore the misleading error.
 *
 * `teardown` IS GATED ON THE SAME VERDICT, and that gate is load-bearing. vitest records a project's
 * globalSetup handles BEFORE `setup()` throws and still awaits the matching `teardown()`, so on a
 * refused tree teardown would run against the workspace imports the refusal exists to spare us —
 * and its `await import("./fixtures/testcontainers-postgres.js")` re-emitted `Cannot find package
 * '@repo/kg/testing/per-run-database'` in a second banner beneath the refusal, restoring the exact
 * confusion the preflight replaced. Nothing to release exists when the preflight refused, because
 * the database was never resolved.
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import path from "path";
import { diagnoseInstallTree, installProbePaths } from "./fixtures/install-preflight.js";

const exec = promisify(execFile);

/** Escape hatch for a deliberately forced rebuild. */
const FORCE_BUILD_ENV_VAR = "LLMWIKI_TEST_FORCE_BUILD";

/** True when the caller asked to bypass the cache. */
function forcedBuild(): boolean {
  return process.env[FORCE_BUILD_ENV_VAR] === "1";
}

/** Repo-relative paths that exist right now, in the shape the diagnosis expects. */
function presentInstallPaths(): string[] {
  const root = path.resolve(".");
  return installProbePaths().filter((relative) => existsSync(path.resolve(root, relative)));
}

/**
 * Set only when the preflight accepted the tree.
 *
 * `teardown` must not reach a workspace import when the preflight refused, so the acceptance has to
 * outlive `setup()`; a local verdict cannot tell the two teardown calls apart.
 */
let installPreflightPassed = false;

/** Refuse a checkout pnpm did not install, before anything else can fail confusingly. */
function assertInstalledWithPnpm(): void {
  const verdict = diagnoseInstallTree(presentInstallPaths());
  if (!verdict.ok) throw new Error(verdict.message);
  installPreflightPassed = true;
}

/**
 * Build once, then record the inputs it was built from.
 *
 * Both imports are deferred so this module can load on a tree the workspace has not installed.
 */
async function build(root: string): Promise<void> {
  const { resolveTsupCli } = await import("../scripts/tsup-command.js");
  const { writeStamp } = await import("../scripts/build-stamp.js");
  await exec(process.execPath, [resolveTsupCli()], { cwd: root });
  writeStamp(root);
}

/** Build dist/ unless the recorded inputs are unchanged. */
async function prepareBuild(): Promise<void> {
  const { clearStamp, isBuildFresh } = await import("../scripts/build-stamp.js");
  const root = path.resolve(".");
  if (!forcedBuild() && isBuildFresh(root)) return;
  // Clear first so a failed build cannot leave a stamp that claims success.
  clearStamp(root);
  await build(root);
}

/**
 * Refuse an uninstalled tree, then resolve this run's database and build once.
 *
 * The preflight comes before both because the database fixture is a workspace import: without the
 * guard, a tree pnpm never installed fails while this module is still loading.
 *
 * The database is resolved before the build so its log line is the first thing a failing run
 * prints, and because a 120 ms adoption is cheap next to a 40 s rebuild. Resolution logs its own
 * outcome, including the reason when nothing answered, and never throws.
 */
export async function setup(): Promise<void> {
  assertInstalledWithPnpm();
  const { publishSharedTestDatabase } = await import("./fixtures/testcontainers-postgres.js");
  await publishSharedTestDatabase();
  await prepareBuild();
}

/** Give the database container back when the run ends. Safe when setup started nothing. */
export async function teardown(): Promise<void> {
  // vitest still calls teardown when setup() threw, and the import below would re-raise the very
  // "Cannot find package '@repo/…'" error this preflight exists to replace.
  if (!installPreflightPassed) return;
  const { releaseSharedTestDatabase } = await import("./fixtures/testcontainers-postgres.js");
  await releaseSharedTestDatabase();
}
