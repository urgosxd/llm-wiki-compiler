/**
 * @file Pin that the root test typecheck program covers the KG package.
 *
 * `npm run typecheck:tests` runs a ratchet over whatever `tsconfig.test.json`
 * selects. The root `tsconfig.json` maps the `llmwiki-kg` path alias into
 * `packages/llmwiki-kg`, so the program reached part of that package only
 * transitively: a KG source file entered the program when some root test
 * imported it, and never otherwise. Every KG `*.test.ts` sat outside the
 * program entirely, which meant the ratchet reported success for files it had
 * never looked at.
 *
 * The include array is therefore a promise about coverage, and this file checks
 * that promise INDEPENDENTLY of the implementation: it walks
 * `packages/llmwiki-kg/ts/src` with plain `fs`, parses the configuration with the
 * TypeScript compiler API, and requires every file on disk to be a program root.
 * A KG file added later, or an include pattern that narrows or disappears, fails
 * here. The failure names the missing files, so the hole is visible in the
 * output rather than in a diff.
 *
 * The assertion is a set comparison, not a total count: a hardcoded number goes
 * stale the first time someone adds a file, and it cannot say which file is
 * missing. This file has no child-process call site, so the content rule keeps
 * it in the fast unit tier.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const CONFIG_NAME = "tsconfig.test.json";
const KG_SOURCE_ROOT = "packages/llmwiki-kg/ts/src";
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const TEST_SUFFIX = ".test.ts";

/** Format a compiler diagnostic the way the CLI would, without a program. */
function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

/**
 * Parse the test configuration and return every program root as an absolute path.
 *
 * `basePath` and `configFileName` are both required: the first resolves relative
 * `include` patterns, the second lets `extends: "./tsconfig.json"` resolve to the
 * repository root instead of the process directory. TypeScript globs skip
 * dot-prefixed names, which is why the disk walk below never relies on them.
 */
function programRoots(): Set<string> {
  const configPath = path.join(ROOT, CONFIG_NAME);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(`${CONFIG_NAME}: ${formatDiagnostic(loaded.error)}`);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, ROOT, undefined, configPath);
  const rejected = parsed.errors.map(formatDiagnostic).join("\n");
  if (rejected) throw new Error(`${CONFIG_NAME} is not usable: ${rejected}`);
  return new Set(parsed.fileNames.map((file) => path.resolve(file)));
}

/** Walk the KG sources on disk, sorted and repo-relative, with a separator filter. */
function kgSourcesOnDisk(keep: (name: string) => boolean): string[] {
  const directory = path.join(ROOT, KG_SOURCE_ROOT);
  const found: string[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !keep(entry.name)) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    found.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
  }
  return found.sort();
}

/** Sources the configuration no longer selects, ready to be printed as evidence. */
function uncovered(keep: (name: string) => boolean): string[] {
  const roots = programRoots();
  return kgSourcesOnDisk(keep).filter((file) => !roots.has(path.join(ROOT, file)));
}

describe("the root test typecheck program covers the KG package", () => {
  it("selects every KG source file, not only the ones a root test imports", () => {
    const missing = uncovered((name) => TYPESCRIPT_EXTENSIONS.some((extension) => name.endsWith(extension)));
    expect(
      missing,
      `${missing.length} KG sources are outside ${CONFIG_NAME}; add ${KG_SOURCE_ROOT}/**/* to its include array: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("selects every KG test file, so the ratchet measures the KG test surface", () => {
    const missing = uncovered((name) => name.endsWith(TEST_SUFFIX));
    expect(
      missing,
      `${missing.length} KG test files are outside ${CONFIG_NAME} and cannot report a regression: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
