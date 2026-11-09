/**
 * @file Pin the build stamp to at least one directory that really holds the
 * sources it claims to hash.
 *
 * `scripts/build-stamp.ts` decides whether `test/global-setup.ts` may skip the
 * ~42s tsup rebuild by hashing `INPUT_DIRS`. Every failure direction there is
 * loud except one: a list whose entries no longer hold sources hashes an empty
 * input set, so the cache reports "fresh" for a tree it never watched — the same
 * silent-green shape `scripts/test-partition.ts` produced with a stale root.
 *
 * This probe asserts COVERAGE, not the absence of the deliberate dead `"src"`
 * entry: that entry is documented in the file, `hashDir` swallows its ENOENT,
 * and `test/build-stamp.test.ts` seeds a scratch `src/` as its input fixture.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The module whose `INPUT_DIRS` is pinned. */
const SCRIPT = "scripts/build-stamp.ts";

/** The `INPUT_DIRS` entries, read from the script's own source. */
function inputDirectories(): string[] {
  const source = ts.createSourceFile(SCRIPT, readFileSync(SCRIPT, "utf8"), ts.ScriptTarget.Latest, true);
  let entries: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "INPUT_DIRS") {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isArrayLiteralExpression(initializer)) {
        entries = initializer.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return entries;
}

/** Does this directory hold a TypeScript file anywhere below it? */
function holdsTypeScript(directory: string): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isDirectory()) return entry.name.endsWith(".ts");
    const skippable = entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git";
    return !skippable && holdsTypeScript(path.join(directory, entry.name));
  });
}

describe("build stamp source coverage", () => {
  it("hashes at least one directory that really holds the sources", () => {
    const directories = inputDirectories();
    expect(directories.length).toBeGreaterThan(0);
    const covered = directories.filter(holdsTypeScript);
    expect(covered, `INPUT_DIRS covers no directory holding .ts files: ${directories.join(", ")}`).not.toEqual([]);
  });

  it("reports no coverage for a tree whose directories hold no sources", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stamp-coverage-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src/README.md"), "no sources here\n");
      expect([path.join(root, "src"), path.join(root, "absent")].filter(holdsTypeScript)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
