/**
 * @file Skip an unchanged build so a test run does not pay for it.
 *
 * `test/global-setup.ts` rebuilds `dist/` and both workspace packages with tsup
 * on every vitest invocation: ~42s, of which ~36s is `packages/llmwiki-core`
 * (mostly `dts: true`). A developer running one 7ms unit file therefore waits
 * ~48s, and the same ~42s is paid again for every subsequent run.
 *
 * This module answers one question per run: "are the build outputs already
 * newer than every input they were built from?" It keys on a content hash of
 * the build inputs rather than file mtimes, because `git checkout` rewrites
 * mtimes in an order unrelated to content and would produce false rebuilds (or,
 * with a naive "output newer than input" check, false skips).
 *
 * FAIL-SAFE DIRECTION: every uncertainty rebuilds. A missing/partial/corrupt
 * stamp, an unreadable directory, or a changed hash all lead to "rebuild", never
 * to "reuse a possibly stale dist". A wrong skip silently tests the wrong code,
 * which is far worse than a slow run.
 *
 * The outputs are also checked for existence, so a `git clean` of `dist/` while
 * the stamp survives still rebuilds.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Where the stamp lives, inside the git-ignored `.llmwiki` state directory. */
export const STAMP_PATH = ".llmwiki/build-stamp.json";

/** Bump when the set of hashed inputs or outputs changes meaning. */
const STAMP_VERSION = 1;

/**
 * Directories whose file CONTENTS decide the build output. Ordered for a stable
 * hash; the walk sorts each level.
 */
const INPUT_DIRS = ["src", "packages", "scripts"];

/** Individual files outside {@link INPUT_DIRS} that also decide the build. */
const INPUT_FILES = ["tsup.config.ts", "tsconfig.json", "package.json"];

/**
 * Paths the build must have produced. Checked for existence only: a stamp that
 * claims a successful build while `dist/cli.js` is missing is treated as a miss.
 */
const REQUIRED_OUTPUTS = [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "packages/llmwiki-core/dist/index.js",
  "packages/llmwiki-local-workflows/dist/index.js",
];

/** Recorded state of the last successful build. */
interface BuildStamp {
  version: number;
  /** Hash of every input file's path + content. */
  inputsHash: string;
}

/** Extensions with no bearing on build output; skipping them keeps the hash stable. */
const IGNORED_SUFFIXES = [".tsbuildinfo", ".log", ".tmp"];

/** Directory names never worth walking. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Hash one file's path and content into `hash`. Missing files hash as absent. */
function hashFile(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  hash.update(relative);
  try {
    hash.update(readFileSync(path.join(root, relative)));
  } catch {
    hash.update("\u0000missing");
  }
}

/** Recursively hash every file under `dir`, sorted so the digest is deterministic. */
function hashDir(hash: ReturnType<typeof createHash>, root: string, dir: string): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) hashDir(hash, root, relative);
    } else if (!IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      hashFile(hash, root, relative);
    }
  }
}

/**
 * Compute the content hash of every build input.
 * @param root - Repository root.
 * @returns Hex SHA-256 over all input paths and contents.
 */
export function computeInputsHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of INPUT_FILES) hashFile(hash, root, file);
  for (const dir of INPUT_DIRS) hashDir(hash, root, dir);
  return hash.digest("hex");
}

/** Read the stored stamp, or `null` when absent, unreadable, or from another version. */
function readStamp(root: string): BuildStamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, STAMP_PATH), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const stamp = parsed as Partial<BuildStamp>;
    if (stamp.version !== STAMP_VERSION || typeof stamp.inputsHash !== "string") return null;
    return stamp as BuildStamp;
  } catch {
    return null;
  }
}

/** Record a successful build for the current inputs. */
export function writeStamp(root: string): void {
  const stamp: BuildStamp = { version: STAMP_VERSION, inputsHash: computeInputsHash(root) };
  try {
    mkdirSync(path.dirname(path.join(root, STAMP_PATH)), { recursive: true });
    writeFileSync(path.join(root, STAMP_PATH), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  } catch {
    // A stamp that cannot be written only costs a future rebuild; never fail the build.
  }
}

/** Drop the stamp so the next run rebuilds unconditionally. */
export function clearStamp(root: string): void {
  rmSync(path.join(root, STAMP_PATH), { force: true });
}

/**
 * Decide whether the existing build can be reused.
 * @param root - Repository root.
 * @returns True only when a matching stamp exists AND every output is present.
 */
export function isBuildFresh(root: string): boolean {
  const stamp = readStamp(root);
  if (!stamp) return false;
  if (!REQUIRED_OUTPUTS.every((output) => existsSync(path.join(root, output)))) return false;
  try {
    return stamp.inputsHash === computeInputsHash(root);
  } catch {
    return false;
  }
}
