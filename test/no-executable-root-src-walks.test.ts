/**
 * @file Refuse an executable walk over the root `src/` tree the `@repo/wiki`
 * relocation deleted.
 *
 * This is the class that shipped two defects past six green gates: `tsc` reads
 * the import graph, `lint` reads file globs, `build` copies what its config
 * enumerates and `fallow` attributes by path — not one of them EXECUTES a walk,
 * so a literal still aimed at a root `src/` passes every fast gate while the
 * command that reads it either fails loudly (`test/test-partition.test.ts`) or,
 * worse, guards the absence and reports success over a tree it never read
 * (`scripts/test-partition.ts`, `scripts/test-typecheck-program.ts`).
 *
 * Two shapes count as an executable walk: a filesystem call whose first string
 * argument names root `src`, and a walk-root list — a `*_DIRS`/`*_ROOTS` array
 * literal a walker iterates — naming one. The second shape is the build stamp's
 * `INPUT_DIRS`, which is how the cache silently stops watching a moved tree.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Filesystem functions whose first string argument is a path they walk or open. */
const FS_CALLS = new Set([
  "readdirSync",
  "existsSync",
  "readFileSync",
  "statSync",
  "openSync",
  "join",
  "resolve",
  "execFileSync",
  "glob",
]);

/**
 * The one documented exception. `scripts/build-stamp.ts:47` declares
 * `INPUT_DIRS = ["src", "packages", "scripts"]`: `src` no longer exists, `hashDir`
 * swallows the ENOENT so it contributes no hash input, and `packages` still feeds
 * the hash — but the entry stays because `test/build-stamp.test.ts` seeds a
 * scratch `src/` as its fixture and asserts the hash moves when it changes. This
 * probe asserts nothing about that entry's absence, only that no OTHER one exists.
 */
const ALLOWED = new Set<string>(["scripts/build-stamp.ts:47"]);

/** Does this literal name the root `src` tree the relocation deleted? */
function namesRootSrc(literal: string): boolean {
  return literal === "src" || literal.startsWith("src/");
}

/** The callee's last name segment, so `path.join` and `join` read as one call. */
function calleeName(node: ts.CallExpression): string {
  return node.expression.getText().split(".").pop() ?? "";
}

/** The first string-literal argument of a filesystem call, when it has one. */
function firstPathArgument(node: ts.CallExpression): string | undefined {
  if (!FS_CALLS.has(calleeName(node))) return undefined;
  return node.arguments.filter(ts.isStringLiteralLike)[0]?.text;
}

/** Is this a walk-root list — a `*_DIRS`/`*_ROOTS` array literal a walker iterates? */
function walkRootList(node: ts.Node): ts.ArrayLiteralExpression | undefined {
  const named = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
  if (!named || !/(DIRS|ROOTS)$/.test(node.name.text)) return undefined;
  const initializer = node.initializer;
  return initializer !== undefined && ts.isArrayLiteralExpression(initializer) ? initializer : undefined;
}

/** Every executable root `src` walk in one file, as `path:line`. */
function rootSrcWalks(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const record = (node: ts.Node): void => {
    hits.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && namesRootSrc(firstPathArgument(node) ?? "")) record(node);
    for (const element of walkRootList(node)?.elements ?? []) {
      if (ts.isStringLiteralLike(element) && namesRootSrc(element.text)) record(element);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** Every script and fixture file this probe reads. */
function scannedFiles(): string[] {
  const scripts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs)$/.test(entry.name)) scripts.push(full);
    }
  };
  walk("scripts");
  const fixtures = readdirSync("test/fixtures")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join("test/fixtures", name));
  return [...scripts, ...fixtures];
}

/** The message one call site fails with: where it is, and the failure class by name. */
function describeWalk(site: string): string {
  return `${site}: stale root src walk`;
}

describe("executable root src walks", () => {
  it("finds none in the scripts or the fixtures", () => {
    const violations = scannedFiles()
      .flatMap(rootSrcWalks)
      .filter((site) => !ALLOWED.has(site));
    expect(violations.map(describeWalk)).toEqual([]);
  });

  it("reports a synthetic walk with its path, line and reason", () => {
    const root = mkdtempSync(path.join(tmpdir(), "root-src-walk-"));
    try {
      const probe = path.join(root, "probe.ts");
      writeFileSync(probe, 'const FIX_DIRS = ["src", "test"];\nreaddirSync("src/viewer");\n');
      expect(rootSrcWalks(probe).map(describeWalk)).toEqual([
        `${probe}:1: stale root src walk`,
        `${probe}:2: stale root src walk`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
