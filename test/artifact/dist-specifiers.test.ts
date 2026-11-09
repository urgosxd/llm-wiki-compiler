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
 * The empty list is also the ONLY way a root may fail quietly, and it is reserved
 * for a root that does not exist. An unreadable subdirectory — a permission
 * failure, a path that is not a directory, anything else a read can throw — fails
 * the guard and names itself, because an under-collected scan that passes is this
 * file's own failure mode wearing its badge. What a text guard cannot see at all is
 * a specifier assembled at runtime; see the limits section below.
 *
 * ## What a static text guard cannot see
 *
 * This guard reads bundle TEXT, so it sees only specifiers that survive into the
 * file as contiguous text. Two assembled shapes have to be told apart, because only
 * one of them is caught here at all:
 *
 * - `"@repo/" + "kg"` — the literal `@repo/` survives in the bundle, so this is
 *   caught by the TOTAL ratchet below, as a rise in the count. The import-position
 *   assertion sees no import, which is exactly why the ratchet exists.
 * - `"@re" + "po/kg"` — assembled so that no contiguous `@repo/` ever appears in
 *   the file. NEITHER assertion can see it. A static text guard cannot, by
 *   construction, and no amount of care in this file changes that.
 *
 * That residue is covered at RUNTIME instead: `test/artifact/entries-load.test.ts`
 * imports all four published entries and evaluates their whole static chunk graph,
 * so a specifier that ever resolved to raw TypeScript the consumer does not have
 * fails there even when this file's text says nothing. The two guards complement
 * each other; neither replaces the shipped-bundle spawn guard at
 * `test/cli.test.ts:58-62`.
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
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

/** Mode that withdraws read and traverse permission, for the unreadable-directory probe. */
const READ_PERMISSION_REVOKED = 0o000;

/** Mode restored in a `finally`, so a failed probe never leaves an unreadable directory behind. */
const READ_PERMISSION_RESTORED = 0o755;

/** A private-package reference, counted anywhere in one bundle's text. */
const PRIVATE_REFERENCE = /@repo\//g;

/**
 * Private-package specifiers in IMPORT POSITION: the only form Node resolves at
 * runtime, and so the only form that can break a consumer's install. The shapes
 * below are written with the concrete `@repo/kg`, which stands in for any private
 * workspace package, and they are exactly seven:
 *
 * - `import … from "@repo/kg"` — a static import's `from` clause;
 * - `export … from "@repo/kg"` — the same clause, re-exporting;
 * - `import "@repo/kg"` — a side-effect import, which has no `from` clause at all
 *   and would slip past a detector that only knew the `from`/`(` forms;
 * - `import("@repo/kg")` — a dynamic import;
 * - `require("@repo/kg")` — a CommonJS require, which a bundle may leave in place;
 * - `require.resolve("@repo/kg")` — the same require reached through its resolver.
 *   It needs its own alternative: the `require` form requires a parenthesis right
 *   after the callee, and a `.` is not one, so `require` alone never matched it;
 * - any of the above with a BACKTICK for the quote — the template-literal form —
 *   which is why the quote class admits `"`, `'` and a backtick on both sides.
 *
 * The whitespace before the quote is load-bearing: esbuild emits `from"…"` with no
 * space at all. The `\b` keeps `from` from matching the tail of a longer
 * identifier, such as `transform`, and the optional `\(` covers the call forms
 * without letting `import {x} from …` report twice: the `{` after `import` fails
 * `\s*\(?\s*["'`]`, so only the `from` clause matches.
 */
const IMPORT_POSITION_PRIVATE_SPECIFIER =
  /(?:\bfrom|\bimport\b|\brequire\.resolve\b|\brequire\b)\s*\(?\s*["'`](@repo\/[^"'`]*)["'`]/g;

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
 * ANY read failure is fatal and propagates with the directory it names. A walk that
 * silently shrinks its own scope is this file's failure mode reproduced inside the
 * thing meant to prevent it, so an empty list here can only mean "this directory
 * holds no bundle", never "something could not be read".
 *
 * @param directory - Absolute directory to walk.
 * @returns Absolute paths of every collected file, unsorted by contract.
 */
async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJavaScriptFiles(absolutePath)));
    else if (entry.isFile() && entry.name.endsWith(BUNDLE_EXTENSION)) found.push(absolutePath);
  }
  return found;
}

/** The two fields of a filesystem error this file decides on. */
interface DirectoryReadFailure {
  /** `ENOENT`, `EACCES`, `ENOTDIR`, … when Node supplies one. */
  readonly code?: string;
  /** The path the failing call was given, which is what tells root from descendant. */
  readonly path?: string;
}

/**
 * True when a read failed because the directory ITSELF is absent, rather than
 * because something inside it could not be read.
 *
 * Both halves are required. `ENOENT` alone would also swallow a subdirectory that
 * vanished mid-walk, and `path` alone would swallow a permission failure on the
 * root, which must fail loudly.
 *
 * @param error - What a directory read threw.
 * @param directory - The directory that read was given.
 * @returns Whether the root, specifically, does not exist.
 */
function isAbsentDirectory(error: unknown, directory: string): boolean {
  const failure = error as DirectoryReadFailure;
  return failure.code === "ENOENT" && failure.path === directory;
}

/**
 * Collect one BUILD ROOT's bundles, where a wholly absent root is legitimate: it is
 * the "the build has not run" case, and {@link assertRootHasBundles} reports it with
 * a message naming the build command instead of an `ENOENT` stack.
 *
 * Only the root's own absence is swallowed. An unreadable SUBDIRECTORY throws, with
 * the directory named, so the scan can never under-collect and still pass.
 *
 * @param directory - Absolute build root to walk.
 * @returns Absolute paths of every collected file, empty only when the root is absent.
 */
async function collectBundleFilesUnder(directory: string): Promise<string[]> {
  try {
    return await collectJavaScriptFiles(directory);
  } catch (error) {
    if (isAbsentDirectory(error, directory)) return [];
    throw error;
  }
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
  const files = await collectBundleFilesUnder(path.join(REPO_ROOT, root));
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

it("yields an empty list only for an absent root, which then fails closed", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), SCRATCH_PREFIX));
  const absent = path.join(scratch, "never-created");
  try {
    const emptyRoot = await collectBundleFilesUnder(absent);
    expect(emptyRoot, "an absent root is the one case that may yield nothing to scan").toEqual([]);
    const scan: BuildRootScan = { root: absent, files: emptyRoot, privateOccurrences: 0, violations: [] };
    const run = () => assertRootHasBundles(scan);
    expect(run, "an absent root must then trip the fail-closed assertion, never pass").toThrow(absent);
    expect(run, "the fail-closed failure must still state the build precondition").toThrow(BUILD_COMMAND);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("fails naming the path it could not read as a directory, never shrinking the scan", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), SCRATCH_PREFIX));
  const regularFile = path.join(scratch, "not-a-directory.js");
  try {
    await writeFile(regularFile, "export const x = 1;\n");
    await expect(collectBundleFilesUnder(regularFile), "a path that exists but is not readable as a directory must fail").rejects.toThrow(
      regularFile,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
  "fails naming a permission-locked directory instead of returning it as empty",
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), SCRATCH_PREFIX));
    const locked = path.join(scratch, "locked");
    try {
      await mkdir(path.join(locked, "nested"), { recursive: true });
      await chmod(locked, READ_PERMISSION_REVOKED);
      try {
        await expect(collectBundleFilesUnder(locked), "an unreadable subdirectory must fail, naming itself").rejects.toThrow(
          locked,
        );
      } finally {
        await chmod(locked, READ_PERMISSION_RESTORED);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

it("detects every quote form of a private specifier, including require.resolve", () => {
  const forms = ['require.resolve("@repo/kg")', "import(`@repo/kg`)", "from `@repo/kg`", "from '@repo/kg'"];
  expect(
    forms.map((form) => importPositionSpecifiers(form)),
    "the detector must see the require.resolve callee and a template-literal quote as well as ' and \"",
  ).toEqual(forms.map(() => [INJECTED_SPECIFIER]));
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
