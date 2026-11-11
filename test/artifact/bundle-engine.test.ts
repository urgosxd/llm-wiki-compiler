/**
 * @file test/artifact/bundle-engine.test.ts
 * @description The shipped root bundle carries the engine, and the quiet scope has one
 * owner per package (specs S3 and S4 of `odd/tasks/collapse-core-package.md`).
 *
 * ## "The engine is inside `dist/index.js`", measured instead of described
 *
 * At base — before the collapse — `dist/index.js` is a 108,001-byte facade containing
 * ZERO occurrences of `resolveDimensions`, because `tsup.config.ts` externalizes
 * `@atomicstrata/llmwiki-core` and the engine ships in that package's 830,536-byte
 * chunk. The facade's whole engine surface is one import statement:
 * `import { withQuiet, createWikiCoreAtRoot } from "@atomicstrata/llmwiki-core/compiler-sdk";`.
 * After the collapse the root artefact is the only artefact, so the engine's symbols
 * must be DEFINED here and that specifier must be gone.
 *
 * ## Why the symbols are read out of the dimensions source first
 *
 * Naming engine symbols by hand pins a list that a rename can rot. Each symbol below is
 * first looked for in `packages/wiki/src/dimensions/activation.ts`, so a rename fails
 * here with the source as the reason instead of leaving an assertion about a name
 * nothing exports any more. No byte threshold appears anywhere in this file: sizes
 * belong in the change report and the feature document's Log, never in a magic number.
 *
 * ## Why the quiet-scope half is structural, and what it does NOT prove
 *
 * T2 re-points the removed core's `./compiler-sdk` at the root package, so
 * `withQuiet` keeps a published door; the BEHAVIOURAL half of S4 is exercised in
 * `test/sdk/packaging.test.ts` against the installed tarball. This file asserts the part
 * behaviour cannot reach. Measured: every `WikiCore` method is already wrapped in
 * `runQuiet` (`packages/wiki/src/sdk/core.ts:59`, applied `:96`-`:212`), so no public SDK
 * operation emits whether or not a quiet scope is open, and a duplicate
 * `AsyncLocalStorage` would therefore pass any stream assertion. The property that can be
 * checked and would actually break is the quiet scope's OWNERSHIP: `var quietScope =
 * new AsyncLocalStorage()` must be constructed once per bundle (`dist/index.js`,
 * `dist/api.js`) and `dist/compiler-sdk.js` must construct none at all, because with
 * `splitting: false` it would inline a second copy and quiet entered through the subpath
 * would silently not apply to the engine in `dist/index.js`. Base measurement: three built
 * bundles construct it — `dist/index.js`, `dist/api.js` and
 * `packages/llmwiki-core/dist/chunk-MFKTX3BK.js` — so a root-tarball installation plus its
 * dependency holds two quiet scopes. After the collapse only the root package does.
 *
 * `new AsyncLocalStorage` is deliberately NOT counted to a fixed number: one bundle may
 * construct several scopes for unrelated reasons (`quietScope`, `verboseScope`, the
 * prompt-modifier stack), and base measurements are 2 in `dist/index.js` and 6 in
 * `dist/api.js`. The invariant is the quiet scope's OWNER, not a total.
 *
 * ## Why the artefact reader lives in `artifact-text.ts`
 *
 * The repository root and the "read the artefact's text, or fail with the build command named" step
 * are the same ones `facade-surface.test.ts` spells out inline, and keeping a second verbatim copy
 * here made the two suites a 10-line clone group under `fallow --gate new-only`, which the commit
 * hook reports as an introduced finding. The assertions are untouched; the shared bytes are written
 * once in `test/artifact/artifact-text.ts`.
 *
 * ## Precondition
 *
 * The build must have run (`corepack pnpm run build`); the suite's global setup does it.
 * A missing artefact fails with that command named rather than skipping: a skip here
 * would report a collapse as proved while asserting nothing.
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_REPO_ROOT as REPO_ROOT, readArtifactText } from "./artifact-text.js";

/** The bundle the published library entry resolves to, and the subject of S3. */
const ROOT_BUNDLE = "dist/index.js";

/** The container launcher that ships in the same tarball. */
const LAUNCHER_BUNDLE = "dist/api.js";

/**
 * The subpath T2 re-points at the root package, built from
 * `packages/wiki/src/sdk/compiler-composition.ts`.
 *
 * It is the successor to the core's own `./compiler-sdk`, which the collapse deletes, and
 * it exists because S4 forbids removing an embedder's only door to `withQuiet` while
 * asserting quiet some other way. It is a REPLACEMENT, not new surface.
 */
const COMPILER_SDK_BUNDLE = "dist/compiler-sdk.js";

/** The value exports `dist/compiler-sdk.js` must publish, exactly. */
const COMPILER_SDK_VALUES: readonly string[] = ["createWikiCoreAtRoot", "withQuiet"];

/** The specifier the collapse removes; no shipped bundle may import it any more. */
const COLLAPSED_SPECIFIER = "@atomicstrata/llmwiki-core";

/** The source the engine symbols are validated against before they are looked for. */
const ENGINE_SOURCE = "packages/wiki/src/dimensions/activation.ts";

/** Symbols the ingest path cannot work without, each declared in {@link ENGINE_SOURCE}. */
const ENGINE_SYMBOLS: readonly string[] = ["resolveDimensions", "createDimensionsDatabase"];

/** The exported-function declaration that makes an engine symbol real in its source. */
const SOURCE_DECLARATION = "export function";

/** The quiet scope's storage construction, as a bundled ESM output emits it. */
const QUIET_SCOPE_PATTERN = "(?:var|let|const)\\s+quietScope\\d*\\s*=";

/**
 * Every `.js` file under a directory, recursively, with its repository-relative path.
 *
 * @param relativeDirectory - Directory to walk, repository-relative.
 * @returns The bundles found, in no particular order.
 */
async function bundlesUnder(relativeDirectory: string): Promise<Array<{ path: string; text: string }>> {
  const absolute = path.join(REPO_ROOT, relativeDirectory);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  const found: Array<{ path: string; text: string }> = [];
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await bundlesUnder(relative)));
      continue;
    }
    if (entry.name.endsWith(".js")) found.push({ path: relative, text: await readFile(path.join(REPO_ROOT, relative), "utf8") });
  }
  return found;
}

/**
 * Every directory in this checkout that holds a built bundle set, repository-relative.
 *
 * Discovered rather than listed so a package that starts shipping a bundle is judged by
 * the same rule as the two that do today.
 *
 * @returns The directories that exist, including the root `dist` when it is built.
 */
async function bundleDirectories(): Promise<string[]> {
  const candidates = ["dist"];
  const packages = await readdir(path.join(REPO_ROOT, "packages"), { withFileTypes: true }).catch(() => []);
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    candidates.push(`packages/${entry.name}/dist`);
    const nested = await readdir(path.join(REPO_ROOT, "packages", entry.name), { withFileTypes: true }).catch(() => []);
    for (const child of nested) {
      if (child.isDirectory()) candidates.push(`packages/${entry.name}/${child.name}/dist`);
    }
  }
  const present: string[] = [];
  for (const candidate of candidates) {
    const isDirectory = (await stat(path.join(REPO_ROOT, candidate)).catch(() => null))?.isDirectory() ?? false;
    if (isDirectory) present.push(candidate);
  }
  return present;
}

/** How many times a bundle constructs the quiet scope; more than one is a second copy. */
function quietScopeConstructions(bundleText: string): number {
  return bundleText.match(new RegExp(QUIET_SCOPE_PATTERN, "g"))?.length ?? 0;
}

/**
 * The names an ESM bundle exports as VALUES, read from its own `export { ... }` blocks.
 *
 * Read as text rather than imported: `test-typecheck` installs without building, so a
 * literal dynamic import of a build output would need a suppression in a file whose whole
 * job is to be believable, and a static analyser would report that specifier as unresolved
 * on a tree where the artefact is legitimately absent. An `export { local as Published }`
 * entry publishes the alias; a bare entry publishes its own name.
 *
 * @param bundleText - The bundled ESM output.
 * @returns The published value names, sorted.
 */
function valueExports(bundleText: string): string[] {
  const names: string[] = [];
  for (const block of bundleText.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of (block[1] ?? "").split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      const published = (parts[1] ?? parts[0] ?? "").trim();
      if (published !== "") names.push(published);
    }
  }
  return names.sort();
}

describe("the root bundle carries the engine", () => {
  it("defines the dimensions symbols its engine source declares", async () => {
    const source = await readFile(path.join(REPO_ROOT, ENGINE_SOURCE), "utf8");
    const bundle = await readArtifactText(ROOT_BUNDLE);
    for (const symbol of ENGINE_SYMBOLS) {
      expect(source, `${ENGINE_SOURCE} must still declare ${symbol}`).toContain(`${SOURCE_DECLARATION} ${symbol}`);
      const definition = new RegExp(`(?:function|var|let|const)\\s+${symbol}\\d*\\b`);
      expect(definition.test(bundle), `${ROOT_BUNDLE} must DEFINE ${symbol}, not import it from another package`).toBe(
        true,
      );
    }
  });

  it("imports nothing from the package the collapse deletes", async () => {
    for (const artifact of [ROOT_BUNDLE, LAUNCHER_BUNDLE]) {
      expect(await readArtifactText(artifact), `${artifact} must not import a package that no longer exists`).not.toContain(
        COLLAPSED_SPECIFIER,
      );
    }
  });
});

describe("the quiet scope has one owner", () => {
  it("publishes exactly the compiler-sdk surface the collapse replaces", async () => {
    const bundle = await readArtifactText(COMPILER_SDK_BUNDLE);
    expect(
      valueExports(bundle),
      `${COMPILER_SDK_BUNDLE} must publish the core's compiler-sdk surface and nothing else`,
    ).toEqual([...COMPILER_SDK_VALUES].sort());
  });

  it("constructs no quiet scope of its own: the engine's is the one it re-exports", async () => {
    // The hazard T2 introduces: `splitting: false` inlines this file's imports, so a
    // compiler-sdk bundle that `export { withQuiet } from "../utils/output.js"` inlines a
    // SECOND AsyncLocalStorage. `withQuiet` entered through it would then be invisible to
    // the engine in `dist/index.js` — silently, which is what S4 exists to prevent.
    const bundle = await readArtifactText(COMPILER_SDK_BUNDLE);
    expect(
      quietScopeConstructions(bundle),
      `${COMPILER_SDK_BUNDLE} must re-export the engine's quiet scope, never construct another`,
    ).toBe(0);
  });

  it("is constructed at most once inside each shipped bundle", async () => {
    for (const artifact of [ROOT_BUNDLE, LAUNCHER_BUNDLE]) {
      const constructions = quietScopeConstructions(await readArtifactText(artifact));
      expect(constructions, `${artifact} must carry one quiet scope, not a second copy of the output module`).toBeLessThanOrEqual(1);
    }
  });

  it("is defined by the root package's bundles and no other package's", async () => {
    const owners: string[] = [];
    for (const directory of await bundleDirectories()) {
      const definesIt = (await bundlesUnder(directory)).some(bundle => quietScopeConstructions(bundle.text) > 0);
      if (definesIt) owners.push(directory);
    }
    expect(
      owners,
      "quiet output is suppressed through one AsyncLocalStorage instance; a second package's bundle constructs its own,"
        + " so `withQuiet` entered through one silently stops applying in the other",
    ).toEqual(["dist"]);
  });
});
