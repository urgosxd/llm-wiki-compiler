/**
 * @file Partition the collected suite into per-package, meta and orphan task surfaces.
 *
 * WHY THIS IS DERIVED AND NOT A PATH LIST. The tests do not live inside the
 * packages: wiki's dimension coverage sits in `test/dimensions/wiki/`, compiler
 * coverage in `test/compiler/`, and so on. A hand-written list per package
 * (`--dir packages/wiki/src test/dimensions/wiki …`) works today and rots
 * tomorrow — someone adds `test/dimensions/wiki-v2/` and the filter silently
 * misses it with nothing failing. So a package's test set is DERIVED from the
 * import graph: the collected tests whose transitive closure reaches that
 * package's source roots. This module turns that graph — `crawlTestClosures` and
 * `relatedTests` from `./module-graph.ts` — into a partition, and adds the guard
 * that keeps a derived filter honest: the union of the buckets must equal the
 * collected suite, or a package's `test` task stopped running files while every
 * gate stayed green.
 *
 * THE TWO CLAUSES OF A SELECTION, AND WHY BOTH ARE LOAD-BEARING. A test belongs to
 * package `P` when its closure reaches a source root of `P`, UNION when the test
 * file itself lives under `P`'s directory. The directory clause is not a
 * convenience: `packages/api/src/main.test.ts` and
 * `packages/api/src/main-subcommand-flags.test.ts` live inside `@repo/api` and
 * import no other repo module this crawl records, so the graph clause alone
 * silently loses both — a package whose test task runs nothing because its tests
 * are "not related" to it.
 *
 * SELF-INTERSECTION IS NOT AN EDGE. A test file that sits under a source root is
 * trivially inside its own closure, and counting that would make the directory
 * clause invisible (every in-package test would appear attributed "by the graph").
 * So attribution reads the closure EXCLUDING the test file itself, which is what
 * the measured bucket sizes report: `@repo/api` is 11 by the graph plus 2 by the
 * directory rule. The same exclusion governs the `meta` rule, because a test under
 * `test/sdk/` is not a test OF `test/sdk` merely by living there.
 *
 * NO PACKAGE IS EXEMPT FROM A TASK SURFACE. `@atomicstrata/llmwiki-core` used to be
 * named here as deliberately NOT a surface: it was transitional, so it got no `test`,
 * `lint`, `typecheck` or `fallow` bucket, and one test that reached its built `dist/`
 * was reported as an orphan rather than hidden inside a package with no task surface.
 * The collapse deleted that package (`odd/tasks/collapse-core-package.md`), so the
 * exemption is gone because the PACKAGE is gone — NOT because this guard was relaxed.
 * Nothing replaces it: `test/package-selection-union.test.ts` requires the leftover
 * bucket to be empty, which is strictly stronger than the frozen exception it used to
 * assert by equality.
 *
 * PURE BY CONTRACT. No child process, no network, no database, no writes. The
 * caller brings the collected file list and the closures; this file only decides
 * which bucket each test lands in.
 *
 * THE BOUNDARY THIS MODULE MODELS: STATIC IMPORT SPECIFIERS ONLY. The graph is
 * built from vite's `transformRequest(url, { ssr: true })` and walked over
 * `importedModules`, so a dependency is visible only when it is a static `import`
 * SPECIFIER. Three routes are therefore INVISIBLE to the closure, and no amount of
 * crawling fixes them: `require(` (a call, not an import), a computed `import(`
 * (the specifier is not a literal) and `new URL("../..", import.meta.url)` (a
 * string, not a module request at all). A fourth route is elided before the graph
 * exists: `import type`, which the SSR transform erases, so a test that reaches a
 * package ONLY through a type import has an empty closure and lands in `orphan`.
 * The type-only dependents are not silently accepted — they are DECLARED by name in
 * {@link TYPE_ONLY_DEPENDENTS}, with the tier that actually observes them.
 */

import {
  moduleReachesOf,
  packageOfSpecifier,
  pairKey,
  typeOnlyEdges,
  type TypeOnlyDependents,
} from "./type-only-dependents.ts";

/**
 * A workspace package that gets its own task surface.
 *
 * `directory` is where the package's own test files live, and it is also the
 * clause that keeps a package's in-package suites selected. `sourceRoots` are the
 * trees whose modules attribute an importing test to this package; `@repo/kg`
 * differs from its siblings because the workspace member is the `ts/` subtree of
 * `packages/llmwiki-kg`, not the whole dimension folder.
 */
export interface PackageSurface {
  /** npm package name, for example `@repo/wiki`. */
  readonly name: string;
  /** Repository-relative directory that owns the package's own tests. */
  readonly directory: string;
  /** Repository-relative roots whose modules attribute a test to this package. */
  readonly sourceRoots: readonly string[];
}

/**
 * The four workspace packages that carry a task surface.
 *
 * Every workspace member that ships source appears here, and there is no exemption
 * list: see the file header.
 */
export const PACKAGE_SURFACES: readonly PackageSurface[] = [
  {
    name: "@repo/foundation",
    directory: "packages/foundation",
    sourceRoots: ["packages/foundation/src"],
  },
  { name: "@repo/wiki", directory: "packages/wiki", sourceRoots: ["packages/wiki/src"] },
  {
    name: "@repo/kg",
    directory: "packages/llmwiki-kg/ts",
    sourceRoots: ["packages/llmwiki-kg/ts/src"],
  },
  { name: "@repo/api", directory: "packages/api", sourceRoots: ["packages/api/src"] },
];

/**
 * Roots that belong to the tooling rather than to a package.
 *
 * A test that reaches `scripts/`, `test/fixtures/`, `test/sdk/` or `test/artifact/`
 * is testing the build, the fixtures, the published SDK surface or the BUILT
 * DISTRIBUTION, so no package owns it. These are the only supported answer for such a
 * test: anything reaching neither a package nor one of these roots is an orphan the
 * census must show.
 *
 * WHY `test/artifact` IS HERE, AND WHY NO PACKAGE MAY OWN IT INSTEAD.
 * `test/artifact/bundle-engine.test.ts` and `test/artifact/entries-load.test.ts` assert
 * the BUILT ROOT DISTRIBUTION: `dist/index.js` carries the inlined engine, and
 * `dist/compiler-sdk.js` is the quiet seam beside it. That distribution is produced from
 * EVERY workspace package at once (the root `tsup.config.ts` bundles `@repo/wiki`,
 * `@repo/api` and `@repo/foundation` into it), and the root package is not one of the
 * four declared {@link PACKAGE_SURFACES}, so a test of it is a test of the build.
 *
 * Attributing these two files to the package whose SOURCE they happen to exercise would
 * be the defect this module exists to prevent, not a fix for it: `@repo/wiki`'s
 * `test` task would then run a proof of the root tarball, and `turbo run test
 * --filter=@repo/foundation` — equally implicated in that same tarball — would silently
 * not, so the file would stop running in every selection except one. The meta bucket says
 * the true thing: no single package owns a proof about the artefact they all compose into.
 *
 * This is a DIRECTORY CLASS, not an exemption. There is no per-file, per-path or
 * per-package allowlist anywhere in this module — the one that used to exist for
 * `@atomicstrata/llmwiki-core`'s built `dist/` was removed with that package by
 * `odd/tasks/collapse-core-package.md` (S5), and
 * `test/package-selection-union.test.ts` still requires the leftover bucket to be
 * EMPTY, so a new unattributable test fails the run instead of joining a list.
 */
export const META_ROOTS: readonly string[] = ["scripts", "test/fixtures", "test/sdk", "test/artifact"];

/**
 * The ANNOTATION for one derived type-only dependent: the pair plus why it exists.
 *
 * THE TRUTH IS DERIVED, NOT THIS LIST. `scripts/type-only-dependents.ts` computes the set of
 * (test file, package) pairs whose only route to the package is an elided import, by parsing
 * every COLLECTED test with the TypeScript compiler. This list only annotates that set with a
 * reason, and `test/package-selection-union.test.ts` requires the two to be EXACTLY equal in
 * both directions: an undeclared dependent fails, and an annotation left behind after its edge
 * disappeared fails too. A frozen list can only ever prove that what it names is real — which
 * is why the first version of this constant, three entries long, was published and then found
 * to be short by fourteen, one of them in the `meta` bucket where the orphan pin could not see
 * it at all.
 */
export interface TypeOnlyDependentAnnotation {
  /** Repository-relative POSIX path of the dependent test file. */
  readonly testFile: string;
  /** Declared package the test can reach only as a type. */
  readonly packageName: string;
  /** Why this pair exists, so a reader does not mistake it for a defect to fix. */
  readonly reason: string;
}

/**
 * The reasons behind the derived set, one annotation per (test file, package) pair.
 *
 * WHY EACH PAIR IS NOT A TO-DO. The `test` tier CANNOT OBSERVE A TYPE-ONLY EDGE AT ALL: the
 * import is erased before the module graph exists, so the file runs in no per-package
 * selection and no runtime assertion in it can fail on a type change. The tier that DOES
 * observe it is the root `typecheck:tests` program (`scripts/typecheck-tests.ts` over
 * `tsconfig.test.json`), which compiles these files. A per-package `typecheck:tests` was
 * considered and DECLINED by the owner, so this pairing is the final shape, not a step
 * towards one. Do not delete an entry because the test passes — it passed before too.
 *
 * THE DEFINITION THIS LIST ENCODES, because it is easy to get wrong in the flattering
 * direction: a pair is a dependent only when the test HAS a type-only edge AND `partition` did
 * not attribute it to that package. "A test has a direct type-only import edge" is a fact about
 * the source; "the selection could not observe this test" is a fact about the tool, and only
 * the tool can answer it. Reporting the first as the second is the category error behind an
 * earlier version of this list, which named twelve tests their own selection already ran — a
 * notice that misinforms is worse than the silence it replaced.
 *
 * WHAT THIS LIST IS NOW. `deriveTypeOnlyDependents` computes the true set from the partition on
 * every run, and `main` prints from THAT, so the notice is true by construction. This
 * annotation carries the `reason` text, and its job is the fail-closed ratchet:
 * `test/package-selection-union.test.ts` requires the derived set and this list to be exactly
 * equal, so a new type-only dependent makes the root suite fail until somebody writes the
 * reason down. Gate-green proved the code ran, not that the claim was true: the first committed
 * slice was green on every gate and still shipped a notice carrying false claims.
 */
export const TYPE_ONLY_DEPENDENTS: readonly TypeOnlyDependentAnnotation[] = [
  {
    testFile: "test/provenance-metadata-shape.test.ts",
    packageName: "@repo/wiki",
    reason: "asserts the provenance field shape at the type level; every wiki import is `import type`",
  },
  {
    testFile: "test/query-candidate-id-absent.test.ts",
    packageName: "@repo/wiki",
    reason: "asserts the retired `candidateId` key is absent from QueryResult by key-set comparison",
  },
  {
    testFile: "test/sdk/published-dimensions-port.test.ts",
    packageName: "@repo/foundation",
    reason: "proves the published port types stay compatible; the foundation imports are types only",
  },
  {
    testFile: "test/sdk/published-dimensions-port.test.ts",
    packageName: "@repo/wiki",
    reason: "proves the published dimensions port stays compatible with the wiki `Dimension` type both ways",
  },
  {
    testFile: "test/viewer-sidebar.test.ts",
    packageName: "@repo/wiki",
    reason:
      "`ViewerPage` is the only wiki import and everything else is `test/fixtures`, so it is `meta`, absent from the selection, and in no other bucket either",
  },
];

/**
 * The annotated type-only dependents of one package.
 *
 * `package-tasks.ts` uses this to print which files a selective `test` run cannot fail on.
 * It reads the ANNOTATION rather than re-deriving, because the equality assertion makes the
 * two identical before a commit can land, and the `test` flow must not pay a second parse of
 * the whole collected suite on every run.
 *
 * @param packageName - Declared package name, for example `@repo/wiki`.
 * @returns The annotated entries for that package, empty when it has none.
 */
export function typeOnlyDependentsOf(packageName: string): readonly TypeOnlyDependentAnnotation[] {
  return TYPE_ONLY_DEPENDENTS.filter((entry) => entry.packageName === packageName);
}

/**
 * Derive the type-only dependents of the collected suite, subtracting what the selection covers.
 *
 * THE SUBTRACTION IS THE DEFINITION. A pair is a type-only dependent of package P if and only
 * if (a) the test carries a type-only import edge into P's source, AND (b) `partition` did NOT
 * attribute that test to P. Only (b) makes it unobservable; (a) alone is just a type import.
 * The scanner answers (a) and nothing else, because only this function holds the partition —
 * the earlier version approximated (b) inside the scanner with a file's DIRECT runtime imports
 * and produced twelve pairs whose selection already ran them: `test/query-stale-warning.test.ts`
 * reaches `@repo/wiki` through `test/fixtures/typed-grounding.ts` and is in the 565-file wiki
 * selection, and every `@repo/foundation` pair was `bucket=pkg`.
 *
 * This is also the one import surface the rest of the repository uses: it binds the scanner to
 * `{@link PACKAGE_SURFACES}` so `package-tasks.ts` and the tests need one module, while the
 * scanner takes the surfaces as an argument and never imports this file — which is what keeps
 * the two modules acyclic.
 *
 * @param root - Absolute repository root, for reading the collected files.
 * @param input - The collected universe and the partition produced from it.
 * @returns Sorted pairs the selection cannot observe, plus the detail rows messages quote.
 */
export function deriveTypeOnlyDependents(
  root: string,
  input: { readonly collected: readonly string[]; readonly result: PartitionResult },
): TypeOnlyDependents {
  const edges = typeOnlyEdges(root, input.collected, PACKAGE_SURFACES);
  const selected = new Set(
    [...input.result.packages].flatMap(([name, files]) => files.map((file) => `${file}\u0000${name}`)),
  );
  const pairs = edges.pairs.filter((pair) => !selected.has(`${pair.testFile}\u0000${pair.packageName}`));
  const kept = new Set(pairs.map(pairKey));
  return { pairs, entries: edges.entries.filter((entry) => kept.has(pairKey(entry))) };
}

export { moduleReachesOf, packageOfSpecifier };
export type { TypeOnlyPair } from "./type-only-dependents.ts";

/** Everything {@link partition} needs: the collected universe and its closures. */
export interface PartitionInput {
  /** Collected test files as repo-relative POSIX paths, from `vitest list`. */
  readonly collected: readonly string[];
  /** Per-test transitive repo-relative module closures from `crawlTestClosures`. */
  readonly closures: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The partition, with every list sorted so a run is reproducible.
 *
 * `packages` keys are the declared surface names, all four present even when a
 * package selects nothing, because a missing key would read as "not measured".
 * `uncovered` is the only bucket that means "this test runs nowhere": it must be
 * empty, and {@link assertCoverage} is what enforces that.
 */
export interface PartitionResult {
  /** Selected tests per package name; a test may legitimately appear in several. */
  readonly packages: Map<string, string[]>;
  /** Tests of the tooling: closure reaches a meta root and no package source root. */
  readonly meta: string[];
  /** Tests whose closure reaches no repo module but themselves. */
  readonly orphan: string[];
  /** Collected tests that landed in no bucket at all: the hole this guard exists for. */
  readonly uncovered: string[];
}

/** True when a repo-relative path lives at or under a repo-relative root. */
function isUnder(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

/** True when a repo-relative path lives at or under any of the given roots. */
function isUnderAny(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => isUnder(file, root));
}

/**
 * The modules a test reaches, minus the test file itself.
 *
 * See the file header: a test is not "related to" its own directory just because
 * it is inside it, so every attribution and every bucket rule reads this view.
 */
function importedModules(testFile: string, closure: ReadonlySet<string>): string[] {
  return [...closure].filter((modulePath) => modulePath !== testFile);
}

/** True when a package's source roots attribute this test to that package. */
function reachesSourceRoot(
  surface: PackageSurface,
  imported: readonly string[],
): boolean {
  return imported.some((modulePath) => isUnderAny(modulePath, surface.sourceRoots));
}

/** True when the test is selected by a package, by the graph clause or the directory clause. */
function selectedBy(surface: PackageSurface, testFile: string, imported: readonly string[]): boolean {
  return isUnder(testFile, surface.directory) || reachesSourceRoot(surface, imported);
}

/** True when a test lives under any declared package directory. */
function isInsidePackage(testFile: string): boolean {
  return PACKAGE_SURFACES.some((surface) => isUnder(testFile, surface.directory));
}

/** True when a test reaches tooling code and no package code, from outside every package. */
function isMeta(testFile: string, imported: readonly string[]): boolean {
  if (isInsidePackage(testFile)) return false;
  if (!imported.some((modulePath) => isUnderAny(modulePath, META_ROOTS))) return false;
  return !PACKAGE_SURFACES.some((surface) => reachesSourceRoot(surface, imported));
}

/** True when a test reaches no repo-local module but itself, from outside every package. */
function isOrphan(testFile: string, imported: readonly string[]): boolean {
  return !isInsidePackage(testFile) && imported.length === 0;
}

/** The bucket verdict for one test. */
interface Classification {
  /** Declared package names that select this test. */
  readonly owners: string[];
  readonly meta: boolean;
  readonly orphan: boolean;
}

/** Decide the bucket for one test from its closure alone. */
function classify(testFile: string, imported: readonly string[]): Classification {
  const owners = PACKAGE_SURFACES.filter((surface) => selectedBy(surface, testFile, imported)).map(
    (surface) => surface.name,
  );
  return { owners, meta: isMeta(testFile, imported), orphan: isOrphan(testFile, imported) };
}

/**
 * Partition the collected suite into package, meta and orphan surfaces.
 *
 * A collected test the crawl produced no closure for is reported as `uncovered`
 * rather than as an orphan: an absent closure means the graph never saw the file,
 * which is a hole in the derivation, not a test that legitimately reaches nothing.
 * Silence there would turn a crawl gap into a benign-looking bucket.
 *
 * @param input - The collected universe and the per-test closures.
 * @returns Sorted bucket lists, all four packages present.
 */
export function partition(input: PartitionInput): PartitionResult {
  const packages = new Map(PACKAGE_SURFACES.map((surface) => [surface.name, [] as string[]]));
  const meta: string[] = [];
  const orphan: string[] = [];
  const uncovered: string[] = [];
  for (const testFile of [...input.collected].sort()) {
    const closure = input.closures.get(testFile);
    if (closure === undefined) {
      uncovered.push(testFile);
      continue;
    }
    const imported = importedModules(testFile, closure);
    const verdict = classify(testFile, imported);
    for (const owner of verdict.owners) packages.get(owner)?.push(testFile);
    if (verdict.meta) meta.push(testFile);
    else if (verdict.orphan) orphan.push(testFile);
    else if (verdict.owners.length === 0) uncovered.push(testFile);
  }
  return { packages, meta, orphan, uncovered };
}

/** Every test the partition attributes to at least one bucket. */
function coveredTests(result: PartitionResult): Set<string> {
  return new Set([...[...result.packages.values()].flat(), ...result.meta, ...result.orphan]);
}

/**
 * Throw unless every collected test appears in some bucket of the partition.
 *
 * THIS IS THE GUARD THE WHOLE DESIGN RESTS ON. A derived selection that quietly
 * loses a file keeps every per-package run green while that file stopped running,
 * and nothing else in the pipeline would notice. So the check is independent of
 * `result.uncovered`: it recomputes coverage from the buckets against the collected
 * list the caller passes, which means a caller cannot satisfy it by editing the
 * `uncovered` field.
 *
 * THE UNIVERSE IS THE CALLER'S DECLARATION, and it is a parameter on purpose, so a
 * caller cannot satisfy the guard by editing `result.uncovered`. No exception list
 * remains to pass here: the single test that used to need one reached the built
 * `dist/` of `@atomicstrata/llmwiki-core`, and that package no longer exists. The
 * caller therefore passes the UNFILTERED collected list, which is the strict form,
 * and a test no bucket claims is reported as missing.
 *
 * @param result - A partition to validate.
 * @param collected - The collected universe the partition must answer for.
 * @throws Error naming the count and each collected test found in no bucket.
 */
export function assertCoverage(result: PartitionResult, collected: readonly string[]): void {
  const covered = coveredTests(result);
  const missing = collected.filter((file) => !covered.has(file)).sort();
  if (missing.length === 0) return;
  const named = missing.map((file) => `  - ${file}`).join("\n");
  throw new Error(
    `package selection covers no bucket for ${missing.length} collected test(s):\n${named}`,
  );
}
