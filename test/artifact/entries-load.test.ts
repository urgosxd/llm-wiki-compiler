/**
 * @file test/artifact/entries-load.test.ts
 * @description Proves that each of the four PUBLISHED entry modules of this
 * repository evaluates in-process, from the built artifact a consumer installs.
 *
 * ## What this proves
 *
 * Each published entry is loaded with `await import()` and its public exports are
 * asserted to exist AND to have the expected kind. Importing a bundle evaluates
 * its whole static chunk graph, so a chain that reaches `mammoth`, `express` and
 * the streamable-HTTP MCP SDK chunk fails here when a private workspace package
 * was externalized into `dist/` with every fast gate green, or when a `import
 * type` binding somewhere on the entry chain became a value import (a value
 * import of a type-only export is `undefined` at runtime, which `typeof` catches).
 *
 * ## What this does NOT prove
 *
 * This proves the modules EVALUATE and expose their public kinds. It does NOT
 * prove argv handling, exit codes, the stdout contract, or the shebang — all four
 * need a real spawned process. It therefore COMPLEMENTS, and does not replace, the
 * shipped-bundle spawn guard in `test/cli.test.ts:58-62`, which stays the check
 * for the command surface itself.
 *
 * ## Why the path comes from `package.json` and never from the bare specifier
 *
 * `vitest.config.ts` aliases all four published specifiers to SOURCE
 * (`@atomicstrata/llmwiki-core` → `packages/wiki/src/core-index.ts`, and so on),
 * and `tsconfig.json` repeats the same aliases for the type checker. A test that
 * wrote `await import("@atomicstrata/llmwiki-core")` would evaluate
 * `packages/wiki/src/*.ts` and prove nothing about the bundle a consumer gets:
 * the `dist/` chunk graph that holds `express`, `mammoth` and the MCP SDK is
 * never touched. So every entry is resolved from the owning package's own
 * `exports` map to an absolute path, and loaded through a `file:` URL, which no
 * alias can shadow. The resolved target is also asserted to live under a `dist`
 * directory, so an alias that later redirects this test back to source fails
 * loudly here instead of passing.
 *
 * The bundle's own transitive `import`s are resolved by the module runner, so an
 * alias still applies inside a bundle. What this file pins is that each published
 * entry FILE is the built artifact, and that artifact evaluates.
 *
 * ## Precondition: the build has run
 *
 * Each target is asserted to exist and to be non-empty BEFORE it is imported, and
 * the failure says so and names the build command. A run that finds no artifact
 * fails; it never passes because nothing was found.
 */

import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The command that produces the artifacts this test reads, quoted in the failure. */
const BUILD_COMMAND = "corepack pnpm run build";

/** The one `exports` condition this test follows: what an ESM consumer imports. */
const EXPORT_CONDITION = "import";

/** The substring every resolved target must contain: the build output directory. */
const BUILD_OUTPUT_DIRECTORY = "dist";

/** The little of a `package.json` this test reads. */
interface PackageManifest {
  readonly exports?: Readonly<Record<string, string | { readonly import?: string }>>;
}

/** One published entry, the manifest that publishes it, and its expected kinds. */
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

/**
 * The four entries this repository publishes, with a handful of high-signal
 * exports each. This is a load proof, not an API census: the names are the ones
 * whose absence, or whose becoming `undefined`, means the bundle lost its side.
 */
const PUBLISHED_ENTRIES: readonly PublishedEntry[] = [
  {
    specifier: "llm-wiki-compiler",
    manifest: "package.json",
    exportsKey: ".",
    expectedKinds: {
      createWiki: "function",
      activeProfileDigest: "function",
      readConfinedCappedBuffer: "function",
      ProviderUnavailableError: "function",
    },
  },
  {
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
  },
  {
    specifier: "@atomicstrata/llmwiki-core/compiler-sdk",
    manifest: "packages/llmwiki-core/package.json",
    exportsKey: "./compiler-sdk",
    expectedKinds: {
      createWikiCoreAtRoot: "function",
      withQuiet: "function",
    },
  },
  {
    specifier: "@atomicstrata/llmwiki-core/compiler-cli",
    manifest: "packages/llmwiki-core/package.json",
    exportsKey: "./compiler-cli",
    expectedKinds: {
      compileAndReport: "function",
      lint: "function",
      compileCommand: "function",
      hostCommand: "function",
      DEFAULT_SAMPLE_SIZE: "number",
      STATE_FILE: "string",
      output: "object",
    },
  },
];

/**
 * Read one package manifest.
 *
 * @param manifestPath - Repository-relative path of the `package.json`.
 * @returns The parsed manifest.
 */
async function readManifest(manifestPath: string): Promise<PackageManifest> {
  const manifestUrl = pathToFileURL(path.join(REPO_ROOT, manifestPath));
  return JSON.parse(await readFile(manifestUrl, "utf8")) as PackageManifest;
}

/**
 * The `import` target the manifest's `exports` map declares for one key.
 *
 * @param manifest - Parsed manifest of the publishing package.
 * @param exportsKey - The `exports` key (`"."`, `"./compiler-sdk"`, ...).
 * @param specifier - The published specifier, named in the failure.
 * @returns The target as the manifest writes it, e.g. `./dist/index.js`.
 */
function importTargetOf(manifest: PackageManifest, exportsKey: string, specifier: string): string {
  const declared = manifest.exports?.[exportsKey];
  const target = typeof declared === "string" ? declared : declared?.import;
  if (target === undefined) {
    throw new Error(
      `${specifier}: ${buildMessage(`no exports["${exportsKey}"]["${EXPORT_CONDITION}"] target`)}`,
    );
  }
  return target;
}

/**
 * The sentence every precondition failure carries, so an unrun build is never
 * mistaken for a broken artifact.
 *
 * @param detail - What was missing or empty.
 * @returns The failure text, naming the build command.
 */
function buildMessage(detail: string): string {
  return `${detail}, so the build has not run; run \`${BUILD_COMMAND}\` before this test`;
}

/**
 * Resolve one published entry to the absolute path of its built artifact.
 *
 * @param entry - The published entry to resolve.
 * @returns Absolute path of the file the package's `exports` map publishes.
 */
async function resolveEntryTarget(entry: PublishedEntry): Promise<string> {
  const manifest = await readManifest(entry.manifest);
  const target = importTargetOf(manifest, entry.exportsKey, entry.specifier);
  return path.resolve(path.dirname(path.join(REPO_ROOT, entry.manifest)), target);
}

/**
 * Import a module by `file:` URL, which no alias in `vitest.config.ts` can shadow.
 *
 * The specifier is a runtime string precisely because it comes from the package's
 * `exports` map, which is what makes this a proof about the artifact instead of
 * about source. The boundary rule reports any non-literal specifier as
 * unverifiable, and no literal can express an exports-map target.
 *
 * @param moduleUrl - The `file:` URL of the artifact to evaluate.
 * @returns The module namespace, as an untyped record for the kind assertions.
 */
async function importByFileUrl(moduleUrl: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line local/dimension-boundary -- runtime exports-map target; a literal would be source-pinned and defeat the proof
  const namespace: unknown = await import(moduleUrl);
  return namespace as Record<string, unknown>;
}

describe("published entries", () => {
  it.each(PUBLISHED_ENTRIES)(
    "$specifier evaluates from the dist artifact its exports map publishes",
    async (entry: PublishedEntry) => {
      const entryFile = await resolveEntryTarget(entry);
      const relativeEntry = path.relative(REPO_ROOT, entryFile);
      expect(
        relativeEntry.split(path.sep),
        `${entry.specifier}: the exports map must publish a ${BUILD_OUTPUT_DIRECTORY} artifact, not source`,
      ).toContain(BUILD_OUTPUT_DIRECTORY);

      const artifact = await stat(entryFile).catch(() => null);
      expect(
        artifact?.size ?? 0,
        `${entry.specifier}: ${relativeEntry} is ${artifact === null ? "missing" : "empty"}, ` +
          buildMessage("the published entry artifact is not usable"),
      ).toBeGreaterThan(0);

      const namespace = await importByFileUrl(pathToFileURL(entryFile).href);
      for (const [name, kind] of Object.entries(entry.expectedKinds)) {
        expect(typeof namespace[name], `${entry.specifier}: export \`${name}\` of ${relativeEntry}`).toBe(kind);
      }
    },
  );
});
