/**
 * @file Pin the two properties that let `npm run test:affected` treat BOTH
 * dimensions of this suite as one reachable graph.
 *
 * The affected selector has one job: never report success for a file it never
 * looked at. It loses a dimension in exactly two ways, and they are not
 * symmetric.
 *
 * 1. THE ESCALATION TIER. A suite-wide change runs the tier that
 *    `scripts/test-partition.ts` produces by enumeration, and that tier used to
 *    walk `test/` alone — so every `packages/llmwiki-kg` suite went unrun on
 *    precisely the changes able to break all of them. The enumeration now covers
 *    every tree that `vitest run` collects from. What is still unpinned is the
 *    END of that road: `announceTier` builds the file list and
 *    `planAffectedInvocations` turns it into argv, and nothing asserted that a
 *    global scope's argv actually carries a kg path. A list covering one
 *    dimension is indistinguishable from a correct one by length, so the
 *    assertion has to name both trees.
 *
 * 2. THE PACKAGE BRIDGE. The narrow path is `vitest related`, whose import graph
 *    crosses dimensions through the bare specifier `@repo/kg`:
 *    `src/dimensions/activation.ts` imports the BARE specifier, and no relative
 *    import crosses into `packages/`. Nothing maps that specifier any more — no
 *    `tsconfig` path alias and no `vitest` alias, both deleted when the package
 *    became a real workspace member — so the resolution now lives in the
 *    package's own `exports` map plus the root manifest's declared dependency.
 *    That is the mapping that is fragile, by edit or by deletion. So the
 *    regression worth pinning is an `exports` map that stops resolving to the
 *    kg entry point, that points at a file which no longer exists, or that
 *    starts capturing longer specifiers from a wildcard and redirects unrelated
 *    imports.
 *
 *    The declaration is pinned in `devDependencies`, and the placement is part
 *    of the pin rather than incidental: `@repo/kg` is `private: true` and is
 *    bundled into `dist/`, so it is a build/type-time edge. Declared under
 *    `dependencies` it became both a specifier the shipped bundle could not
 *    resolve and a `workspace:*` range `npm` refuses to install from a tarball
 *    (`EUNSUPPORTEDPROTOCOL`). What is asserted is unchanged — a real workspace
 *    edge exists at the root, which is what makes the specifier resolve for the
 *    bundler and for `vitest related` — only the manifest field that must carry
 *    it moved.
 *
 * A crawl proving `vitest related` honours the alias was considered and dropped
 * by decision: it costs ~155 seconds and can only fail once one of the two
 * properties pinned here already fails. Milliseconds here, same bugs caught.
 *
 * NO SUBPROCESS CALL SITE, DELIBERATELY. Classification in
 * `scripts/test-partition.ts` is by content, so this file lands in the `unit`
 * tier — the very tier escalation runs. A pin that lived in the slow tier would
 * never execute on the path it protects.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planAffectedInvocations, type VitestInvocation } from "../scripts/output-contracts.js";
import { isGlobalScope } from "../scripts/test-affected.js";
import { classifyTests, partition } from "../scripts/test-partition.js";

const ROOT = path.resolve(".");

/** The bare specifier the root dimension imports; only the package bridge resolves it. */
const KG_BARE_SPECIFIER = "@repo/kg";

/** The file that bare specifier must arrive at, repository-relative. */
const KG_ENTRY = "packages/llmwiki-kg/ts/src/core-index.ts";

/** The manifest that owns the bridge: the KG package's own `exports` map. */
const KG_MANIFEST = "packages/llmwiki-kg/ts/package.json";

/** The manifest that has to consume it, or the specifier resolves nowhere. */
const ROOT_MANIFEST = "package.json";

/** Prefix of the second dimension's test tree. */
const KG_TREE = "packages/llmwiki-kg/";

/** Prefix of the first dimension's test tree. */
const ROOT_TREE = "test/";

/** A real root module that imports the bare specifier, so the bridge has a consumer. */
const KG_ALIAS_CONSUMER = "packages/wiki/src/dimensions/activation.ts";

/** Inputs whose change reaches every file, so a narrow selection would be a lie. */
const ESCALATION_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.test.json",
  "scripts/test-partition.ts",
];

/** One `exports` target: a plain file string, or a condition map naming one. */
type ExportTarget = string | Record<string, string>;

/** Only the manifest surface this file reads. */
interface KgManifest {
  exports?: Record<string, ExportTarget>;
}

/**
 * Load the KG package's own manifest, which is where the bridge lives now.
 *
 * Reading the REAL manifest rather than a copy is what makes this a pin: an
 * `exports` map rewritten to stop resolving the bare specifier fails here, and a
 * duplicated table in this test would keep passing while production lost it.
 */
function loadKgManifest(): KgManifest {
  return JSON.parse(readFileSync(path.join(ROOT, KG_MANIFEST), "utf8")) as KgManifest;
}

/**
 * The file an `exports` target names, unwrapped from a condition map.
 *
 * @param target - One `exports["."]` value, or `undefined` when the key is absent.
 * @returns The target path as written, or null when the key states none.
 */
function targetFile(target: ExportTarget | undefined): string | null {
  if (typeof target === "string") return target;
  if (target === undefined) return null;
  return target.types ?? target.import ?? Object.values(target)[0] ?? null;
}

/** The repository-relative file the bare `@repo/kg` specifier exports. */
function requireKgBridge(): string {
  const entry = targetFile(loadKgManifest().exports?.["."]);
  if (entry === null) {
    throw new Error(`${KG_MANIFEST} has no exports["."] entry, so "${KG_BARE_SPECIFIER}" cannot resolve`);
  }
  return path.relative(ROOT, path.join(path.dirname(KG_MANIFEST), entry)).split(path.sep).join("/");
}

/**
 * Whether a file list covers both dimensions.
 *
 * This is the predicate applied to the real world below AND to the narrowed list
 * beside it, so the test cannot pass by asserting something the narrowed list
 * would also satisfy.
 */
function coversBothDimensions(files: readonly string[]): boolean {
  const isKgTree = (file: string): boolean => file.startsWith(KG_TREE);
  const isRootTree = (file: string): boolean => file.startsWith(ROOT_TREE);
  return files.some(isKgTree) && files.some(isRootTree);
}

/** The files a plan's `run` invocation names, ignoring flags. */
function runFiles(plan: readonly VitestInvocation[]): string[] {
  const invocation = plan.find((entry) => entry.argv[0] === "run");
  if (invocation === undefined) return [];
  return invocation.argv.slice(1).filter((argument) => !argument.startsWith("-"));
}

const UNIT_FILES = partition(classifyTests(ROOT)).unit;

describe("the package bridge carries the root dimension into the kg dimension", () => {
  it("exports the bare @repo/kg specifier from the kg entry point", () => {
    expect(requireKgBridge(), `exports["."] must map to ${KG_ENTRY}`).toBe(KG_ENTRY);
  });

  it("points at a file that exists, so a move or a deletion cannot pass silently", () => {
    expect(existsSync(path.join(ROOT, KG_ENTRY)), `${KG_ENTRY} is missing — the exports target moved or was deleted`).toBe(
      true,
    );
  });

  it("declares the dependency at the root, so nothing has to fake the mapping", () => {
    const root = JSON.parse(readFileSync(path.join(ROOT, ROOT_MANIFEST), "utf8")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(root.devDependencies?.[KG_BARE_SPECIFIER], `root must depend on ${KG_BARE_SPECIFIER}`).toBe("workspace:*");
    expect(
      root.dependencies?.[KG_BARE_SPECIFIER],
      `${KG_BARE_SPECIFIER} is bundled into dist/, so a runtime dependency would ship a workspace: range npm rejects`,
    ).toBeUndefined();
  });

  it("does not capture a longer specifier that merely starts with @repo/kg", () => {
    const wildcards = Object.keys(loadKgManifest().exports ?? {}).filter((key) => key.includes("*"));
    expect(wildcards, `the exports map also captures: ${wildcards.join(", ")}`).toEqual([]);
  });

  it("has a real root consumer importing the bare specifier", () => {
    const source = readFileSync(path.join(ROOT, KG_ALIAS_CONSUMER), "utf8");
    expect(source, `${KG_ALIAS_CONSUMER} must import "${KG_BARE_SPECIFIER}" for the bridge to matter`).toContain(
      `from "${KG_BARE_SPECIFIER}"`,
    );
  });
});

describe("a global scope escalates to a run that covers both dimensions", () => {
  it("keeps kg test files in the tier escalation actually runs", () => {
    const kgFiles = UNIT_FILES.filter((file) => file.startsWith(KG_TREE));
    expect(kgFiles.length, "the escalated unit tier must contain kg suites").toBeGreaterThan(0);
  });

  it("builds a global-scope argv naming a kg test and a root test", () => {
    const plan = planAffectedInvocations({ kind: "global", reason: "scripts/ affects the whole suite" }, UNIT_FILES);
    const files = runFiles(plan);
    expect(files.length, "a global scope must produce one `run` invocation with files").toBeGreaterThan(0);
    expect(coversBothDimensions(files), "the escalated argv must name both dimensions").toBe(true);
  });

  it("would catch a tier that dropped the kg dimension, using the same predicate", () => {
    const rootOnly = UNIT_FILES.filter((file) => file.startsWith(ROOT_TREE));
    expect(rootOnly.length, "the narrowed list must still be non-empty to prove anything").toBeGreaterThan(0);
    expect(coversBothDimensions(UNIT_FILES), "the real tier covers both dimensions").toBe(true);
    expect(coversBothDimensions(rootOnly), "a test/-only tier must not satisfy the predicate").toBe(false);
  });

  it("treats every suite-wide input as global scope", () => {
    const quiet = ESCALATION_INPUTS.filter((file) => !isGlobalScope(file));
    expect(quiet, `no longer escalating: ${quiet.join(", ")}`).toEqual([]);
  });
});
