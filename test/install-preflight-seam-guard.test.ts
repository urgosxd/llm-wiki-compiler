/**
 * @file Guard the seams that keep the install preflight the FIRST thing a broken checkout sees.
 *
 * `test/global-setup.ts` runs an install preflight before anything else, defers every
 * workspace-reaching import into the functions that use them, and gates `teardown()` on
 * the preflight verdict. Nothing committed went red if either seam was undone, and the
 * regression each one restores is the misleading `Cannot find package
 * '@repo/kg/testing/per-run-database'` banner the preflight exists to replace — printed
 * either while the setup module is still LOADING (a hoisted import) or in a second banner
 * beneath the refusal (an ungated teardown).
 *
 * So this file asserts nothing about the source's shape. It spawns
 * `test/fixtures/install-preflight-child.mjs`, which runs the REAL setup module and
 * prints what happened, and it asserts on that child's real output only. A pattern
 * match on `await import(` would pass while a seam moved one line down; a behavioural
 * child cannot.
 *
 * THE CLASS, NOT THE MODULES. What is guarded is a top-level import of a
 * workspace-provided package anywhere in the setup's module graph, because every such
 * edge is evaluated before `setup()` can speak. `test/fixtures/testcontainers-postgres.js`
 * is merely the only live member of that class today: `scripts/build-stamp.ts` and
 * `scripts/tsup-command.ts` reach `tsup` through `createRequire` inside a function and
 * their top-level imports are builtins-only, so hoisting either of them is behaviourally
 * inert. A future top-level `import … from "@repo/…"` in that graph goes red here the day
 * it lands.
 *
 * THE TREE UNDER TEST IS THE CHILD'S WORKING DIRECTORY. The preflight resolves every
 * repo-relative probe path against `path.resolve(".")`, so a temporary cwd is a
 * temporary tree and no production surface was added to make this testable. That is also
 * why `node_modules/@repo/kg` is NEVER moved aside: an interrupted run would leave a
 * broken install, which is worse than the gap. `test/fixtures/deny-uninstalled-packages.mjs`
 * makes the temporary tree authoritative for resolution instead.
 *
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is deliberate and narrow: this guard tests the
 * INSTALL path, not the database path, and a container would only add a variable to a
 * test about neither. The handoff record is relocated into the temporary root for the
 * same reason it exists — a nested run owns a record of its own — so nothing is written
 * under the repository, and every temporary root is removed in a `finally`.
 *
 * INTEGRATION TIER BY THE REPOSITORY'S OWN CLASSIFIER: `scripts/test-partition.ts`
 * classifies a file that contains `spawnSync(` as integration, which is correct — the
 * behaviour under test lives in a spawned process, not in this one.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isBuildFresh } from "../scripts/build-stamp.js";
import { WORKSPACE_PACKAGES, diagnoseInstallTree } from "./fixtures/install-preflight.js";

/** Repository root, one level above this file. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The real setup module the child runs, repo-relative. The driver imports it by a literal specifier. */
const SETUP_MODULE = "test/global-setup.ts";

/** The child driver that runs it, repo-relative. */
const CHILD_DRIVER = "test/fixtures/install-preflight-child.mjs";

/** The build stamp that makes the child's build step inert, repo-relative. */
const BUILD_STAMP = ".llmwiki/build-stamp.json";

/** The database handoff record, relocated into each temporary root. */
const HANDOFF_FILE = ".llmwiki/test-database.json";

/** Opts a nested run out of a container. */
const NO_DATABASE_ENV_VAR = "LLMWIKI_TEST_ALLOW_NO_DATABASE";

/** Relocates the handoff record so a nested run cannot overwrite the outer run's. */
const HANDOFF_FILE_ENV_VAR = "LLMWIKI_TEST_DB_HANDOFF_FILE";

/** A forced rebuild would replace "the build is skipped" with a 40 s build inside the temp root. */
const FORCE_BUILD_ENV_VAR = "LLMWIKI_TEST_FORCE_BUILD";

/** An explicit URL would make the nested run probe somebody's server. */
const EXPLICIT_DATABASE_ENV_VAR = "LLMWIKI_TEST_DATABASE_URL";

/** Stable fragment of the refusal a tree with no install reaches. */
const NO_PNPM_FRAGMENT = "Found no node_modules/.pnpm";

/** Stable fragment of the one command that repairs it. */
const INSTALL_COMMAND_FRAGMENT = "corepack pnpm install --frozen-lockfile";

/** The literal whose occurrence count must equal the refusal's own count. */
const CANNOT_FIND_PACKAGE = "Cannot find package";

/** Node's own code for that error; the refusal must not produce it anywhere. */
const ERR_MODULE_NOT_FOUND = "ERR_MODULE_NOT_FOUND";

/** Vitest's failure banner. See the assertion that checks it for why it is belt-and-braces. */
const STARTUP_ERROR = "Startup Error";

/** Printed by the driver once `setup()` returned. */
const SETUP_OK = "SETUP-OK";

/** Printed by the driver once `teardown()` returned. */
const TEARDOWN_OK = "TEARDOWN-OK";

/** Tree-level entries the symlinked healthy root shares with the repository. */
const SHARED_DIRS = ["src", "packages", "scripts", "dist"];

/** Individual files the build stamp hashes, symlinked for the same reason. */
const SHARED_FILES = ["tsup.config.ts", "tsconfig.json", "package.json"];

/** A child imports a module graph and skips a build inside this budget, with room to spare. */
const CHILD_TIMEOUT_MS = 180_000;

/**
 * Count non-overlapping occurrences of a literal.
 *
 * @param haystack - Text to search.
 * @param needle - Literal to count, never a pattern.
 * @returns How many times the literal appears.
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The refusal an install-free tree must produce, taken from the preflight itself.
 *
 * Deriving the message instead of quoting it is what makes the count assertion in the
 * broken case a comparison against the code under test rather than a memorised number.
 *
 * @returns The exact message the preflight emits for a directory with nothing in it.
 */
function refusalMessage(): string {
  const verdict = diagnoseInstallTree([]);
  if (verdict.ok) {
    throw new Error("an empty tree is no longer refused, so the install preflight stopped diagnosing a bare checkout");
  }
  return verdict.message;
}

/**
 * Path of the repository's build stamp, or a failure that names the real cause.
 *
 * `test/global-setup.ts` writes the stamp before any test runs, so a suite executed
 * through vitest always has one. Without it the healthy child would rebuild instead of
 * standing still, and this test would measure the build rather than the preflight.
 *
 * @returns Absolute path of the stamp the healthy root copies.
 */
function repositoryStamp(): string {
  const stamp = path.join(REPO_ROOT, BUILD_STAMP);
  if (!existsSync(stamp)) {
    throw new Error(
      `${BUILD_STAMP} is missing: ${SETUP_MODULE} writes it before any test runs, so run this file through vitest.`,
    );
  }
  return stamp;
}

/**
 * Link one repository entry into a temporary root, when the repository has it.
 *
 * `src` is listed by the build stamp's inputs but no longer exists at the repository
 * root, and an absent directory hashes as absent on both sides, so skipping it keeps
 * the two hashes equal.
 *
 * @param root - Temporary root being built.
 * @param entry - Repo-relative entry to share.
 * @param kind - `"dir"` or `"file"`, as `symlinkSync` takes it.
 */
function linkSharedEntry(root: string, entry: string, kind: "dir" | "file"): void {
  const source = path.join(REPO_ROOT, entry);
  if (existsSync(source)) symlinkSync(source, path.join(root, entry), kind);
}

/**
 * Build a tree the preflight accepts whose build step is provably inert.
 *
 * The four `@repo/*` links and `node_modules/.pnpm` are exactly what the diagnosis
 * looks for. Everything the build needs is shared with the repository by symlink and the
 * stamp is copied byte for byte, so `isBuildFresh` sees the repository's own inputs and
 * skips the build instead of writing `dist/` anywhere.
 *
 * @returns Absolute path of the new temporary root.
 */
function buildHealthyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "llmwiki-seam-guard-healthy-"));
  mkdirSync(path.join(root, "node_modules/.pnpm"), { recursive: true });
  for (const name of WORKSPACE_PACKAGES) {
    mkdirSync(path.join(root, "node_modules/@repo", name), { recursive: true });
  }
  linkSharedEntry(root, "node_modules/@testcontainers", "dir");
  for (const dir of SHARED_DIRS) linkSharedEntry(root, dir, "dir");
  for (const file of SHARED_FILES) linkSharedEntry(root, file, "file");
  mkdirSync(path.join(root, ".llmwiki"), { recursive: true });
  copyFileSync(repositoryStamp(), path.join(root, BUILD_STAMP));
  return root;
}

/**
 * Environment for a nested setup run: the parent's, minus what would change the subject.
 *
 * @param root - Temporary root the child runs against.
 * @returns The child's environment.
 */
function childEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [NO_DATABASE_ENV_VAR]: "1",
    [HANDOFF_FILE_ENV_VAR]: path.join(root, HANDOFF_FILE),
  };
  delete env[FORCE_BUILD_ENV_VAR];
  delete env[EXPLICIT_DATABASE_ENV_VAR];
  return env;
}

/**
 * Run the real setup in a child whose working directory is `root`.
 *
 * Synchronous on purpose: a spawned process cannot outlive the assertion that spawned
 * it, so a failed case cannot leave a child behind still holding the temporary tree.
 *
 * @param root - Temporary root to probe.
 * @returns The child's exit status, and its stdout and stderr joined.
 */
function runChild(root: string): { status: number | null; output: string } {
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, CHILD_DRIVER)], {
    cwd: root,
    env: childEnvironment(root),
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  return { status: child.status, output: `${child.stdout ?? ""}${child.stderr ?? ""}` };
}

describe("install preflight, through the real setup in a child process", () => {
  it("refuses a tree with no install, and prints nothing else", () => {
    const root = mkdtempSync(path.join(tmpdir(), "llmwiki-seam-guard-broken-"));
    try {
      const refusal = refusalMessage();
      const child = runChild(root);
      expect(child.status).not.toBe(0);
      expect(child.output).toContain(NO_PNPM_FRAGMENT);
      expect(child.output).toContain(INSTALL_COMMAND_FRAGMENT);
      expect(child.output).toContain(refusal);
      // The count, not a substring check, is what subsumes a second banner: one extra
      // workspace failure anywhere in the output — a hoisted import dying at load, or an
      // ungated teardown re-raising the same error — makes this larger than the refusal's own.
      expect(occurrences(child.output, CANNOT_FIND_PACKAGE)).toBe(occurrences(refusal, CANNOT_FIND_PACKAGE));
      expect(child.output).not.toContain(ERR_MODULE_NOT_FOUND);
      // Belt-and-braces only: this driver is not vitest, so no `Startup Error` banner can
      // exist here. The count above is the assertion that would catch the shape such a
      // banner takes; this line keeps the symptom named where the guard is read.
      expect(child.output).not.toContain(STARTUP_ERROR);
      // Teardown runs on a refused tree (vitest awaits it even when setup threw) and must
      // release nothing, because the database was never resolved.
      expect(child.output).toContain(TEARDOWN_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a healthy tree through, and setup really proceeds", () => {
    const root = buildHealthyRoot();
    try {
      // Measured precondition, not decoration: if the symlinked tree stopped satisfying the
      // build stamp, the child would rebuild inside the temporary root and this test would
      // stop measuring the preflight at all. No production skip flag may fix that.
      expect(isBuildFresh(root), "isBuildFresh rejected the symlinked healthy tree").toBe(true);
      const child = runChild(root);
      expect(child.status).toBe(0);
      expect(child.output).not.toContain(NO_PNPM_FRAGMENT);
      expect(child.output).not.toContain(INSTALL_COMMAND_FRAGMENT);
      expect(child.output).toContain(SETUP_OK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS);
});
