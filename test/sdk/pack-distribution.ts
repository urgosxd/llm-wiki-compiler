/**
 * @file test/sdk/pack-distribution.ts
 * @description Which package directories ship to npm, and the derivation that keeps the list honest.
 *
 * The distribution list used to be a hand-maintained literal duplicated in two
 * places, and it drifted twice without anything failing: `packaging.test.ts`
 * kept `packages/llmwiki-local-workflows` after `0374a5f` deleted the package,
 * and `.github/workflows/publish.yml` carried its own stale copy. Neither was
 * caught, because a stale entry only breaks the slow, network-dependent
 * `test:pack` tier, which is not part of the default run.
 *
 * So the truth is DERIVED instead of restated: a workspace ships when its
 * manifest exists and is not `private`, and the root package ships because it is
 * the published artefact. Once the core stopped being a package there was no
 * publishable workspace left, so the derived list is the root package on its own. `pack-distribution.test.ts` compares that derived set
 * against {@link PACK_DISTRIBUTION} on every unit run, so a manifest that
 * changes publishability — or a package directory that disappears — without a
 * matching list edit turns the suite red.
 *
 * `derivePackDistribution` answers "what is publishable right now", and
 * {@link readPublishPackageDirs} answers "what the release workflow intends to
 * publish". The test compares the two answers instead of trusting a third
 * hand-maintained copy.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Package directories packed for distribution, relative to the repository root:
 * the root package ALONE.
 *
 * `@atomicstrata/llmwiki-core` used to be listed first, and the root tarball was
 * only installable because that second tarball was installed beside it. The
 * collapse of the core into `packages/wiki` (spec S2 of
 * `odd/tasks/collapse-core-package.md`) leaves exactly one published artefact,
 * and `packaging.test.ts` now proves it installs with nothing beside it.
 */
export const PACK_DISTRIBUTION: readonly string[] = ["."];

/** The workflow whose `PACKAGE_DIRS` value must agree with the derived distribution. */
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";

/**
 * Raised when the publish workflow's package list cannot be read reliably.
 *
 * Every failure below is an error rather than an empty result: a textual parse
 * that silently yields nothing would make the distribution comparison pass on
 * nothing, which is the exact blindness this module exists to remove.
 */
class PublishPackageDirsError extends Error {
  /** @param reason - What is wrong with the workflow's `PACKAGE_DIRS`, for the caller's message. */
  constructor(reason: string) {
    super(`cannot read PACKAGE_DIRS from ${PUBLISH_WORKFLOW_PATH}: ${reason}`);
    this.name = "PublishPackageDirsError";
  }
}

/** The subset of a package manifest this module reads. */
interface DistributionManifest {
  workspaces?: unknown;
  private?: boolean;
}

/** Read one manifest, naming the file it looked for so a missing one is actionable. */
function readManifest(manifestPath: string): DistributionManifest {
  if (!existsSync(manifestPath)) throw new Error(`no package manifest at ${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as DistributionManifest;
}

/** Read a workspace's manifest, refusing a directory that cannot be published as an error. */
function readWorkspaceManifest(repoRoot: string, directory: string): DistributionManifest {
  const manifestPath = path.join(repoRoot, directory, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`workspace "${directory}" has no package.json`);
  return readManifest(manifestPath);
}

/** The root `workspaces` field, validated because the derivation depends on it being literal paths. */
function readWorkspaceDirectories(repoRoot: string): string[] {
  const { workspaces } = readManifest(path.join(repoRoot, "package.json"));
  if (!Array.isArray(workspaces)) throw new Error("root package.json has no workspaces array");
  return workspaces.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Derive the package directories that actually ship, from the filesystem.
 *
 * @param repoRoot - Absolute repository root.
 * @returns Publishable workspaces in declaration order, then the root facade.
 */
export function derivePackDistribution(repoRoot: string): string[] {
  const publishable = readWorkspaceDirectories(repoRoot)
    .filter(directory => readWorkspaceManifest(repoRoot, directory).private !== true);
  return [...publishable, "."];
}

/** Read the workflow as text, so a missing or unreadable file is an error and not a skip. */
function readWorkflowText(repoRoot: string): string {
  try {
    return readFileSync(path.join(repoRoot, PUBLISH_WORKFLOW_PATH), "utf8");
  } catch (error) {
    throw new PublishPackageDirsError(`file is unreadable (${(error as Error).message})`);
  }
}

/** Strip one layer of matching YAML quotes from an inline scalar. */
function stripYamlQuotes(value: string): string {
  const quote = value.charAt(0);
  const isQuoted = value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote);
  return isQuoted ? value.slice(1, -1) : value;
}

/**
 * Read the `PACKAGE_DIRS` value the publish workflow exports.
 *
 * Parsed as text on purpose: this module ships without a YAML dependency, and a
 * pattern that matches nothing must throw rather than report an empty list.
 *
 * @param repoRoot - Repository root containing {@link PUBLISH_WORKFLOW_PATH}.
 * @returns The package directories, in the order the workflow publishes them.
 */
export function readPublishPackageDirs(repoRoot: string): string[] {
  const match = /^[ \t]*PACKAGE_DIRS:[ \t]*(.*)$/m.exec(readWorkflowText(repoRoot));
  if (match === null) throw new PublishPackageDirsError("the workflow has no PACKAGE_DIRS key");
  const value = stripYamlQuotes((match[1] ?? "").trim());
  if (value === "") throw new PublishPackageDirsError("the value is empty");
  const entries = value.split(/[ \t]+/).filter(entry => entry !== "");
  // ONE directory is the post-collapse shape: the root package is the whole
  // distribution. Zero is still an error, because a value that parsed to nothing
  // would make the comparison below pass on an empty workflow.
  if (entries.length < 1) {
    throw new PublishPackageDirsError(`expected at least one directory, parsed ${JSON.stringify(entries)}`);
  }
  return entries;
}
