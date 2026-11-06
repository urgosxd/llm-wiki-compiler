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
 * the published facade. `pack-distribution.test.ts` compares that derived set
 * against {@link PACK_DISTRIBUTION} on every unit run, so a manifest that
 * changes publishability — or a package directory that disappears — without a
 * matching list edit turns the suite red.
 *
 * The same helper is written to be reusable by a future `publish.yml` check:
 * `derivePackDistribution` answers "what is publishable right now", and a test
 * asserting the workflow's `PACKAGE_DIRS` literal would compare against this
 * one answer rather than against a third hand-maintained copy.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Package directories packed for distribution, relative to the repository root:
 * the core SDK workspace plus the root facade package.
 */
export const PACK_DISTRIBUTION: readonly string[] = ["packages/llmwiki-core", "."];

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
