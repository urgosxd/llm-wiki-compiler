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
 * The one documented exception, keyed so adding a comment cannot break it.
 *
 * `scripts/build-stamp.ts` declares `INPUT_DIRS = ["src", "packages", "scripts"]`:
 * `src` no longer exists, `hashDir` swallows the ENOENT so it contributes no hash
 * input, and `packages` still feeds the hash — but the entry stays because
 * `test/build-stamp.test.ts` seeds a scratch `src/` as its fixture and asserts the
 * hash moves when it changes. This probe asserts nothing about that entry's absence,
 * only that no OTHER one exists.
 *
 * WHY THE KEY IS `file:owner[literal]` AND NOT `file:line`. This pin used to be
 * `scripts/build-stamp.ts:47`, and adding three doc-comment lines above `INPUT_DIRS`
 * moved the statement to line 52 — a CORRECT change that turned this guard red and
 * invited the next person to paste a new number. A `file:line` key counts comment
 * lines, which is not what the guard is about. The key below names the walk itself:
 * the `*_DIRS`/`*_ROOTS` variable that owns it and the exact root-`src` literal inside
 * it, or for a filesystem call the callee and that literal. It is exactly as strict —
 * one specific pre-existing walk is permitted, and a new walk anywhere (a different
 * file, a different list, a different literal, a different callee) produces a key that
 * is not in this set — while being invariant to formatting above it. Adding a
 * NON-`src` element to the same list no longer breaks the pin either, which is right:
 * no new stale walk appeared.
 */
const ALLOWED = new Set<string>(["scripts/build-stamp.ts:INPUT_DIRS[src]"]);

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

/** One executable root `src` walk: where it is for the reader, and how it is pinned. */
interface RootSrcWalk {
  /** `path:line`, reported in the failure. NEVER a pin: a comment edit moves it. */
  readonly site: string;
  /** `path:<owner>[<literal>]` or `path:<callee>(<literal>)` — stable across comment lines. */
  readonly pin: string;
}

/** A walk-root list: the `*_DIRS`/`*_ROOTS` variable that owns it and its elements. */
interface WalkRootList {
  /** The declared variable name, which is what a pin keys on. */
  readonly owner: string;
  /** The array literal's elements. */
  readonly elements: readonly ts.Expression[];
}

/** Is this a walk-root list — a `*_DIRS`/`*_ROOTS` array literal a walker iterates? */
function walkRootList(node: ts.Node): WalkRootList | undefined {
  const named = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
  if (!named || !/(DIRS|ROOTS)$/.test(node.name.text)) return undefined;
  const initializer = node.initializer;
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) return undefined;
  return { owner: node.name.text, elements: initializer.elements };
}

/** Records one detected walk: its node (for the line) and its line-independent pin. */
type WalkRecorder = (node: ts.Node, pin: string) => void;

/** Record one call expression as a walk when its first path argument names root `src`. */
function recordCallWalk(node: ts.CallExpression, record: WalkRecorder): void {
  const literal = firstPathArgument(node) ?? "";
  if (!namesRootSrc(literal)) return;
  record(node, `${calleeName(node)}(${literal})`);
}

/** Record every root-`src` element of one walk-root list, pinned by owner and literal. */
function recordListWalks(list: WalkRootList, record: WalkRecorder): void {
  const rootSrc = list.elements.filter(
    (element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element) && namesRootSrc(element.text),
  );
  for (const element of rootSrc) record(element, `${list.owner}[${element.text}]`);
}

/** Every executable root `src` walk in one file, with a human site and a stable pin. */
function rootSrcWalks(file: string): RootSrcWalk[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const walks: RootSrcWalk[] = [];
  const record: WalkRecorder = (node, pin) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    walks.push({ site: `${file}:${line}`, pin: `${file}:${pin}` });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) recordCallWalk(node, record);
    const list = walkRootList(node);
    if (list !== undefined) recordListWalks(list, record);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return walks;
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
      .filter((walk) => !ALLOWED.has(walk.pin));
    expect(violations.map((walk) => describeWalk(walk.site))).toEqual([]);
  });

  it("pins a walk independently of the comment lines above it", () => {
    // The pin this guard used to carry was `path:line`, so three doc-comment lines
    // above `INPUT_DIRS` in `scripts/build-stamp.ts` turned a correct change into a
    // red. The site still reports a line for the reader; the PIN must not count them.
    const root = mkdtempSync(path.join(tmpdir(), "root-src-walk-"));
    try {
      const probe = path.join(root, "probe.ts");
      const body = 'const FIX_DIRS = ["src"];\n';
      writeFileSync(probe, body);
      const before = rootSrcWalks(probe);
      writeFileSync(probe, `/**\n * A doc comment.\n * Two more lines.\n */\n${body}`);
      const after = rootSrcWalks(probe);
      expect(after, "still exactly one walk").toHaveLength(1);
      expect(after[0]?.site, "the reported line is expected to move, which is why it is not the pin").not.toBe(
        before[0]?.site,
      );
      expect(after[0]?.pin, "the pin must survive a comment edit above the walk").toBe(before[0]?.pin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a synthetic walk with its path, line and reason", () => {
    const root = mkdtempSync(path.join(tmpdir(), "root-src-walk-"));
    try {
      const probe = path.join(root, "probe.ts");
      writeFileSync(probe, 'const FIX_DIRS = ["src", "test"];\nreaddirSync("src/viewer");\n');
      expect(rootSrcWalks(probe).map((walk) => describeWalk(walk.site))).toEqual([
        `${probe}:1: stale root src walk`,
        `${probe}:2: stale root src walk`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
