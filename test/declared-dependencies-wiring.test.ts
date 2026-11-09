/**
 * @file test/declared-dependencies-wiring.test.ts
 * @description Pins the two declarations that turn phantom dependencies into
 * declared ones, so hoisting can stop being the only reason they resolve.
 *
 * The repository imports `drizzle-orm` from root `src/` while declaring it only
 * in `packages/llmwiki-kg/ts/package.json`, and `packages/llmwiki-core` builds
 * with `tsup` without declaring it at all. Both worked because
 * `nodeLinker: hoisted` flattens the tree: every import satisfied itself from a
 * flat `node_modules` that nobody had asked for. That failure mode is silent —
 * a missing declaration breaks nothing until the layout stops being flat, and
 * then it breaks as `MODULE_NOT_FOUND` in an install nobody changed.
 *
 * Two properties are worth pinning, and they are different claims:
 *
 * 1. The declaration exists and copies an existing range verbatim. Spec Fix 2
 *    says "copying the range, not choosing one", so the test compares the root
 *    entry byte-for-byte against the KG manifest instead of asserting a literal
 *    the next editor could silently re-tune in both places.
 * 2. The lockfile absorbed the declaration without resolving anything new. The
 *    requirement is "the resolved version in `pnpm-lock.yaml` must be
 *    byte-identical for every package", so each new importer edge must point at
 *    a `snapshots` key that already existed — a declaration that pulled in a
 *    fresh resolution is a version change wearing an additive diff.
 *
 * Both facts are invisible to typecheck, lint, and any unit test of product
 * behaviour, which is why they are asserted here by reading the manifests and
 * the lockfile directly.
 *
 * Spec: project brief fixes 2 and 3 — root `drizzle-orm` declaration and
 * `packages/llmwiki-core` `tsup` devDependency, with zero version movement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/** Repository root from this file's own location, never from `process.cwd()`. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Read a repository-relative file, so every assertion below speaks in repo paths. */
const read = (relativePath: string): string => readFileSync(join(REPO_ROOT, relativePath), "utf8");

/** The two manifest sections this delivery touches; everything else is unmapped. */
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** One `importers` edge: the declared range and the resolution it was given. */
interface ImporterEdge {
  specifier?: string;
  version?: string;
}

interface Importer {
  dependencies?: Record<string, ImporterEdge>;
  devDependencies?: Record<string, ImporterEdge>;
}

const rootPkg = JSON.parse(read("package.json")) as Manifest;
const corePkg = JSON.parse(read("packages/llmwiki-core/package.json")) as Manifest;
const kgPkg = JSON.parse(read("packages/llmwiki-kg/ts/package.json")) as Manifest;
const lock = load(read("pnpm-lock.yaml")) as {
  importers?: Record<string, Importer>;
  snapshots?: Record<string, unknown>;
};

const importers = lock.importers ?? {};
const snapshots = lock.snapshots ?? {};

/** The range the KG manifest already shipped, the one root must copy verbatim. */
const KG_DRIZZLE_RANGE = "^0.45.4";
/** The range the root manifest already shipped, the one core must copy verbatim. */
const ROOT_TSUP_RANGE = "^8.0.0";
/** Resolution keys proven to pre-exist in the pristine lockfile. */
const DRIZZLE_RESOLVED = "0.45.4(postgres@3.4.9)";
const TSUP_RESOLVED = "8.5.1(postcss@8.5.15)(tsx@4.23.15)(typescript@5.9.3)(yaml@2.9.1)";

describe("declared dependencies wiring: root drizzle-orm", () => {
  it("copies the KG range verbatim instead of choosing one", () => {
    const kgRange = kgPkg.dependencies?.["drizzle-orm"];
    const rootRange = rootPkg.dependencies?.["drizzle-orm"];
    expect(kgRange).toBe(KG_DRIZZLE_RANGE);
    expect(rootRange).toBe(kgRange);
  });

  it("declares it as a production dependency, not a dev one", () => {
    expect(rootPkg.dependencies).toHaveProperty("drizzle-orm");
    expect(rootPkg.devDependencies?.["drizzle-orm"]).toBeUndefined();
  });
});

describe("declared dependencies wiring: core tsup", () => {
  it("declares exactly the root tsup range and nothing else", () => {
    expect(rootPkg.devDependencies?.tsup).toBe(ROOT_TSUP_RANGE);
    expect(corePkg.devDependencies).toEqual({ tsup: rootPkg.devDependencies?.tsup });
  });
});

describe("declared dependencies wiring: lockfile absorbed both edges", () => {
  it("records the root drizzle-orm edge with its pre-existing resolution", () => {
    const edge = importers["."]?.dependencies?.["drizzle-orm"];
    expect(edge?.specifier).toBe(KG_DRIZZLE_RANGE);
    expect(edge?.version).toBe(DRIZZLE_RESOLVED);
    expect(snapshots).toHaveProperty(`drizzle-orm@${DRIZZLE_RESOLVED}`);
  });

  it("records the core tsup edge with its pre-existing resolution", () => {
    const edge = importers["packages/llmwiki-core"]?.devDependencies?.tsup;
    expect(edge?.specifier).toBe(ROOT_TSUP_RANGE);
    expect(edge?.version).toBe(TSUP_RESOLVED);
    expect(snapshots).toHaveProperty(`tsup@${TSUP_RESOLVED}`);
  });
});
