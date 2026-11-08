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
 * 2. THE ALIAS BRIDGE. The narrow path is `vitest related`, whose import graph
 *    crosses dimensions only through the `llmwiki-kg` alias in
 *    `vitest.config.ts`: `src/dimensions/activation.ts` imports the BARE
 *    specifier, and no relative import crosses into `packages/`. Vitest
 *    following aliases is not the fragile part — the mapping inside the config
 *    file is, by edit or by deletion. So the regression worth pinning is a
 *    mapping that stops resolving to the kg entry point, that points at a file
 *    which no longer exists, or that starts matching longer specifiers and
 *    redirects unrelated imports.
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

/** The bare specifier the root dimension imports; only the alias can resolve it. */
const KG_BARE_SPECIFIER = "llmwiki-kg";

/** The file that bare specifier must arrive at, repository-relative. */
const KG_ENTRY = "packages/llmwiki-kg/ts/src/core-index.ts";

/** Prefix of the second dimension's test tree. */
const KG_TREE = "packages/llmwiki-kg/";

/** Prefix of the first dimension's test tree. */
const ROOT_TREE = "test/";

/** A real root module that imports the bare specifier, so the alias has a consumer. */
const KG_ALIAS_CONSUMER = "src/dimensions/activation.ts";

/** Inputs whose change reaches every file, so a narrow selection would be a lie. */
const ESCALATION_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.test.json",
  "scripts/test-partition.ts",
];

/** One `resolve.alias` entry, as `vitest.config.ts` declares them. */
interface AliasRule {
  find: string | RegExp;
  replacement: string;
}

/**
 * Test a rule's `find` against one specifier.
 *
 * A fresh `RegExp` is built per call so a stateful `lastIndex` on a re-tested
 * pattern cannot make a later assertion depend on an earlier one.
 */
function matchesSpecifier(rule: AliasRule, specifier: string): boolean {
  return typeof rule.find === "string"
    ? rule.find === specifier
    : new RegExp(rule.find).test(specifier);
}

/**
 * Load the alias rules from the REAL config file rather than from a copy.
 *
 * Importing the config is what makes this a pin: a rewrite of
 * `vitest.config.ts` that no longer exports the mapping fails here, and a
 * duplicated table in this test would keep passing while production lost it.
 */
async function loadAliasRules(): Promise<AliasRule[]> {
  const { default: config } = await import("../vitest.config.js");
  const alias = config.resolve?.alias;
  if (!Array.isArray(alias)) {
    throw new Error("vitest.config.ts must declare resolve.alias as an array of rules");
  }
  return alias;
}

/** The alias rule matching the bare `llmwiki-kg` specifier, or a failure explaining the absence. */
async function requireKgAlias(): Promise<AliasRule> {
  const rule = (await loadAliasRules()).find((entry) => matchesSpecifier(entry, KG_BARE_SPECIFIER));
  if (rule === undefined) {
    throw new Error(`vitest.config.ts has no resolve.alias entry matching "${KG_BARE_SPECIFIER}"`);
  }
  return rule;
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

describe("the vitest alias bridges the root dimension into the kg dimension", () => {
  it("matches the bare llmwiki-kg specifier and maps it to the kg entry point", async () => {
    const rule = await requireKgAlias();
    expect(matchesSpecifier(rule, KG_BARE_SPECIFIER), "the rule must match the bare specifier").toBe(true);
    expect(path.relative(ROOT, rule.replacement), "the rule must map to the kg entry point").toBe(KG_ENTRY);
  });

  it("points at a file that exists, so a move or a deletion cannot pass silently", async () => {
    const rule = await requireKgAlias();
    expect(existsSync(rule.replacement), `${KG_ENTRY} is missing — the alias target moved or was deleted`).toBe(true);
  });

  it("does not match a longer specifier that merely starts with llmwiki-kg", async () => {
    const rule = await requireKgAlias();
    const longer = ["llmwiki-kg-other", "llmwiki-kgx", "not-llmwiki-kg"];
    const overreaching = longer.filter((specifier) => matchesSpecifier(rule, specifier));
    expect(overreaching, `the pattern also captures: ${overreaching.join(", ")}`).toEqual([]);
  });

  it("has a real root consumer importing the bare specifier", () => {
    const source = readFileSync(path.join(ROOT, KG_ALIAS_CONSUMER), "utf8");
    expect(source, `${KG_ALIAS_CONSUMER} must import "${KG_BARE_SPECIFIER}" for the alias to matter`).toContain(
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
