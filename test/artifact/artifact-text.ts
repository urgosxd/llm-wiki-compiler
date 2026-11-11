/**
 * @file test/artifact/artifact-text.ts
 * @description The shared "read a built artefact as TEXT" step for the artifact suites: repository
 * root, the build command every failure names, and one reader that refuses a missing or empty file.
 *
 * ## Why built artefacts are read as text and not imported
 *
 * A build output exists only after `corepack pnpm run build`, and the `test-typecheck` CI job
 * installs without ever building. A literal dynamic import of a relative `dist` path therefore
 * needs a suppression in a file whose whole job is to be believable, and a static analyser reports
 * the specifier as an unresolved import on a tree where the artefact is legitimately absent. These
 * assertions are about what a bundle CONTAINS, so reading its bytes is both the more honest subject
 * and free of that problem.
 *
 * ## Why it is a module instead of a paragraph copied into each suite
 *
 * The root resolution and the read step are the same three lines every artifact suite needs, and a
 * verbatim second copy of them in `test/artifact/bundle-engine.test.ts` formed a 10-line clone group
 * against `test/artifact/facade-surface.test.ts` that `fallow --gate new-only` reported against the
 * commit hook. The intent is unchanged; the bytes are written once. `facade-surface.test.ts` keeps
 * its own copy on purpose: it also carries a comment stripper and a declaration walker, which
 * belong to that file and to no other.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Repository root, taken from this file's own location rather than the caller's working directory. */
export const ARTIFACT_REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * The command that produces every artefact these helpers read, quoted in each failure.
 *
 * Exported because more than one artifact suite names it in a failure message, and a second
 * literal in `test/artifact/entries-load.test.ts` was exactly the duplication this module
 * exists to remove — `entries-load` EVALUATES its bundles rather than reading them as text,
 * so {@link readArtifactText} is not its step, but the repository root and this command are.
 */
export const ARTIFACT_BUILD_COMMAND = "corepack pnpm run build";

/**
 * Read one repository-relative artefact, failing with the build command named when it is absent.
 *
 * An absent or empty artefact is a FAILURE, never a skip: a skip here would report a change as
 * proved while asserting nothing about the bytes it produced.
 *
 * @param relativePath - Artefact path relative to {@link ARTIFACT_REPO_ROOT}.
 * @returns The artefact's contents as text.
 * @throws Error when the artefact does not exist or is empty.
 */
export async function readArtifactText(relativePath: string): Promise<string> {
  const absolute = resolve(ARTIFACT_REPO_ROOT, relativePath);
  const info = await stat(absolute).catch(() => null);
  if ((info?.size ?? 0) <= 0) {
    throw new Error(`${relativePath} must exist and carry content; run \`${ARTIFACT_BUILD_COMMAND}\``);
  }
  return readFile(absolute, "utf8");
}
