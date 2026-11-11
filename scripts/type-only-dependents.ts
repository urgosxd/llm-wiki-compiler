/**
 * @file Find every type-only import edge a collected test carries into a package surface.
 *
 * EDGES ONLY. This module answers one question — "does this test import a TYPE from this
 * package's source?" — and deliberately does NOT answer "can the selection observe it?".
 * That second question needs the TRANSITIVE closure, which is what `partition` computes; an
 * earlier version approximated it here with a set of a file's DIRECT runtime imports and was
 * wrong in the dangerous direction: `test/query-stale-warning.test.ts` reaches `@repo/wiki` at
 * runtime through `test/fixtures/typed-grounding.ts`, is in the 565-file wiki selection, and was
 * still reported as unobservable. A pair is a type-only DEPENDENT only when the edge exists AND
 * the partition did not attribute the test to that package; the caller subtracts, in
 * `deriveTypeOnlyDependents` (`scripts/package-selection.ts`), where the partition result is.
 *
 * THE FOUR ELIDED FORMS, ALL RECOGNISED, because a scanner that knows one of them reports zero
 * the day the codebase writes another:
 *
 *   import type { X } from "./m.js";        importClause.isTypeOnly
 *   import type X from "./m.js";            importClause.isTypeOnly, default binding
 *   import type * as W from "./m.js";       importClause.isTypeOnly, namespace binding
 *   import { type X } from "./m.js";        every named element isTypeOnly, no default, no `*`
 *   export type { X } from "./m.js";        ExportDeclaration.isTypeOnly
 *   export { type X } from "./m.js";        every export element isTypeOnly
 *
 * A declaration that also binds anything at runtime — a default name, a `* as ns` with a value
 * use — emits a real import, so the module IS reached by the module graph and there is no gap.
 * THE ASYMMETRY THAT MUST NEVER PASS. An inline `export { type X } from "…"` read as RUNTIME is
 * not one omitted finding: it makes the file look like it reaches the package at runtime and
 * therefore SUPPRESSES every other genuine type-only edge to that package in the same file. A MISS
 * only omits one finding; THIS IS WRONG IN THE DIRECTION THAT HIDES FINDINGS, which is why the
 * export clause is inspected element by element instead of trusting `isTypeOnly`.
 *
 * SPECIFIERS THIS RESOLVES. A relative specifier is resolved against the importing file and
 * mapped by extension; a bare specifier is matched against a declared surface name, its
 * `@repo/<pkg>/<subpath>` form, and — for a type import aimed at a package's own tree, such as
 * `packages/<dir>/dist/…` — against the surface DIRECTORY as well as its source roots, so a
 * subpath type import cannot escape the scan.
 *
 * THE LIMITS, STATED SO THEY ARE NOT MISTAKEN FOR COVERAGE. Only TOP-LEVEL statements are walked:
 * an `import` nested inside a `declare module` block is not seen. And `require(...)`, a computed
 * `import(expr)` and `new URL("...", import.meta.url)` are calls and strings, not module
 * requests, so they remain invisible to any scan of specifiers — `docs/turborepo.md` names them
 * as undeclared-by-detection rather than pretending this module refuses them.
 *
 * PURE BY CONTRACT: no child process, no network, no writes. It reads the collected files off
 * disk and decides; the caller supplies the universe and the surfaces.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The shape of a declared package surface that this scan needs.
 *
 * Structural on purpose: importing `PackageSurface` would make this module and
 * `package-selection.ts` import each other, and `fallow:ci` fails a circular dependency
 * rather than ignoring it. The caller passes `PACKAGE_SURFACES`, which satisfies this.
 */
export interface Surface {
  /** npm package name, for example `@repo/wiki`. */
  readonly name: string;
  /** Repository-relative directory that owns the package's own tests. */
  readonly directory: string;
  /** Repository-relative roots whose modules attribute a test to this package. */
  readonly sourceRoots: readonly string[];
}

/** One type-only edge: a test, the package it types against, the type and the module. */
export interface TypeOnlyDependent {
  /** Repository-relative POSIX path of the test file. */
  readonly testFile: string;
  /** Declared package the type is imported from. */
  readonly packageName: string;
  /** One imported type that carries the edge; a file may contribute several. */
  readonly typeSpecifier: string;
  /** Repository-relative POSIX path of the module the type is imported from. */
  readonly sourceFile: string;
}

/** The `testFile` + `packageName` pair, which is the unit every assertion compares. */
export interface TypeOnlyPair {
  /** Repository-relative POSIX path of the test file. */
  readonly testFile: string;
  /** The package that pair reaches by type. */
  readonly packageName: string;
}

/** The edges: the pair set, plus the detail rows messages quote. */
export interface TypeOnlyDependents {
  /** Sorted, one per (test file, package). */
  readonly pairs: readonly TypeOnlyPair[];
  /** Sorted detail rows; several per pair when a file imports several types. */
  readonly entries: readonly TypeOnlyDependent[];
}

/** One module a source file reaches, and whether reaching it is elided at runtime. */
interface ModuleReach {
  /** The specifier exactly as written, for resolution. */
  readonly specifier: string;
  /** True when the whole declaration is erased by the compiler. */
  readonly elided: boolean;
  /** The imported or exported names, for the `typeSpecifier` detail. */
  readonly names: readonly string[];
}

/** The names one import declaration contributes, or `[]` when it binds nothing nameable. */
function importNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  const own = clause.name === undefined ? [] : [clause.name.text];
  return [...own, ...bindingNames(clause.namedBindings)];
}

/** The names a named or namespace binding contributes; `*` stands in for a namespace. */
function bindingNames(node: ts.NamedImportBindings | undefined): string[] {
  if (node === undefined) return [];
  if (ts.isNamespaceImport(node)) return ["*"];
  return node.elements.map((element) => element.name.text);
}

/** True when every binding of an import declaration is a type, so it emits nothing. */
function onlyTypeBindings(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/**
 * True when every re-exported name is a type, so the re-export emits nothing.
 *
 * `export type { A } from` is type-only by its own keyword; `export { type A } from` is
 * type-only by its ELEMENTS, and reading only the keyword classified it as runtime — the
 * direction that suppresses real edges instead of inventing one.
 */
function onlyTypeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** The names a re-export clause contributes. */
function exportNames(node: ts.ExportDeclaration): string[] {
  const clause = node.exportClause;
  if (clause === undefined) return [];
  if (ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements.map((element) => element.name.text);
}

/** Every module one source file reaches, from its top-level import and re-export statements. */
function moduleReaches(source: ts.SourceFile): ModuleReach[] {
  const reaches: ModuleReach[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      reaches.push({
        specifier: node.moduleSpecifier.text,
        elided: onlyTypeBindings(node),
        names: importNames(node),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      reaches.push({
        specifier: (node.moduleSpecifier as ts.StringLiteral).text,
        elided: onlyTypeExport(node),
        names: exportNames(node),
      });
    }
  }
  return reaches;
}

/**
 * Every module a piece of source reaches, and which of those reaches are elided.
 *
 * Exported because it is the whole recognition rule and it must be provable WITHOUT a tree:
 * `test/package-selection-union.test.ts` drives this with all four elided forms and with the
 * runtime shapes, so a scanner that learns only one form fails there instead of quietly
 * reporting zero for the others.
 *
 * @param text - Source text of one file.
 * @returns One entry per top-level import or re-export declaration, in source order.
 */
export function moduleReachesOf(text: string): ModuleReach[] {
  return moduleReaches(ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true));
}

/** A repo-relative POSIX path for a relative specifier, with no runtime extension. */
function resolvedModulePath(testFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), specifier));
  return joined.replace(/\.(js|mjs|cjs|jsx)$/u, "");
}

/** True when `file` lives at or under `root`. */
function isUnder(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

/**
 * The package a resolved module path belongs to.
 *
 * A source root is the normal answer. The surface DIRECTORY is the fallback, so a type import
 * aimed at a package's own tree — `packages/<dir>/dist/…`, a build artefact a type declaration
 * can name — still lands on that package instead of escaping the scan.
 */
function packageOf(modulePath: string, surfaces: readonly Surface[]): string | undefined {
  const bySourceRoot = surfaces.find((surface) => surface.sourceRoots.some((root) => isUnder(modulePath, root)));
  if (bySourceRoot !== undefined) return bySourceRoot.name;
  return surfaces.find((surface) => isUnder(modulePath, surface.directory))?.name;
}

/** The package a bare specifier names: the exact surface, or its `@repo/<pkg>/<subpath>` form. */
function packageOfBareSpecifier(specifier: string, surfaces: readonly Surface[]): string | undefined {
  return surfaces.find((surface) => specifier === surface.name || specifier.startsWith(`${surface.name}/`))?.name;
}

/**
 * The package a specifier written in `testFile` names, if any.
 *
 * Exported because specifier attribution is where a type-only import escapes the scan: an
 * exact-name match missed `@repo/<pkg>/<subpath>` (thirteen distinct subpath specifiers are
 * used in `test/` today) and the source-root match missed a type import aimed at
 * `packages/<dir>/dist/…`. The table in `test/package-selection-union.test.ts` pins both.
 *
 * @param testFile - Repository-relative POSIX path of the importing test.
 * @param specifier - The specifier exactly as written.
 * @param surfaces - The declared package surfaces.
 * @returns The declared package name, or undefined when the specifier names no package.
 */
export function packageOfSpecifier(
  testFile: string,
  specifier: string,
  surfaces: readonly Surface[],
): string | undefined {
  const modulePath = resolvedModulePath(testFile, specifier);
  return modulePath === undefined
    ? packageOfBareSpecifier(specifier, surfaces)
    : packageOf(modulePath, surfaces);
}

/** True when the test file already belongs to a package by its own directory. */
function insidePackage(testFile: string, surfaces: readonly Surface[]): boolean {
  return surfaces.some((surface) => isUnder(testFile, surface.directory));
}

/** The text of one collected test file, or undefined when it cannot be read on disk. */
function readTest(file: string, root: string): string | undefined {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

/** Every type-only edge one test file carries into a package. */
function edgesOf(testFile: string, text: string, surfaces: readonly Surface[]): TypeOnlyDependent[] {
  // A source file with no `from` cannot carry any of the elided forms, so the parse is skipped
  // for it. This is a cheap gate, not a heuristic: every recognised form needs the keyword.
  if (!text.includes("from")) return [];
  const source = ts.createSourceFile(`${testFile}.ts`, text, ts.ScriptTarget.Latest, true);
  return moduleReaches(source)
    .filter((reach) => reach.elided)
    .flatMap((reach) => {
      const modulePath = resolvedModulePath(testFile, reach.specifier);
      const owner = packageOfSpecifier(testFile, reach.specifier, surfaces);
      if (owner === undefined) return [];
      const names = reach.names.length === 0 ? ["*"] : reach.names;
      return names.map((typeSpecifier) => ({
        testFile,
        packageName: owner,
        typeSpecifier,
        sourceFile: modulePath ?? reach.specifier,
      }));
    });
}

/**
 * Every type-only edge the collected suite carries into any package surface.
 *
 * NO SELECTION LOGIC HERE, on purpose: whether an edge is observable is a question about the
 * transitive closure, and this module does not have it. See the file header.
 *
 * @param root - Absolute repository root, for reading the collected files.
 * @param collected - Collected test files as repo-relative POSIX paths, from `vitest list`.
 * @param surfaces - The declared package surfaces, in `PACKAGE_SURFACES` order.
 * @returns Sorted pairs and detail rows, with nothing subtracted.
 */
export function typeOnlyEdges(
  root: string,
  collected: readonly string[],
  surfaces: readonly Surface[],
): TypeOnlyDependents {
  const entries: TypeOnlyDependent[] = [];
  for (const testFile of [...collected].sort()) {
    if (insidePackage(testFile, surfaces)) continue;
    const text = readTest(testFile, root);
    if (text === undefined) continue;
    entries.push(...edgesOf(testFile, text, surfaces));
  }
  const pairs = new Map<string, TypeOnlyPair>();
  for (const entry of entries) {
    pairs.set(`${entry.testFile}\u0000${entry.packageName}`, {
      testFile: entry.testFile,
      packageName: entry.packageName,
    });
  }
  return {
    pairs: [...pairs.values()].sort(comparePair),
    entries: entries.sort((a, b) =>
      a.testFile === b.testFile ? a.typeSpecifier.localeCompare(b.typeSpecifier) : a.testFile.localeCompare(b.testFile),
    ),
  };
}

/** Sort two pairs by file and then by package, so a run is reproducible. */
function comparePair(a: TypeOnlyPair, b: TypeOnlyPair): number {
  return a.testFile === b.testFile
    ? a.packageName.localeCompare(b.packageName)
    : a.testFile.localeCompare(b.testFile);
}

/** The stable key of one pair, so sets of pairs can be compared. */
export function pairKey(pair: TypeOnlyPair): string {
  return `${pair.testFile} -> ${pair.packageName}`;
}
