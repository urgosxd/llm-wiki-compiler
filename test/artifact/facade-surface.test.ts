/**
 * @file test/artifact/facade-surface.test.ts
 * @description Pins the published surface of `@atomicstrata/llmwiki-core` as a
 * DELIBERATE, NAMED surface rather than an accident of which wiki sources its
 * `tsup.config.ts` happens to compile (S1), and proves every published `exports`
 * subpath resolves to a real file under `dist/` (S2).
 *
 * ## The accident this file exists to stop
 *
 * `packages/llmwiki-core` publishes the artefact embedders actually reach the
 * engine through, and until now it owned no source: its `tsup.config.ts` compiled
 * `../../packages/wiki/src/core-index.ts` and
 * `../../packages/wiki/src/sdk/compiler-composition.ts` directly. Whatever those
 * two files re-exported was therefore the published surface by coincidence, and
 * `compiler-composition.ts` ended in `export type * from "./core-types.js";` — a
 * wildcard that publishes every type its target declares, including future ones
 * nobody chose to publish. A facade must own its entries and name what it
 * re-exports.
 *
 * ## What each assertion proves, and in what order
 *
 * 1. **Ownership.** `packages/llmwiki-core/src/index.ts` and
 *    `packages/llmwiki-core/src/compiler-sdk.ts` exist as non-empty files.
 * 2. **The build reads the facade, not its neighbour.** The `entry` block of
 *    `packages/llmwiki-core/tsup.config.ts` names exactly `./src/index.ts` and
 *    `./src/compiler-sdk.ts`, and no entry value walks into `packages/wiki/`.
 * 3. **No wildcard re-export** survives in either facade source, so the surface
 *    is enumerated rather than inherited.
 * 4. **The runtime surface does not silently shrink.** The BUILT artefacts are
 *    imported and their value exports are compared against a pinned list, so a
 *    facade rewrite that drops a published name fails here instead of breaking a
 *    consumer. `compiler-sdk` is pinned by EXACT equality (two names, no more);
 *    `index` is pinned by CONTAINMENT, because adding a deliberate export is not
 *    a regression and exact equality would turn every addition into a test edit.
 * 5. **Every `exports` subpath resolves on disk** under `dist/`, with both the
 *    `types` and `import` conditions, plus `./package.json` pointing at the very
 *    manifest that declares it.
 * 6. **The declaration layout stays top-level.** No emitted `.d.ts` sits under a
 *    `packages` or `src` path segment, because the two declaration paths the
 *    `exports` map can name are `dist/index.d.ts` and `dist/compiler-sdk.d.ts`;
 *    a build change that nested them would break every consumer silently.
 *
 * ## Why the built artefacts are imported by a LITERAL specifier
 *
 * `vitest.config.ts` aliases `@atomicstrata/llmwiki-core` to SOURCE, so importing
 * the bare specifier would evaluate `packages/wiki/src/*.ts` and prove nothing
 * about what a consumer installs. A relative path into `dist/` cannot be shadowed
 * by that alias. The specifier also stays literal rather than computed: the local
 * `dimension-boundary` lint rule reports a non-literal `import()` argument as
 * unverifiable, and an unverifiable import in a test that exists to verify the
 * published surface would be its own defect. This follows
 * `test/artifact/entries-load.test.ts`, which is the established idiom for
 * reaching an artefact this way.
 *
 * ## Precondition: the build has run
 *
 * `test/global-setup.ts` builds `dist/` and both workspace packages before any
 * test file loads, so the artefacts below normally exist. Each one is still
 * checked for existence and size BEFORE it is imported: a missing artefact SKIPS
 * with the build command named, rather than failing with an unresolved-module
 * error that says nothing about the facade. A skip here is UNPROVEN, not green.
 *
 * The `@ts-ignore` on each literal import is required: the artefact is a build
 * output, and the `test-typecheck` CI job installs and type-checks without ever
 * building, so the module genuinely does not exist there. It is `@ts-ignore` and
 * not `@ts-expect-error` because locally the build HAS run and the module
 * resolves, which would make an expectation unused.
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The package under test. */
const FACADE_PACKAGE = "packages/llmwiki-core";

/** The command that produces the artefacts this file reads, quoted in failures. */
const BUILD_COMMAND = "corepack pnpm run build";

/** The facade's own entry sources, which both must exist once the facade is honest. */
const ENTRY_SOURCES: readonly string[] = [`${FACADE_PACKAGE}/src/index.ts`, `${FACADE_PACKAGE}/src/compiler-sdk.ts`];

/** What the build must name as its entries, sorted: the facade's own sources. */
const EXPECTED_ENTRIES: readonly string[] = ["./src/compiler-sdk.ts", "./src/index.ts"];

/** The sibling package whose sources the build must no longer compile as its own. */
const SIBLING_SOURCE_MARKER = "packages/wiki";

/** A wildcard re-export, in both shapes S1 names: `export *` and `export type *`. */
const WILDCARD_REEXPORT = /\bexport\s+(?:type\s+)?\*/;

/** The `entry` declaration of a tsup config, object or array shaped. */
const ENTRY_DECLARATION = /\bentry\s*:\s*([[{])[\s\S]*?[\]}]/;

/** A quoted string inside the `entry` declaration, which the ARRAY shape uses for its values. */
const QUOTED_SPECIFIER = /["']([^"']+)["']/g;

/**
 * A `key: "value"` pair inside the OBJECT shape of the `entry` declaration.
 *
 * The VALUE is captured alone, never the key: `"compiler-sdk"` is a quoted key in
 * the real config, and a reader that took every quoted string would report the key
 * name as a source path.
 */
const OBJECT_ENTRY_PAIR = /(["']?)([\w-]+)\1\s*:\s*["']([^"']+)["']/g;

/** The two built artefacts whose runtime surface this file pins. */
const CORE_ARTIFACT = `${FACADE_PACKAGE}/dist/index.js`;
const COMPILER_SDK_ARTIFACT = `${FACADE_PACKAGE}/dist/compiler-sdk.js`;

/** The value exports `dist/compiler-sdk.js` must publish, exactly. */
const COMPILER_SDK_VALUES: readonly string[] = ["createWikiCoreAtRoot", "withQuiet"];

/**
 * The value exports `dist/index.js` must keep publishing.
 *
 * Every name below was confirmed as a VALUE export of
 * `packages/wiki/src/core-index.ts` (the source the facade re-exports today), not
 * a type-only export: a type re-export is erased from the bundle and would make
 * this list assert against a key that can never exist.
 */
const CORE_VALUES: readonly string[] = [
  "createWikiCore",
  "ProviderUnavailableError",
  "UnknownProviderError",
  "startViewer",
  "LockUnavailableError",
  "QueueFullError",
  "activeProfileDigest",
  "readConfinedCappedBuffer",
  "loadNonDefaultProfile",
  "parseFrontmatter",
  "slugify",
  "collectViewerPages",
  "resolveBareSlug",
  "isTrustedWriteGranted",
  "atomicWrite",
  "AtomicWriteCollisionError",
  "AtomicWriteCommittedCleanupError",
  "loadProfile",
  "isSlugSafe",
  "confineUnderRoot",
  "resolveConfinedPrivateDir",
  "releaseLock",
  "confinedFetch",
  "confinedFetchRequest",
  "scaffoldConfinedDirectories",
  "ensureConfinedDirectory",
];

/** The subpaths whose `types` and `import` targets must resolve onto disk. */
const REQUIRED_SUBPATHS: readonly string[] = [".", "./compiler-sdk"];

/** The condition names a published subpath must carry. */
const EXPORT_CONDITIONS: readonly string[] = ["types", "import"];

/** The directory every published target must point into. */
const BUILD_OUTPUT_DIRECTORY = "dist";

/**
 * The path segments a published declaration must never sit under.
 *
 * `exports` names `dist/index.d.ts` and `dist/compiler-sdk.d.ts` and nothing
 * else, so a declaration that landed under `dist/packages/...` or `dist/src/...`
 * would be a declaration no consumer can name through the export map.
 */
const NESTED_DECLARATION_SEGMENTS: readonly string[] = ["packages", "src"];

/** The little of a package manifest this file reads. */
interface FacadeManifest {
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, string | undefined>>>>;
}

/**
 * Read one repository-relative text file.
 *
 * @param relativePath - Repository-relative path of the file.
 * @returns The file's contents.
 */
async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Read and parse one repository-relative JSON file.
 *
 * @param relativePath - Repository-relative path of the JSON file.
 * @returns The parsed document, as the caller's shape.
 */
async function readJsonFile<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readText(relativePath)) as T;
}

/** The characters that open a string literal in the source this file reads. */
const QUOTE_CHARACTERS: readonly string[] = ['"', "'", "`"];

/**
 * Where a line comment ends: the newline that closes it, or the end of the text.
 *
 * @param source - Source text being scanned.
 * @param start - Index of the first slash of the comment marker.
 * @returns The index of the terminating newline, or `source.length`.
 */
function endOfLineComment(source: string, start: number): number {
  let index = start;
  while (index < source.length && source[index] !== "\n") index += 1;
  return index;
}

/**
 * Where a block comment ends: the slash of its closing marker.
 *
 * An unterminated comment reports one past the end, so the caller's loop
 * increment leaves the scan, which is what the single-loop scanner this replaces
 * did when it ran out of text.
 *
 * @param source - Source text being scanned.
 * @param start - Index of the first slash of the opening marker.
 * @returns The index of the closing slash, or `source.length + 1`.
 */
function endOfBlockComment(source: string, start: number): number {
  let index = start + 2;
  while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
  return index + 1;
}

/**
 * What one scan step consumed and what replaces it.
 *
 * `index` is the LAST character the step read, not the next one: the caller's
 * loop increment moves past it, which is how the single-loop scanner this
 * replaces advanced after every branch it took.
 */
interface ScanStep {
  /** Text to append in place of what was consumed. */
  readonly text: string;
  /** Index of the last character consumed. */
  readonly index: number;
  /** The still-open string literal delimiter, or `null` outside a literal. */
  readonly quote: string | null;
}

/**
 * Consume one character that sits inside a string literal.
 *
 * Inside a literal nothing is a comment any more, which is the whole reason this
 * file strips comments instead of regexing them away: `http://`, a `/*` inside a
 * quoted string and an escaped quote all have to stay. A backslash consumes the
 * character after it too, so an escaped delimiter cannot close the literal.
 *
 * @param source - Source text being scanned.
 * @param index - Index of the character to consume.
 * @param quote - The delimiter that opened the literal being read.
 * @returns The appended text, the last index consumed, and the literal state.
 */
function stepInQuote(source: string, index: number, quote: string): ScanStep {
  const character = source[index] ?? "";
  const escaped = character === "\\";
  const closes = !escaped && character === quote;
  return {
    text: escaped ? character + (source[index + 1] ?? "") : character,
    index: escaped ? index + 1 : index,
    quote: closes ? null : quote,
  };
}

/**
 * Consume the first character of a possible comment marker.
 *
 * A slash that opens neither kind of comment is ordinary text.
 *
 * @param source - Source text being scanned.
 * @param index - Index of the slash.
 * @param next - The character after the slash, or an empty string at the end.
 * @returns The appended text, the last index consumed, and the literal state.
 */
function stepSlash(source: string, index: number, next: string): ScanStep {
  if (next === "/") return { text: "\n", index: endOfLineComment(source, index), quote: null };
  if (next === "*") return { text: " ", index: endOfBlockComment(source, index), quote: null };
  return { text: "/", index, quote: null };
}

/**
 * Consume one character that sits outside a string literal.
 *
 * Outside a literal only two things are special: a quote, which opens one, and a
 * slash, which may open a comment.
 *
 * @param source - Source text being scanned.
 * @param index - Index of the character to consume.
 * @returns The appended text, the last index consumed, and the literal state.
 */
function stepOutsideQuote(source: string, index: number): ScanStep {
  const character = source[index] ?? "";
  if (character === "/") return stepSlash(source, index, source[index + 1] ?? "");
  return { text: character, index, quote: QUOTE_CHARACTERS.includes(character) ? character : null };
}

/**
 * Remove comments from TypeScript source while leaving string literals intact.
 *
 * A naive `//` strip would truncate a line at a URL, and leaving comments in
 * would let prose about a wildcard or an old entry path fail the assertions that
 * read this text. So quotes are tracked and only real comment bodies are dropped.
 *
 * The scan below is a loop over `ScanStep`s: each step consumes one character, or
 * one whole comment, and returns the text that replaces it, where to resume, and
 * whether a string literal is open. Keeping the per-case decisions in the step
 * functions is what lets this one stay a loop rather than a branch pile, and the
 * behaviour is unchanged by the split: a line comment becomes a newline, a block
 * comment a single space, and `escape`/closing-quote handling inside a literal is
 * exactly what `stepInQuote` did inline before.
 *
 * @param source - Source text, possibly commented.
 * @returns The same text with comments replaced by whitespace.
 */
function stripComments(source: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    // Annotated, not inferred: `index` comes back out of `step.index` below, so leaving the
    // type to inference makes it depend on its own earlier iteration (TS7022).
    const step: ScanStep = quote === null ? stepOutsideQuote(source, index) : stepInQuote(source, index, quote);
    output += step.text;
    quote = step.quote;
    index = step.index;
  }
  return output;
}

/**
 * Read one facade source, asserting first that it exists and is not empty.
 *
 * Without this precondition the failure is a bare `ENOENT`, which reads like a
 * broken test instead of a facade that does not own its entries yet.
 *
 * @param relativePath - Repository-relative path of the source file.
 * @returns The file's contents.
 */
async function readSource(relativePath: string): Promise<string> {
  const info = await stat(path.join(REPO_ROOT, relativePath)).catch(() => null);
  expect(info?.isFile() ?? false, `${relativePath} must exist: the facade owns its own entry sources`).toBe(true);
  expect(info?.size ?? 0, `${relativePath} must not be empty`).toBeGreaterThan(0);
  return readText(relativePath);
}

/**
 * The quoted specifiers named inside a tsup config's `entry` declaration.
 *
 * @param configText - The config file's text.
 * @returns The distinct entry specifiers, sorted.
 */
function entrySpecifiers(configText: string): string[] {
  const declaration = ENTRY_DECLARATION.exec(stripComments(configText));
  expect(declaration, `${FACADE_PACKAGE}/tsup.config.ts must declare an \`entry\` option`).not.toBeNull();
  const block = declaration?.[0] ?? "";
  const found =
    declaration?.[1] === "["
      ? [...block.matchAll(QUOTED_SPECIFIER)].map((match) => match[1] ?? "")
      : [...block.matchAll(OBJECT_ENTRY_PAIR)].map((match) => match[3] ?? "");
  return [...new Set(found)].sort();
}

/**
 * The built artefact's repository-relative path, or `null` when it is absent.
 *
 * A `null` is the only outcome that may SKIP: the caller reports it as unproven
 * and names the build command, so a missing artefact is never read as a pass.
 *
 * @param relativePath - Repository-relative path of the artefact.
 * @returns The same path when the artefact exists and is non-empty, else `null`.
 */
async function artifactPath(relativePath: string): Promise<string | null> {
  const info = await stat(path.join(REPO_ROOT, relativePath)).catch(() => null);
  return (info?.size ?? 0) > 0 ? relativePath : null;
}

/**
 * The `types`/`import` targets one published subpath declares.
 *
 * @param manifest - The published package manifest.
 * @param subpath - The `exports` key to read.
 * @returns Its conditions, or an empty map when it is a bare string.
 */
function conditionTargets(manifest: FacadeManifest, subpath: string): Record<string, string | undefined> {
  const declared = manifest.exports?.[subpath];
  expect(typeof declared, `${FACADE_PACKAGE}: exports["${subpath}"] must be a conditions object`).toBe("object");
  return (typeof declared === "string" ? {} : declared) as Record<string, string | undefined>;
}

describe("the facade owns its published surface", () => {
  it("both facade entry sources exist and carry content", async () => {
    for (const sourcePath of ENTRY_SOURCES) await readSource(sourcePath);
  });

  it("the build entries point at the facade's own sources", async () => {
    const config = await readSource(`${FACADE_PACKAGE}/tsup.config.ts`);
    const specifiers = entrySpecifiers(config);
    for (const specifier of specifiers) {
      expect(specifier, `entry "${specifier}" must not compile a sibling package's source`).not.toContain(
        SIBLING_SOURCE_MARKER,
      );
      expect(specifier, `entry "${specifier}" must be a path inside the facade, not a walk out of it`).not.toContain("..");
    }
    expect(specifiers, `${FACADE_PACKAGE}/tsup.config.ts must build exactly the facade's two entry sources`).toEqual([
      ...EXPECTED_ENTRIES,
    ]);
  });

  it("no facade source re-exports a wildcard", async () => {
    for (const sourcePath of ENTRY_SOURCES) {
      const code = stripComments(await readSource(sourcePath));
      expect(
        WILDCARD_REEXPORT.test(code),
        `${sourcePath} must name every re-export: a wildcard publishes whatever its target declares`,
      ).toBe(false);
    }
  });
});

describe("the entry reader that parses the build config", () => {
  it("reads both entry shapes a tsup config may use, and ignores a commented-out one", () => {
    const objectShaped = `export default defineConfig({
      entry: { index: "./src/index.ts", "compiler-sdk": "./src/compiler-sdk.ts" },
    });`;
    const bareKeyShaped = `export default defineConfig({ entry: { index: "./src/index.ts", other: "./src/compiler-sdk.ts" } });`;
    const arrayShaped = `// moved from ../../packages/wiki/src/core-index.ts
    export default defineConfig({ entry: ["./src/index.ts", "./src/compiler-sdk.ts"] });`;
    for (const configText of [objectShaped, bareKeyShaped, arrayShaped]) {
      expect(entrySpecifiers(configText), "the entry reader must read a facade-shaped config").toEqual([
        ...EXPECTED_ENTRIES,
      ]);
    }
    expect(
      entrySpecifiers(`${arrayShaped}\n// entry: "../../packages/wiki/src/core-index.ts"`),
      "a commented-out old entry must not be read as an entry",
    ).toEqual([...EXPECTED_ENTRIES]);
  });
});

describe("the built runtime surface", () => {
  it("compiler-sdk publishes exactly its two value exports", async (context) => {
    if ((await artifactPath(COMPILER_SDK_ARTIFACT)) === null) {
      return context.skip(`${COMPILER_SDK_ARTIFACT} is absent after an honest build attempt; run \`${BUILD_COMMAND}\`.`);
    }
    // The specifier must stay literal: the boundary rule reports a computed one as unverifiable.
    // @ts-ignore -- build output; the test-typecheck job installs without building
    const namespace: unknown = await import("../../packages/llmwiki-core/dist/compiler-sdk.js");
    const published = Object.keys(namespace as Record<string, unknown>).sort();
    expect(published, `${COMPILER_SDK_ARTIFACT} must publish exactly the named compiler-sdk surface`).toEqual([
      ...COMPILER_SDK_VALUES,
    ].sort());
  });

  it("index keeps every pinned value export", async (context) => {
    if ((await artifactPath(CORE_ARTIFACT)) === null) {
      return context.skip(`${CORE_ARTIFACT} is absent after an honest build attempt; run \`${BUILD_COMMAND}\`.`);
    }
    // @ts-ignore -- build output; the test-typecheck job installs without building
    const namespace: unknown = await import("../../packages/llmwiki-core/dist/index.js");
    const published = namespace as Record<string, unknown>;
    const missing = CORE_VALUES.filter((name) => !(name in published));
    expect(missing, `${CORE_ARTIFACT} must keep publishing these names, which consumers already import`).toEqual([]);
  });
});

describe("the published exports map", () => {
  it("every required subpath resolves to a built file under dist", async () => {
    const manifestPath = `${FACADE_PACKAGE}/package.json`;
    const manifest = await readJsonFile<FacadeManifest>(manifestPath);
    const packageRoot = path.dirname(path.join(REPO_ROOT, manifestPath));
    for (const subpath of REQUIRED_SUBPATHS) {
      const targets = conditionTargets(manifest, subpath);
      for (const condition of EXPORT_CONDITIONS) {
        const target = targets[condition] ?? "";
        expect(target, `${FACADE_PACKAGE}: exports["${subpath}"]["${condition}"] must be declared`).toBeTruthy();
        expect(target.split("/"), `exports["${subpath}"]["${condition}"] must point into ${BUILD_OUTPUT_DIRECTORY}`).toContain(
          BUILD_OUTPUT_DIRECTORY,
        );
        const resolved = await stat(path.resolve(packageRoot, target)).catch(() => null);
        expect(
          resolved?.isFile() ?? false,
          `exports["${subpath}"]["${condition}"] -> ${target} must exist; run \`${BUILD_COMMAND}\``,
        ).toBe(true);
      }
    }
  });

  it("the package.json subpath resolves to the manifest itself", async () => {
    const manifestPath = `${FACADE_PACKAGE}/package.json`;
    const manifest = await readJsonFile<FacadeManifest>(manifestPath);
    const declared = manifest.exports?.["./package.json"];
    expect(declared, `${FACADE_PACKAGE}: exports["./package.json"] must name the manifest`).toBe("./package.json");
    const resolved = await stat(path.resolve(path.dirname(path.join(REPO_ROOT, manifestPath)), "./package.json")).catch(
      () => null,
    );
    expect(resolved?.isFile() ?? false, `exports["./package.json"] -> ./package.json must exist on disk`).toBe(true);
  });
});

/**
 * Every emitted declaration file under a directory, recursively, as absolute paths.
 *
 * @param directory - Absolute directory to walk.
 * @returns Every file whose name ends in `.d.ts`, in no particular order.
 */
async function declarationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return declarationFiles(entryPath);
      return entry.name.endsWith(".d.ts") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

describe("the declaration layout the published exports map names", () => {
  // A GUARD, not a behavior change: it passes both before and after the slice
  // that added it and has no RED phase. Today the shared declaration chunk is
  // content-hashed (`dist/core-DZb6rK43.d.ts`), so this asserts LAYOUT, not
  // filenames -- a hash changes freely, a directory level does not.
  it("no emitted declaration sits under a packages or src path segment", async (context) => {
    const distDirectory = path.join(REPO_ROOT, FACADE_PACKAGE, BUILD_OUTPUT_DIRECTORY);
    if ((await stat(distDirectory).catch(() => null))?.isDirectory() !== true) {
      return context.skip(
        `${FACADE_PACKAGE}/${BUILD_OUTPUT_DIRECTORY} is absent; run \`${BUILD_COMMAND}\` before reading its layout.`,
      );
    }
    const declarations = await declarationFiles(distDirectory);
    expect(
      declarations.length,
      `${FACADE_PACKAGE}/${BUILD_OUTPUT_DIRECTORY} must emit at least one declaration for the exports map to name`,
    ).toBeGreaterThan(0);
    const nested = declarations
      .map((declaration) => path.relative(distDirectory, declaration).split(path.sep))
      .filter((segments) => segments.some((segment) => NESTED_DECLARATION_SEGMENTS.includes(segment)))
      .map((segments) => segments.join("/"));
    expect(
      nested,
      `declarations must stay top-level under ${BUILD_OUTPUT_DIRECTORY}: exports names only top-level .d.ts paths`,
    ).toEqual([]);
  });
});
