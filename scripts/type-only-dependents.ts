/**
 * @file Derive every collected test that reaches a package surface ONLY through an elided import.
 *
 * WHY THIS IS DERIVED AND NOT A LIST. The first version of this guard froze the three
 * type-only dependents it knew about in `TYPE_ONLY_DEPENDENTS`, and a frozen list has the
 * defect this repository keeps removing: it can only prove that what it names is real, never
 * that it names everything. The list was published, measured against a live tree, and found
 * to be short by one — `test/viewer-sidebar.test.ts` reaches `@repo/wiki` through
 * `import type { ViewerPage }` and through nothing else at runtime. So the SET is derived
 * from the collected suite by the TypeScript parser, and the hand-written declaration is
 * demoted to an ANNOTATION: it supplies the `reason` for each derived pair, and
 * `test/package-selection-union.test.ts` requires the two to be exactly equal in both
 * directions. An undeclared dependent fails, and an annotation for an edge that no longer
 * exists fails too.
 *
 * THE FOUR ELIDED FORMS, ALL RECOGNISED, because a scanner that knows one of them is a
 * scanner that reports zero the day the codebase writes another:
 *
 *   import type { X } from "./m.js";      importClause.isTypeOnly
 *   import type X from "./m.js";          importClause.isTypeOnly, default binding
 *   import { type X } from "./m.js";      every named element isTypeOnly, no default, no `*`
 *   export type { X } from "./m.js";      ExportDeclaration.isTypeOnly
 *
 * A declaration that also binds anything at runtime — a default name, a `* as ns` — emits a
 * real import, so the module IS reached by the module graph and there is no gap to report.
 *
 * THE BOUNDARY THIS CANNOT CROSS, STATED SO IT IS NOT MISTAKEN FOR COVERAGE. This is still a
 * scan of import SPECIFIERS, so `require("...")`, a computed `import(expr)` and
 * `new URL("../..", import.meta.url)` remain invisible: they are calls and strings, not
 * module requests. Those shapes stay UNDECLARED-BY-DETECTION, which is the honest statement
 * `docs/turborepo.md` carries. Only the type-only shape is refused when it is undeclared.
 *
 * PURE BY CONTRACT, like `package-selection.ts`: no child process, no network, no writes. It
 * reads the collected test files off disk and decides; the caller supplies the universe.
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
interface Surface {
  /** npm package name, for example `@repo/wiki`. */
  readonly name: string;
  /** Repository-relative directory that owns the package's own tests. */
  readonly directory: string;
  /** Repository-relative roots whose modules attribute a test to this package. */
  readonly sourceRoots: readonly string[];
}

/** One derived type-only edge: a test, the package it can only reach as a type, and the type. */
interface TypeOnlyDependent {
  /** Repository-relative POSIX path of the dependent test file. */
  readonly testFile: string;
  /** Declared package the test depends on through an elided import and nothing else. */
  readonly packageName: string;
  /** One imported type that carries the edge; a file may contribute several. */
  readonly typeSpecifier: string;
  /** Repository-relative POSIX path of the module the type is imported from. */
  readonly sourceFile: string;
}

/** The `testFile` + `packageName` pair the declaration must name, with nothing extra. */
export interface TypeOnlyPair {
  /** Repository-relative POSIX path of the dependent test file. */
  readonly testFile: string;
  /** The package that pair depends on. */
  readonly packageName: string;
}

/** The derivation: the pair set the declaration must equal, plus the detail messages quote. */
export interface TypeOnlyDependents {
  /** Sorted, one per (test file, package): the exact set the declaration must equal. */
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

/**
 * Every module a piece of source reaches, and which of those reaches are elided.
 *
 * Exported because it is the whole recognition rule and it must be provable WITHOUT a tree:
 * `test/package-selection-union.test.ts` drives this with the four elided forms and with a
 * mixed declaration that is NOT elided, so a scanner that learns only `import type { … }`
 * fails there instead of quietly reporting zero for the other three.
 *
 * @param text - Source text of one file.
 * @returns One entry per top-level import or re-export declaration, in source order.
 */
export function moduleReachesOf(text: string): ModuleReach[] {
  const source = ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true);
  return moduleReaches(source);
}
function namedImportNames(node: ts.NamedImportBindings): string[] {
  return ts.isNamedImports(node) ? node.elements.map((element) => element.name.text) : [];
}

/** True when every binding of a declaration is a type, so the import is emitted as nothing. */
function onlyTypeBindings(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** The names one import declaration contributes, or none when it is type-only. */
function importNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined) return [];
  const own = clause.name === undefined ? [] : [clause.name.text];
  return [...own, ...(clause.namedBindings === undefined ? [] : namedImportNames(clause.namedBindings))];
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
      const exports = node.exportClause;
      const names = exports !== undefined && ts.isNamedExports(exports)
        ? exports.elements.map((element) => element.name.text)
        : [];
      reaches.push({ specifier: (node.moduleSpecifier as ts.StringLiteral).text, elided: node.isTypeOnly, names });
    }
  }
  return reaches;
}

/** A repo-relative POSIX path for a relative specifier, with no runtime extension. */
function resolvedModulePath(testFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), specifier));
  return joined.replace(/\.(js|mjs|cjs|jsx)$/u, "");
}

/** The declared surface whose source roots contain a module path, if any. */
function packageOf(modulePath: string, surfaces: readonly Surface[]): string | undefined {
  return surfaces.find((surface) =>
    surface.sourceRoots.some((root) => modulePath.startsWith(`${root}/`) || modulePath === root),
  )?.name;
}

/** The package a bare specifier names, when it names one of the declared surfaces. */
function packageOfBareSpecifier(specifier: string, surfaces: readonly Surface[]): string | undefined {
  return surfaces.find((surface) => surface.name === specifier)?.name;
}

/** True when the test file already belongs to a package by its own directory. */
function insidePackage(testFile: string, surfaces: readonly Surface[]): boolean {
  return surfaces.some(
    (surface) => testFile === surface.directory || testFile.startsWith(`${surface.directory}/`),
  );
}

/** The text of one collected test file, or undefined when it cannot be read on disk. */
function readTest(file: string, root: string): string | undefined {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

/** Every type-only edge one test file carries into a package it cannot otherwise reach. */
function edgesOf(testFile: string, text: string, surfaces: readonly Surface[]): TypeOnlyDependent[] {
  // A source file with no `from` cannot carry any of the four elided forms, so the parse is
  // skipped for it. This is a cheap gate, not a heuristic: every recognised form needs the
  // keyword, and `require(`/`import(`/`new URL(` are invisible either way.
  if (!text.includes("from")) return [];
  const source = ts.createSourceFile(`${testFile}.ts`, text, ts.ScriptTarget.Latest, true);
  const typeOnly: { packageName: string; sourceFile: string; names: readonly string[] }[] = [];
  const runtime = new Set<string>();
  for (const reach of moduleReaches(source)) {
    const modulePath = resolvedModulePath(testFile, reach.specifier);
    const owner =
      modulePath === undefined
        ? packageOfBareSpecifier(reach.specifier, surfaces)
        : packageOf(modulePath, surfaces);
    if (owner === undefined) continue;
    if (!reach.elided) runtime.add(owner);
    else typeOnly.push({ packageName: owner, sourceFile: modulePath ?? reach.specifier, names: reach.names });
  }
  return typeOnly
    .filter((reach) => !runtime.has(reach.packageName))
    .flatMap((reach) =>
      reach.names.map((typeSpecifier) => ({
        testFile,
        packageName: reach.packageName,
        typeSpecifier,
        sourceFile: reach.sourceFile,
      })),
    );
}

/**
 * Derive the type-only dependents of the whole collected suite.
 *
 * A test is a dependent when it reaches a package through at least one elided import and
 * through NO runtime import, and when it does not already live inside that package's own
 * directory — those two cases are covered by the selection's graph and directory clauses
 * respectively, so there is no gap to report and nothing to declare.
 *
 * @param root - Absolute repository root, for reading the collected files.
 * @param collected - Collected test files as repo-relative POSIX paths, from `vitest list`.
 * @param surfaces - The declared package surfaces, in `PACKAGE_SURFACES` order.
 * @returns Sorted pairs for the exact-equality assertion, plus the detail rows messages quote.
 */
export function deriveTypeOnlyDependents(
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
    pairs: [...pairs.values()].sort((a, b) =>
      a.testFile === b.testFile
        ? a.packageName.localeCompare(b.packageName)
        : a.testFile.localeCompare(b.testFile),
    ),
    entries: entries.sort((a, b) =>
      a.testFile === b.testFile
        ? a.typeSpecifier.localeCompare(b.typeSpecifier)
        : a.testFile.localeCompare(b.testFile),
    ),
  };
}
