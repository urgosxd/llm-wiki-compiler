/**
 * @file Pin the union guarantee: every collected test belongs to a task surface.
 *
 * THE ASSERTION THAT MAKES A FILTER SAFE. A per-package test selection is only
 * worth having if the packages together still cover the whole suite. If one
 * package's derived selection quietly loses a file, `turbo run test
 * --filter=@repo/wiki` stays green while that file stopped running — a green that
 * stopped looking. So every collected test must land in a package that attributes
 * it, the `meta` bucket (a test of the tooling: `scripts/`, `test/fixtures/`,
 * `test/sdk/`), or the `orphan` bucket (a test whose closure reaches no repo module
 * at all). Whatever is left over is the hole, and it must now be EMPTY: the one
 * test that used to be allowed here reached the built `dist/` of
 * `@atomicstrata/llmwiki-core`, and the collapse deleted that package, so the
 * exemption went with it. Emptying it is a STRENGTHENING of the guard, not a
 * relaxation — there is no list left that a second hole could join.
 *
 * WHY THE CENSUS IS PRINTED AND NOT BAKED. The total grows every time this feature
 * adds a test, so a literal `819`/`820` would be a stale number that fails for the
 * wrong reason. The test asserts against the freshly collected list and prints the
 * four bucket counts beside it, so a reader sees the shape of the partition.
 *
 * WHY PACKAGES MAY OVERLAP. Hundreds of tests at this base reach more than one
 * package's sources, and that is correct: a test of the wiki SDK genuinely
 * exercises `@repo/foundation` types too. Overlap between packages is KEPT —
 * narrowing it would be a cross-package refactor nobody asked for — so only the
 * package/meta, package/orphan and meta/orphan pairs are asserted disjoint.
 *
 * This file spawns `vitest list` through `execFileSync`, deliberately literally:
 * `scripts/test-partition.ts` classifies a test by its content, so this file earns
 * the integration tier from its own evidence rather than from a filename.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeGraphServer,
  crawlTestClosures,
  createGraphServer,
  type GraphServer,
} from "../scripts/module-graph.js";
import {
  META_ROOTS,
  PACKAGE_SURFACES,
  TYPE_ONLY_DEPENDENTS,
  assertCoverage,
  partition,
  typeOnlyDependentsOf,
  type PartitionResult,
} from "../scripts/package-selection.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * The tests no surface can claim.
 *
 * This list is EMPTY, and it is empty because the package is gone rather than because
 * the guard was relaxed. Its single former member, `test/artifact/facade-surface.test.ts`,
 * imported `packages/llmwiki-core/dist/index.js` and `compiler-sdk.js` dynamically — the
 * built artefacts of `@atomicstrata/llmwiki-core` — and reached nothing else in the
 * repository, so no package, `meta` root or `orphan` rule could claim it. That package no
 * longer exists (`odd/tasks/collapse-core-package.md`), and the test died with its
 * subject.
 *
 * WHAT REPLACED THE ALLOWANCE IS STRICTER: the leftover bucket must be empty. A name
 * appearing there now fails the run instead of needing to be added to a list, so a new
 * unreachable test cannot be absorbed by editing this constant.
 */
const UNATTRIBUTABLE: readonly string[] = [];

/**
 * The orphan ratchet, frozen at the run that introduced this guard.
 *
 * THE DIRECTION MATTERS. A NAME APPEARING HERE IS A REGRESSION TO INVESTIGATE, not
 * a line to paste: it means a test reached no package source root and no meta
 * root, which is exactly the hole this guard exists to catch, so find out why it
 * stopped being attributed before touching this list. A name DISAPPEARING is a
 * decrease — delete its entry. Never regenerate the list to make a red test pass.
 */
const FROZEN_ORPHANS: readonly string[] = [
  "test/apply-schemas-check-flag.test.ts",
  "test/artifact/dist-specifiers.test.ts",
  "test/boundary-gate-visible-forms.test.ts",
  "test/build-stamp-source-coverage.test.ts",
  "test/ci/fallow-report-gate.test.ts",
  "test/config-prose-rot-guard.test.ts",
  "test/dimensions/kg-config-laziness.test.ts",
  "test/gate-zone-paths-exist.test.ts",
  "test/kg-test-program-coverage.test.ts",
  "test/no-executable-root-src-walks.test.ts",
  "test/no-removed-cli-adverts.test.ts",
  "test/no-research-branch-in-core.test.ts",
  // LEGITIMATELY ORPHAN, investigated not pasted: this file pins `turbo.json` and
  // the workspace manifests as POLICY DATA. It imports no repo module at all — only
  // `node:fs`, `node:path` and `vitest` — and reads `turbo.json` and each
  // `packages/*/package.json` with `readFileSync`, so its closure is itself and
  // nothing else, which is exactly the orphan rule. There is nothing for a package
  // to attribute it to and nothing to fix; a test written this way lands here by
  // construction.
  "test/package-task-selection.test.ts",
  "test/pnpm-migration-wiring.test.ts",
  "test/provenance-metadata-shape.test.ts",
  "test/query-candidate-id-absent.test.ts",
  "test/sdk/published-dimensions-port.test.ts",
  "test/vendor-fonts-target.test.ts",
  "test/viewer-client-graph.test.ts",
  "test/viewer-css-specificity.test.ts",
  "test/viewer-dom-helpers.test.ts",
  "test/viewer-format.test.ts",
  "test/viewer-graph-compact.test.ts",
  "test/viewer-graph-initial-fit.test.ts",
  "test/viewer-graph-theming.test.ts",
  "test/viewer-layout-css.test.ts",
  "test/viewer-narrow-chrome.test.ts",
  "test/viewer-stage-facts.test.ts",
  "test/viewer-theme-css.test.ts",
];

let server: GraphServer;
let collected: string[];
let result: PartitionResult;

/** Repo-relative POSIX form of an absolute collected path. */
function repoRelative(absolute: string): string {
  return absolute.slice(REPO_ROOT.length + 1).split("\\").join("/");
}

/**
 * Ask the runner itself which files it collects.
 *
 * The universe must come from `vitest`, never from a glob: the partition has to
 * answer for exactly the files a real run would execute, including whatever
 * `vitest.config.ts` excludes and whatever `test:pack` keeps out of collection.
 * A bare `--json` prints the report to stdout, so there is no temp file to place
 * outside the repository and none to clean up.
 */
function collectedTestFiles(): string[] {
  const raw = execFileSync("corepack", ["pnpm", "exec", "vitest", "list", "--filesOnly", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = JSON.parse(raw) as { file: string }[];
  return entries.map((entry) => repoRelative(entry.file));
}

beforeAll(async () => {
  collected = collectedTestFiles();
  server = await createGraphServer(REPO_ROOT);
  const closures = await crawlTestClosures(server, collected);
  result = partition({ collected, closures });
}, 180_000);

afterAll(async () => {
  await closeGraphServer(server);
});

/** Every bucket member, deduplicated across the packages that legitimately overlap. */
function coveredTests(source: PartitionResult): Set<string> {
  return new Set([...[...source.packages.values()].flat(), ...source.meta, ...source.orphan]);
}

/** The collected universe the partition is required to attribute. */
function attributableUniverse(): string[] {
  return collected.filter((file) => !UNATTRIBUTABLE.includes(file));
}
/** How many tests more than one package claims, which is expected and kept. */
function multiPackageCount(source: PartitionResult): number {
  const claims = new Map<string, number>();
  for (const files of source.packages.values()) {
    for (const file of files) claims.set(file, (claims.get(file) ?? 0) + 1);
  }
  return [...claims.values()].filter((count) => count > 1).length;
}

/** The bucket census, printed so a reader sees the shape instead of a constant. */
function census(source: PartitionResult): string {
  const packages = [...source.packages].map(([name, files]) => `${name}=${files.length}`).join(" ");
  const distinct = coveredTests(source).size;
  return (
    `selection buckets: ${packages} meta=${source.meta.length} orphan=${source.orphan.length} ` +
    `uncovered=${source.uncovered.length} collected=${collected.length} distinct=${distinct} ` +
    `multiPackage=${multiPackageCount(source)}`
  );
}

/** Members of a list that also appear in a set, for disjointness assertions. */
function shared(list: readonly string[], set: ReadonlySet<string>): string[] {
  return list.filter((file) => set.has(file)).sort();
}

it("covers every collected test in a package, meta or orphan bucket", () => {
  const covered = coveredTests(result);
  const missed = attributableUniverse()
    .filter((file) => !covered.has(file))
    .sort();
  expect(missed, `collected but in no bucket: ${missed.join(", ")}`).toEqual([]);
  expect(result.uncovered).toEqual([...UNATTRIBUTABLE]);
  console.log(census(result));
});

it("declares four package surfaces and no bucket for the transitional core package", () => {
  const names = PACKAGE_SURFACES.map((surface) => surface.name);
  expect(names).toEqual(["@repo/foundation", "@repo/wiki", "@repo/kg", "@repo/api"]);
  expect([...result.packages.keys()]).toEqual(names);
  expect(names).not.toContain("@atomicstrata/llmwiki-core");
  expect(META_ROOTS).toEqual(["scripts", "test/fixtures", "test/sdk", "test/artifact"]);
});

it("keeps meta, orphan and package buckets disjoint while packages may overlap", () => {
  const packageMembers = new Set([...result.packages.values()].flat());
  expect(shared(result.meta, packageMembers)).toEqual([]);
  expect(shared(result.orphan, packageMembers)).toEqual([]);
  expect(shared(result.orphan, new Set(result.meta))).toEqual([]);
  expect(result.meta.length).toBeGreaterThan(0);
  expect(result.orphan.length).toBeGreaterThan(0);
});

/** A test the wiki package owns by derivation, preferring one no sibling says it owns. */
function wikiOwnedTest(): string {
  const wiki = result.packages.get("@repo/wiki") ?? [];
  const siblings = new Set(
    [...result.packages].filter(([name]) => name !== "@repo/wiki").flatMap(([, files]) => files),
  );
  expect(wiki.length).toBeGreaterThan(0);
  return wiki.filter((file) => !siblings.has(file))[0] ?? wiki[0];
}

/** The partition a narrowing regression produces: one owned test gone from every bucket. */
function withoutTest(source: PartitionResult, doomed: string): PartitionResult {
  const packages = new Map(
    [...source.packages].map(([name, files]) => [name, files.filter((file) => file !== doomed)]),
  );
  return {
    packages,
    meta: source.meta.filter((file) => file !== doomed),
    orphan: source.orphan.filter((file) => file !== doomed),
    uncovered: [],
  };
}

/** The message a throwing guard produced, or a failure naming the missing throw. */
function coverageFailure(source: PartitionResult): string {
  try {
    assertCoverage(source, attributableUniverse());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the coverage guard to throw, but it accepted the narrowed partition");
}

it("proves the coverage guard bites: one lost owned test fails the union check", () => {
  expect(() => assertCoverage(result, attributableUniverse())).not.toThrow();
  const doomed = wikiOwnedTest();
  const message = coverageFailure(withoutTest(result, doomed));
  expect(message).toContain("no bucket");
  expect(message).toContain(doomed);
});

it("reports the orphans the guards exist to surface, and no test a package now covers", () => {
  // `packages/api/src/main.test.ts` lives under @repo/api's own directory, so the
  // directory clause of the selection covers it, and it must never appear here.
  expect(result.orphan).not.toContain("packages/api/src/main.test.ts");
  expect(result.orphan).not.toContain("packages/api/src/main-subcommand-flags.test.ts");
});

it("freezes the orphan ratchet so a new unreachable test cannot slip in silently", () => {
  // The three tests of wiki sources that reach them ONLY through `import type`
  // live in `FROZEN_ORPHANS` and are declared with their reason there, in
  // `TYPE_ONLY_DEPENDENTS` (`scripts/package-selection.ts`). The census line that
  // used to sit here as a comment is now an assertion: see the four tests below.
  expect(result.orphan).toEqual([...FROZEN_ORPHANS]);
});

/** Absolute path of a repo-relative POSIX path. */
function repoPath(file: string): string {
  return resolve(REPO_ROOT, file);
}

/** An import specifier written in `testFile`, resolved to a repo-relative POSIX path. */
function resolvedSpecifier(testFile: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(testFile), specifier));
}

/**
 * The names one file imports as TYPES from one source module.
 *
 * The pattern spans newlines on purpose: the declaration names a repo-relative
 * `sourceFile`, while the test writes `../../packages/...`, so the specifier is
 * resolved against the importing file's directory before it is compared.
 */
function typeSpecifiersFrom(testFile: string, sourceFile: string): string[] {
  const source = readFileSync(repoPath(testFile), "utf8");
  const blocks = [...source.matchAll(/import\s+type\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)];
  return blocks
    .filter((block) => resolvedSpecifier(testFile, block[2]) === sourceFile)
    .flatMap((block) => block[1].split(","))
    .map((name) => name.split(/\s+as\s+/)[0].trim())
    .filter((name) => name.length > 0);
}

/** The declared package whose source roots contain a repo-relative module path. */
function owningPackage(sourceFile: string): string | undefined {
  return PACKAGE_SURFACES.find((surface) =>
    surface.sourceRoots.some((root) => sourceFile.startsWith(`${root}/`)),
  )?.name;
}

it("declares every type-only dependent whose type import is still elided", () => {
  expect(TYPE_ONLY_DEPENDENTS.length).toBeGreaterThan(0);
  for (const entry of TYPE_ONLY_DEPENDENTS) {
    expect(existsSync(repoPath(entry.testFile)), `${entry.testFile} is gone`).toBe(true);
    expect(result.orphan, `${entry.testFile} left the orphan bucket`).toContain(entry.testFile);
    const specifiers = typeSpecifiersFrom(entry.testFile, entry.sourceFile);
    expect(
      specifiers,
      `${entry.testFile} no longer imports type ${entry.typeSpecifier} from ${entry.sourceFile}`,
    ).toContain(entry.typeSpecifier);
    expect(entry.reason.trim().length, `${entry.testFile} has no stated reason`).toBeGreaterThan(0);
  }
});

it("names the package that owns each declared type-only source file", () => {
  for (const entry of TYPE_ONLY_DEPENDENTS) {
    expect(owningPackage(entry.sourceFile), `no package owns ${entry.sourceFile}`).toBe(
      entry.packageName,
    );
    const declared = typeOnlyDependentsOf(entry.packageName).map((each) => each.testFile);
    expect(declared, `${entry.packageName} does not declare ${entry.testFile}`).toContain(
      entry.testFile,
    );
  }
  const packages = [...new Set(TYPE_ONLY_DEPENDENTS.map((entry) => entry.packageName))].sort();
  expect(typeOnlyDependentsOf("@repo/api")).toEqual([]);
  expect(packages.every((name) => typeOnlyDependentsOf(name).length > 0)).toBe(true);
});

it("fails closed: an orphan the frozen pin does not name breaks the ratchet", () => {
  for (const entry of TYPE_ONLY_DEPENDENTS) {
    expect([...FROZEN_ORPHANS], `${entry.testFile} is declared but not frozen`).toContain(
      entry.testFile,
    );
  }
  const newOrphan = "test/a-new-unreachable-by-import.test.ts";
  expect(FROZEN_ORPHANS).not.toContain(newOrphan);
  expect([...result.orphan, newOrphan]).not.toEqual([...FROZEN_ORPHANS]);
  expect(result.orphan).toEqual([...FROZEN_ORPHANS]);
});
