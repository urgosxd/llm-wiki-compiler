/**
 * @file test/artifact/dist-specifiers.test.ts
 * @description Automates the artifact specifier guard, which until now existed
 * only as prose in `odd/tasks/*.md`: `grep -o '@repo/[a-z-]*' dist/*.js`, run by
 * hand when someone remembered. It caught two real failures by hand
 * (`odd/tasks/package-split.md:97` and `:123`) — a private workspace package
 * externalized into a broken `dist` with every fast gate green, twice.
 *
 * ## Why the walk is recursive, and why both roots
 *
 * The manual grep was `dist/*.js`: non-recursive and root-only. The package that
 * actually externalizes is `@atomicstrata/llmwiki-core` (it carries `express`,
 * `@modelcontextprotocol/sdk`, `@hono/node-server` and `mammoth`), and its build
 * tree is `packages/llmwiki-core/dist`, which the manual grep never opened. This
 * guard therefore walks `dist/**\/*.js` and `packages/llmwiki-core/dist/**\/*.js`
 * RECURSIVELY and unions the two sets.
 *
 * ## Two assertions, because `@repo/` reaches a bundle in two shapes
 *
 * Only one of them is a runtime bug:
 *
 * 1. in IMPORT POSITION — `from "@repo/kg"`, `export … from "@repo/kg"`,
 *    `import("@repo/kg")`, `require("@repo/kg")`, `import "@repo/kg"`, where the
 *    examples name one real private package and stand for any of them. That is
 *    the only form Node resolves at runtime, so such a specifier makes the
 *    shipped bundle import raw TypeScript that is not on the consumer's disk: the
 *    failure that broke the build twice. Asserted at ZERO.
 * 2. as DEAD DATA — the private `packages/wiki/package.json` manifest, inlined by
 *    esbuild from `packages/wiki/src/commands/host.ts:76`'s
 *    `require("../../package.json")`. It is serialized into the bundle as an
 *    object literal and never enters module resolution. Its TOTAL occurrence count
 *    is RATCHETED instead of zeroed, because a literal zero-match is not reachable
 *    without touching a consumer-visible version-reporting path that is about to
 *    move (see the pin's own comment).
 *
 * ## Fail closed, per root
 *
 * Each root's collected file set is asserted non-empty SEPARATELY, before anything
 * is checked. A single combined check would pass trivially while
 * `packages/llmwiki-core/dist` was missing, silently un-checking the package that
 * matters. The precondition is "the build has run", and every failure names both
 * the root and `corepack pnpm run build`, so an unrun build is never mistaken for
 * a clean artifact.
 *
 * ## Both assertions are proven to bite, from inside this file
 *
 * A guard that passes because it found nothing, or because its detector stopped
 * matching, is the failure mode this repository keeps rediscovering. So two
 * committed self-tests keep it honest: one drives the fail-closed assertion over an
 * empty walk, and one injects `import "@repo/kg"` into a SCRATCH COPY of a real
 * collected bundle — verified byte-identical by sha256 before and after, then
 * restored and re-verified — and asserts the detector reports that specifier and
 * names the file. The real `dist/` is never written by this file.
 */

import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The command that writes the trees this guard inspects: the guard's precondition. */
const BUILD_COMMAND = "corepack pnpm run build";

/** Both build trees the guard walks recursively, repository-relative. */
const BUILD_ROOTS: readonly string[] = ["dist", "packages/llmwiki-core/dist"];

/** The extension a shipped ESM bundle uses; the copied browser assets use it too. */
const BUNDLE_EXTENSION = ".js";

/** Path segment of the copied viewer assets, which are assets and not entry bundles. */
const ASSET_SEGMENT = "/viewer/assets/";

/** Scratch-directory prefix, distinctive so a leaked one is traceable to this file. */
const SCRATCH_PREFIX = "llmwiki-dist-guard-";

/** A private-package reference, counted anywhere in one bundle's text. */
const PRIVATE_REFERENCE = /@repo\//g;

/**
 * Private-package specifiers in IMPORT POSITION: the only form Node resolves at
 * runtime, and so the only form that can break a consumer's install. The shapes
 * below are written with the concrete `@repo/kg`, which stands in for any private
 * workspace package, and they are exactly five:
 *
 * - `import … from "@repo/kg"` — a static import's `from` clause;
 * - `export … from "@repo/kg"` — the same clause, re-exporting;
 * - `import "@repo/kg"` — a side-effect import, which has no `from` clause at all
 *   and would slip past a detector that only knew the four `from`/`(` forms;
 * - `import("@repo/kg")` — a dynamic import;
 * - `require("@repo/kg")` — a CommonJS require, which a bundle may leave in place.
 *
 * The whitespace before the quote is load-bearing: esbuild emits `from"…"` with no
 * space at all. The `\b` keeps `from` from matching the tail of a longer
 * identifier, such as `transform`, and the optional `\(` covers the call forms
 * without letting `import {x} from …` report twice: the `{` after `import` fails
 * `\s*\(?\s*["']`, so only the `from` clause matches.
 */
const IMPORT_POSITION_PRIVATE_SPECIFIER = /(?:\bfrom|\bimport\b|\brequire\b)\s*\(?\s*["'](@repo\/[^"']*)["']/g;

/**
 * What the bite self-test appends to its scratch copy, and the specifier that must
 * come back out. Held as DATA, never written as an import statement in this file:
 * this test's own module graph must not gain the edge it is proving a detector
 * finds, and a real import here would make the test itself the violation.
 */
const INJECTED_SOURCE_SUFFIX = '\nimport "@repo/kg";\n';

/** The specifier {@link INJECTED_SOURCE_SUFFIX} carries. */
const INJECTED_SPECIFIER = "@repo/kg";

/**
 * The pinned TOTAL count of `@repo/` occurrences across both build trees: 2,
 * measured, both in `packages/llmwiki-core/dist/compiler-cli.js`.
 *
 * WHY THE COUNT EXISTS, AND WHY IT MUST BE LOWERED TO 0. Both occurrences are a
 * serialized `packages/wiki/package.json` (`name: "@repo/wiki"` and
 * `"@repo/foundation": "workspace:*"`), which esbuild inlines as DEAD DATA from
 * `packages/wiki/src/commands/host.ts:76`'s `require("../../package.json")`. That
 * data never enters module resolution, so it cannot break a consumer's install the
 * way an import-position specifier does — which is exactly why the zero assertion
 * above is the one that bites and this count is only ratcheted.
 *
 * `packages/wiki/src/commands/host.ts` is group A: it leaves with the CLI removal,
 * and its `host` entry moves into `@repo/api`. WHEN IT LEAVES, LOWER THIS PIN TO 0
 * rather than re-baselining it to whatever the tree then holds. A frozen count
 * with no explanation is how a ratchet becomes permanent, so the reason lives
 * here, where the next reader meets it, instead of in an archaeology session.
 */
const PINNED_TOTAL_PRIVATE_OCCURRENCES = 2;

/** One private specifier found in import position, with the file that holds it. */
interface ImportPositionViolation {
  /** Repository-relative path of the file the detector reported. */
  readonly file: string;
  /** Every private specifier the detector found in import position in that file. */
  readonly specifiers: readonly string[];
}

/** What one build root's recursive walk found. */
interface BuildRootScan {
  /** Repository-relative root that was walked. */
  readonly root: string;
  /** Absolute path of every `.js` file collected under that root. */
  readonly files: readonly string[];
  /** Total `@repo/` occurrences across every collected file, in any position. */
  readonly privateOccurrences: number;
  /** Files holding at least one private specifier in import position. */
  readonly violations: readonly ImportPositionViolation[];
}

/** Repository-relative spelling of an absolute path, in forward-slash form. */
function relativeToRoot(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

/** Lowercase hex SHA-256 of a buffer: the byte-identity evidence the bite proof asserts. */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every `.js` file under one directory, walked recursively.
 *
 * A missing or unreadable directory yields an empty list instead of throwing: the
 * fail-closed assertion in {@link assertRootHasBundles} owns the message, so an
 * unrun build is reported as an unrun build rather than as a read error.
 *
 * @param directory - Absolute directory to walk.
 * @returns Absolute paths of every collected file, unsorted by contract.
 */
async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJavaScriptFiles(absolutePath)));
    else if (entry.isFile() && entry.name.endsWith(BUNDLE_EXTENSION)) found.push(absolutePath);
  }
  return found;
}

/** Every private specifier in import position in one source text. */
function importPositionSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_POSITION_PRIVATE_SPECIFIER)].map((match) => match[1]);
}

/**
 * Scan one bundle's text for private specifiers in import position.
 *
 * @param absolutePath - File to read.
 * @param label - Name the violation reports, defaulting to the repository-relative path.
 * @returns The violation, or null when the file is clean.
 */
async function importPositionViolation(
  absolutePath: string,
  label: string = relativeToRoot(absolutePath),
): Promise<ImportPositionViolation | null> {
  const specifiers = importPositionSpecifiers(await readFile(absolutePath, "utf8"));
  return specifiers.length === 0 ? null : { file: label, specifiers };
}

/**
 * Walk one build root recursively and count both classes of `@repo/` reference.
 *
 * @param root - Repository-relative build tree to scan.
 * @returns What the walk collected, including the two counts the assertions use.
 */
async function scanBuildRoot(root: string): Promise<BuildRootScan> {
  const files = await collectJavaScriptFiles(path.join(REPO_ROOT, root));
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  let privateOccurrences = 0;
  const violations: ImportPositionViolation[] = [];
  files.forEach((file, index) => {
    const source = sources[index];
    privateOccurrences += source.match(PRIVATE_REFERENCE)?.length ?? 0;
    const specifiers = importPositionSpecifiers(source);
    if (specifiers.length > 0) violations.push({ file: relativeToRoot(file), specifiers });
  });
  return { root, files, privateOccurrences, violations };
}

/** Scan both build trees, so every assertion below covers the same union of files. */
async function scanAllBuildRoots(): Promise<BuildRootScan[]> {
  return Promise.all(BUILD_ROOTS.map((root) => scanBuildRoot(root)));
}

/**
 * Assert one root actually yielded files. This is the fail-closed gate, and it runs
 * before any count is trusted.
 *
 * @param scan - The root's scan, possibly empty.
 */
function assertRootHasBundles(scan: BuildRootScan): void {
  const state = scan.files.length === 0 ? `collected no ${BUNDLE_EXTENSION} file under ${scan.root}` : "";
  expect(
    scan.files.length,
    `${state}, so the build has not run; run \`${BUILD_COMMAND}\` before trusting this guard`,
  ).toBeGreaterThan(0);
}

/**
 * The bundle the bite self-test injects into: the first collected file that is not
 * a copied viewer asset, chosen deterministically from the real walk so no path is
 * hardcoded here.
 *
 * @param files - Every collected file across both roots.
 * @returns Absolute path of the injection target.
 */
function chooseBiteTarget(files: readonly string[]): string {
  const target = files.filter((file) => !relativeToRoot(file).includes(ASSET_SEGMENT)).sort().at(0);
  if (target === undefined) {
    throw new Error(`found no entry bundle to inject into, so the build has not run; run \`${BUILD_COMMAND}\``);
  }
  return target;
}

it("walks each build root recursively, never just its top level", async () => {
  const scans = await scanAllBuildRoots();
  for (const scan of scans) {
    assertRootHasBundles(scan);
    const topLevel = scan.files.filter((file) => path.dirname(file) === path.join(REPO_ROOT, scan.root));
    const manualGrepScope = `the manual \`grep '@repo/[a-z-]*' ${scan.root}/*.js\` saw only the top level`;
    expect(scan.files.length, `${scan.root}: ${manualGrepScope}, so the walk must descend`).toBeGreaterThan(
      topLevel.length,
    );
  }
});

it("fails closed, naming the root and the build, when a root yields no file", () => {
  for (const root of BUILD_ROOTS) {
    const empty: BuildRootScan = { root, files: [], privateOccurrences: 0, violations: [] };
    const run = () => assertRootHasBundles(empty);
    expect(run, `${root}: an empty walk must fail, never pass`).toThrow(root);
    expect(run, `${root}: the failure must state the build precondition`).toThrow(BUILD_COMMAND);
  }
});

it("ships no private-package specifier in import position", async () => {
  const scans = await scanAllBuildRoots();
  for (const scan of scans) assertRootHasBundles(scan);
  const violations = scans.flatMap((scan) =>
    scan.violations.map((violation) => `${violation.file}: ${violation.specifiers.join(", ")}`),
  );
  expect(
    violations,
    "a private workspace package reached import position, so the shipped bundle imports modules the consumer does not have",
  ).toEqual([]);
});

it("pins the total private-package occurrence count at the measured baseline", async () => {
  const scans = await scanAllBuildRoots();
  for (const scan of scans) assertRootHasBundles(scan);
  const total = scans.reduce((sum, scan) => sum + scan.privateOccurrences, 0);
  expect(
    total,
    `the total @repo/ count moved; a rise means new private data reached the bundle, a fall means the pin must be lowered (to 0 once commands/host.ts leaves)`,
  ).toBe(PINNED_TOTAL_PRIVATE_OCCURRENCES);
});

it("bites an injected private specifier in a scratch copy, never writing dist/", async () => {
  const scans = await scanAllBuildRoots();
  const target = chooseBiteTarget(scans.flatMap((scan) => scan.files));
  const label = relativeToRoot(target);
  const original = await readFile(target);
  const scratch = await mkdtemp(path.join(tmpdir(), SCRATCH_PREFIX));
  try {
    const copy = path.join(scratch, path.basename(target));
    await copyFile(target, copy);
    expect(sha256(await readFile(copy)), `${label}: the scratch copy must start byte-identical`).toBe(
      sha256(original),
    );
    await appendFile(copy, INJECTED_SOURCE_SUFFIX);
    const violation = await importPositionViolation(copy, label);
    expect(violation?.specifiers, `${label}: the detector must report the injected specifier`).toEqual([
      INJECTED_SPECIFIER,
    ]);
    expect(violation?.file, "the violation must name the file it found").toBe(label);
    await writeFile(copy, original);
    expect(sha256(await readFile(copy)), `${label}: restoring the copy must be byte-identical`).toBe(
      sha256(original),
    );
    expect(sha256(await readFile(target)), `${label}: the real bundle must never be written`).toBe(sha256(original));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
