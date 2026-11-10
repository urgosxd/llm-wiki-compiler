/**
 * @file test/artifact/entries-load.test.ts
 * @description Proves that each of the four PUBLISHED entry modules of this
 * repository evaluates in-process, from the built artifact a consumer installs.
 *
 * ## What this proves
 *
 * Each published entry is loaded with a literal `await import()` of its `dist/`
 * file and its public exports are asserted to exist AND to have the expected kind.
 * Importing a bundle evaluates its whole static chunk graph, so a chain that
 * reaches `mammoth`, `express` and the streamable-HTTP MCP SDK chunk fails here
 * when a private workspace package was externalized into `dist/` with every fast
 * gate green, or when an `import type` binding somewhere on the entry chain became
 * a value import (a value import of a type-only export is `undefined` at runtime,
 * and `typeof` catches it).
 *
 * ## What this does NOT prove
 *
 * This proves the modules EVALUATE and expose their public kinds. It does NOT
 * prove argv handling, exit codes, the stdout contract, or the shebang — all four
 * need a real spawned process. It therefore COMPLEMENTS, and does not replace, the
 * shipped-bundle spawn guard in `test/cli.test.ts:58-62`, which stays the check
 * for the command surface itself.
 *
 * ## Why a literal `dist/` path, and not the bare specifier
 *
 * `vitest.config.ts` aliases all four published specifiers to SOURCE
 * (`@atomicstrata/llmwiki-core` → `packages/wiki/src/core-index.ts`, and so on),
 * and `tsconfig.json` repeats the same aliases for the type checker. A test that
 * wrote `await import("@atomicstrata/llmwiki-core")` would evaluate
 * `packages/wiki/src/*.ts` and prove nothing about the bundle a consumer gets: the
 * `dist/` chunk graph that holds `express`, `mammoth` and the MCP SDK is never
 * touched. A relative path into `dist/` cannot be shadowed by a
 * `/^@atomicstrata\/llmwiki-core$/` style alias, so the literal specifier below is
 * what makes this a proof about the artifact.
 *
 * Each literal is paired with an EQUALITY ASSERTION against the owning package's
 * `exports` map: the file this test imports must be the file that package
 * publishes. A specifier is not derived at runtime, because the dimension-boundary
 * rule reports a runtime import specifier as unverifiable rather than guessing at
 * it, and this file states what it imports so the turnpike stays readable.
 *
 * ## Precondition: the build has run
 *
 * Each artifact is asserted to exist and to be non-empty BEFORE it is imported,
 * and the failure names the build command. A run that finds no artifact fails; it
 * never passes because nothing was found. That precondition is also why each
 * literal import carries a `@ts-ignore`: the artifact is a build output, and the
 * `test-typecheck` CI job installs and type-checks without ever building, so the
 * module genuinely does not exist there. It is `@ts-ignore` rather than
 * `@ts-expect-error` because locally the build HAS run and the module resolves,
 * which would make an expectation unused.
 *
 * The bundle's own transitive `import`s are resolved by the module runner, so an
 * alias still applies inside a bundle. What this file pins is that each published
 * entry FILE is the built artifact, and that artifact evaluates.
 */

import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Directory this file lives in, which every literal artifact path is relative to. */
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** The command that produces the artifacts this test reads, quoted in the failure. */
const BUILD_COMMAND = "corepack pnpm run build";

/** The one `exports` condition this test follows: what an ESM consumer imports. */
const EXPORT_CONDITION = "import";

/** The path segment every resolved artifact must contain: the build output directory. */
const BUILD_OUTPUT_DIRECTORY = "dist";

/** The little of a `package.json` this test reads. */
interface PackageManifest {
  readonly exports?: Readonly<Record<string, string | { readonly import?: string }>>;
}

/** One published entry and the kinds its manifest declares it exposes. */
interface PublishedEntry {
  /** The published specifier a consumer writes. */
  readonly specifier: string;
  /** Repository-relative path of the `package.json` whose `exports` map publishes it. */
  readonly manifest: string;
  /** The `exports` key the specifier resolves through. */
  readonly exportsKey: string;
  /** Export name → the `typeof` it must report, so a lost or value-less export fails. */
  readonly expectedKinds: Readonly<Record<string, string>>;
}

/** The root facade. */
const ROOT_ENTRY: PublishedEntry = {
  specifier: "llm-wiki-compiler",
  manifest: "package.json",
  exportsKey: ".",
  expectedKinds: {
    createWiki: "function",
    activeProfileDigest: "function",
    readConfinedCappedBuffer: "function",
    ProviderUnavailableError: "function",
  },
};

/** The engine-free knowledge SDK, which the root facade consumes. */
const CORE_ENTRY: PublishedEntry = {
  specifier: "@atomicstrata/llmwiki-core",
  manifest: "packages/llmwiki-core/package.json",
  exportsKey: ".",
  expectedKinds: {
    createWikiCore: "function",
    startViewer: "function",
    atomicWrite: "function",
    parseFrontmatter: "function",
    LockUnavailableError: "function",
  },
};

/** The version-locked composition seam the standard facade builds on. */
const COMPILER_SDK_ENTRY: PublishedEntry = {
  specifier: "@atomicstrata/llmwiki-core/compiler-sdk",
  manifest: "packages/llmwiki-core/package.json",
  exportsKey: "./compiler-sdk",
  expectedKinds: {
    createWikiCoreAtRoot: "function",
    withQuiet: "function",
  },
};

/**
 * The sentence every precondition failure carries, so an unrun build is never
 * mistaken for a broken artifact.
 *
 * @param detail - What was missing or empty.
 * @returns The failure text, naming the build command.
 */
function buildMessage(detail: string): string {
  return `${detail}, so the build has not run; run \`${BUILD_COMMAND}\` before using this test`;
}

/**
 * Read one package manifest.
 *
 * @param manifestPath - Repository-relative path of the `package.json`.
 * @returns The parsed manifest.
 */
async function readManifest(manifestPath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, manifestPath), "utf8")) as PackageManifest;
}

/**
 * The `import` target the manifest's `exports` map declares for one key.
 *
 * @param entry - The published entry whose map is read.
 * @param manifest - Parsed manifest of the publishing package.
 * @returns The target as the manifest writes it, e.g. `./dist/index.js`.
 */
function importTargetOf(entry: PublishedEntry, manifest: PackageManifest): string {
  const declared = manifest.exports?.[entry.exportsKey];
  const target = typeof declared === "string" ? declared : declared?.import;
  if (target === undefined) {
    const missing = `no exports["${entry.exportsKey}"]["${EXPORT_CONDITION}"] target`;
    throw new Error(`${entry.specifier}: ${missing}, so the package publishes no ESM entry under that key`);
  }
  return target;
}

/**
 * The absolute path of the artifact one package's `exports` map publishes.
 *
 * @param entry - The published entry to resolve.
 * @returns Absolute path the manifest declares, resolved against the package root.
 */
async function publishedArtifactPath(entry: PublishedEntry): Promise<string> {
  const manifest = await readManifest(entry.manifest);
  return path.resolve(path.dirname(path.join(REPO_ROOT, entry.manifest)), importTargetOf(entry, manifest));
}

/**
 * Assert one literal artifact path is the published one, under `dist/`, and built.
 *
 * Runs BEFORE the import, so a missing artifact fails with the build instruction
 * instead of an unresolved-module error from the module runner.
 *
 * @param entry - The published entry the literal path is expected to be.
 * @param literalPath - The specifier this file imports, relative to this directory.
 * @returns The repository-relative artifact path, for the kind-failure messages.
 */
async function assertPublishedArtifact(entry: PublishedEntry, literalPath: string): Promise<string> {
  const importedFile = path.resolve(TEST_DIRECTORY, literalPath);
  const relativeFile = path.relative(REPO_ROOT, importedFile);
  expect(
    importedFile,
    `${entry.specifier}: the exports map must publish the artifact this file imports (${literalPath})`,
  ).toBe(await publishedArtifactPath(entry));
  expect(
    relativeFile.split(path.sep),
    `${entry.specifier}: the imported artifact must live in a ${BUILD_OUTPUT_DIRECTORY} directory, never source`,
  ).toContain(BUILD_OUTPUT_DIRECTORY);

  const artifact = await stat(importedFile).catch(() => null);
  const state = artifact === null ? "missing" : "empty";
  expect(
    artifact?.size ?? 0,
    `${entry.specifier}: ${relativeFile} is ${state}, ${buildMessage("the published entry artifact is not usable")}`,
  ).toBeGreaterThan(0);
  return relativeFile;
}

/**
 * Assert every expected export of one entry exists with the expected kind.
 *
 * @param entry - The published entry whose expectations are checked.
 * @param namespace - The imported module namespace, untyped on purpose.
 * @param relativeFile - Repository-relative artifact path, named in the failure.
 */
function assertExportKinds(entry: PublishedEntry, namespace: unknown, relativeFile: string): void {
  const exported = namespace as Record<string, unknown>;
  for (const [name, kind] of Object.entries(entry.expectedKinds)) {
    expect(typeof exported[name], `${entry.specifier}: export \`${name}\` of ${relativeFile}`).toBe(kind);
  }
}

describe("published entries", () => {
  it("llm-wiki-compiler evaluates from its published dist artifact", async () => {
    const literalPath = "../../dist/index.js";
    const artifact = await assertPublishedArtifact(ROOT_ENTRY, literalPath);
    // The specifier must stay this literal: the dimension-boundary rule reports a
    // runtime import specifier as unverifiable, so it cannot come from a variable.
    // @ts-ignore -- build output; the test-typecheck job installs without building
    const namespace: unknown = await import("../../dist/index.js");
    assertExportKinds(ROOT_ENTRY, namespace, artifact);
  });

  it("@atomicstrata/llmwiki-core evaluates from its published dist artifact", async () => {
    const literalPath = "../../packages/llmwiki-core/dist/index.js";
    const artifact = await assertPublishedArtifact(CORE_ENTRY, literalPath);
    // @ts-ignore -- build output; the test-typecheck job installs without building
    const namespace: unknown = await import("../../packages/llmwiki-core/dist/index.js");
    assertExportKinds(CORE_ENTRY, namespace, artifact);
  });

  it("@atomicstrata/llmwiki-core/compiler-sdk evaluates from its published dist artifact", async () => {
    const literalPath = "../../packages/llmwiki-core/dist/compiler-sdk.js";
    const artifact = await assertPublishedArtifact(COMPILER_SDK_ENTRY, literalPath);
    // @ts-ignore -- build output; the test-typecheck job installs without building
    const namespace: unknown = await import("../../packages/llmwiki-core/dist/compiler-sdk.js");
    assertExportKinds(COMPILER_SDK_ENTRY, namespace, artifact);
  });

});
