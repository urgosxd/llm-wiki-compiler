/**
 * @file test/declared-dependencies-wiring.test.ts
 * @description Pins the two declarations that turn phantom dependencies into
 * declared ones, so hoisting can stop being the only reason they resolve.
 *
 * The repository imports `drizzle-orm` from root `src/` while declaring it only
 * in `packages/llmwiki-kg/ts/package.json`. That once worked because
 * `nodeLinker: hoisted` flattens the tree: every import satisfied itself from a
 * flat `node_modules` that nobody had asked for. That failure mode is silent —
 * a missing declaration breaks nothing until the layout stops being flat, and
 * then it breaks as `MODULE_NOT_FOUND` in an install nobody changed.
 *
 * Three properties are worth pinning, and they are different claims:
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
 * 3. `ajv` is declared by every importer that needs it and by nobody else. It
 *    started as a ROOT declaration, moved to `packages/llmwiki-kg/ts` alone, and
 *    is now declared by BOTH: the KG writes `ajv/dist/2020.js` from its
 *    conformance test so it keeps it in `devDependencies`, and the root needs it at
 *    RUNTIME because `odd/tasks/collapse-core-package.md` inlined
 *    `@atomicstrata/llmwiki-core`'s engine — which imports `ajv` — into
 *    `dist/index.js`. A root `dependencies` entry is what makes the published
 *    tarball installable; a dev one would ship a bundle that dies at import.
 * 4. The same collapse brought two more runtime dependencies to root — `express`
 *    and `@hono/node-server` — and all three are listed in `.fallowrc.json`'s
 *    `ignoreDependencies`. That list is not a loophole here: it is the standing
 *    exemption for a dependency declared for the RUNTIME and never imported by
 *    name, exactly as `postgres` and `dotenv` already are. The assertions below
 *    pin the list's exact tail so a fourth entry cannot be added silently, and pin
 *    that every ignored name really is a root `dependencies` entry.
 * 5. A declaration is only worth what a CONSUMER can install. The last block
 *    reads the root `dependencies` block as an embedder's installer would, so a
 *    range that resolves only inside this workspace cannot ship unnoticed.
 *
 * All of these claims are invisible to typecheck, lint, and any unit test of
 * product behaviour, which is why they are asserted here by reading the
 * manifests and the lockfile directly.
 *
 * Spec: project brief fixes 2 and 3 — root `drizzle-orm` declaration, with zero
 * version movement — plus S7 of `odd/tasks/pnpm-phantom-deps.md`, which moves
 * `ajv` ownership to the package that imports it, plus S1-S3 of
 * `odd/tasks/packed-manifest-guard.md`, which asserts the published
 * `dependencies` block, plus S1/S3 of `odd/tasks/collapse-core-package.md`,
 * which makes root the declaration site for the engine's own runtime
 * dependencies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PROTOCOL_PREFIX,
  describeDependencyViolations,
  findDependenciesByProtocol,
  findUninstallableDependencies,
} from "./fixtures/manifest-dependencies.js";

/** Repository root from this file's own location, never from `process.cwd()`. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** Read a repository-relative file, so every assertion below speaks in repo paths. */
const read = (relativePath: string): string => readFileSync(join(REPO_ROOT, relativePath), "utf8");

/** The two manifest sections this delivery touches; everything else is unmapped. */
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** Only the root manifest declares these; read so the tsup claim covers every member. */
  workspaces?: string[];
}

/** Only the `.fallowrc.json` surface this file cares about. */
interface FallowConfig {
  ignoreDependencies?: string[];
}

/** Only the KG dead-code baseline field this file pins. */
interface DeadCodeBaseline {
  unlisted_dependencies?: string[];
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
/** The range root shipped before the declaration moved; the KG manifest copies it. */
const AJV_RANGE = "^8.20.0";
/** The single ajv resolution both edges must reuse — already in `snapshots`. */
const AJV_RESOLVED = "8.20.0";
/** Every ajv resolution the tree carried before the move and must still carry. */
const AJV_RESOLUTIONS = ["6.15.0", "8.20.0"];
/** The two runtime dependencies the collapse brought to root besides ajv. */
const EXPRESS_RANGE = "^5.1.0";
const EXPRESS_RESOLVED = "5.3.0";
const HONO_RANGE = "^1.19.14";
const HONO_RESOLVED = "1.19.14(hono@4.12.29)";
/**
 * The three dependencies the collapse moved onto root, in the order
 * `.fallowrc.json` records them: declared for the runtime, never imported by name.
 */
const ENGINE_RUNTIME_DEPENDENCIES = ["ajv", "express", "@hono/node-server"];
/** The same three, in the order `.fallowrc.json` appends them after `picomatch`. */
const FALLOW_ENGINE_TAIL = ["@hono/node-server", "ajv", "express"];
/** The entry that preceded them, so the list is proven extended rather than reordered. */
const FALLOW_PRECEDING_ENTRY = "picomatch";
/** The KG package's dead-code baseline, the file S7 had to empty of `ajv`. */
const KG_DEAD_CODE_BASELINE = "packages/llmwiki-kg/ts/baselines/dead-code-baseline.json";
/** The workspace member `odd/tasks/collapse-core-package.md` deleted. */
const COLLAPSED_PACKAGE = "packages/llmwiki-core";

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

describe("declared dependencies wiring: one build, and it is the root's", () => {
  it("declares exactly the root tsup range and lets no workspace member declare its own", () => {
    expect(rootPkg.devDependencies?.tsup).toBe(ROOT_TSUP_RANGE);
    // `packages/llmwiki-core` used to be asserted as `{ tsup: <root's range> }` — the ONE
    // package allowed its own tsup devDependency, because it ran a second build. The
    // collapse deleted that package and there is one build again, so the same claim is now
    // stated for every member: no member declares tsup at all. Dropping the old assertion
    // without this replacement would have left "a package quietly invents its own build"
    // unguarded in the very diff that removed the only legitimate instance.
    const members = rootPkg.workspaces ?? [];
    expect(members.length, "an empty workspace list would make this assertion vacuous").toBeGreaterThan(0);
    for (const member of members) {
      const manifest = JSON.parse(read(`${member}/package.json`)) as Manifest;
      expect(manifest.devDependencies?.tsup, `${member} must not declare its own tsup`).toBeUndefined();
      expect(manifest.dependencies?.tsup, `${member} must not declare its own tsup`).toBeUndefined();
    }
  });
});

describe("declared dependencies wiring: lockfile absorbed every edge", () => {
  it("records the root drizzle-orm edge with its pre-existing resolution", () => {
    const edge = importers["."]?.dependencies?.["drizzle-orm"];
    expect(edge?.specifier).toBe(KG_DRIZZLE_RANGE);
    expect(edge?.version).toBe(DRIZZLE_RESOLVED);
    expect(snapshots).toHaveProperty(`drizzle-orm@${DRIZZLE_RESOLVED}`);
  });

  it("keeps the root tsup edge on the pre-existing resolution and drops the deleted importer", () => {
    const edge = importers["."]?.devDependencies?.tsup;
    expect(edge?.specifier).toBe(ROOT_TSUP_RANGE);
    expect(edge?.version).toBe(TSUP_RESOLVED);
    expect(snapshots).toHaveProperty(`tsup@${TSUP_RESOLVED}`);
    // The second build's importer is gone with the package. Asserted, not assumed: a
    // lockfile that still carries an importer for a directory that does not exist is the
    // frozen-install failure the container manifests hit.
    expect(importers).not.toHaveProperty(COLLAPSED_PACKAGE);
  });
});

describe("declared dependencies wiring: the engine's runtime dependencies live at root", () => {
  it("declares all three in `dependencies`, at the ranges the deleted package used", () => {
    expect(rootPkg.dependencies?.ajv).toBe(AJV_RANGE);
    expect(rootPkg.dependencies?.express).toBe(EXPRESS_RANGE);
    expect(rootPkg.dependencies?.["@hono/node-server"]).toBe(HONO_RANGE);
  });

  it("declares them as production dependencies, because the inlined engine imports them", () => {
    // A devDependency here would leave `dist/index.js` importing `express`,
    // `@hono/node-server` and `ajv` from a tarball whose install never fetches them.
    for (const name of ENGINE_RUNTIME_DEPENDENCIES) {
      expect(rootPkg.dependencies, `root dependencies must carry ${name}`).toHaveProperty(name);
      expect(rootPkg.devDependencies?.[name], `${name} must not be a devDependency`).toBeUndefined();
    }
  });

  it("records all three root importer edges at pre-existing resolutions", () => {
    const deps = importers["."]?.dependencies;
    expect(deps?.ajv).toEqual({ specifier: AJV_RANGE, version: AJV_RESOLVED });
    expect(deps?.express).toEqual({ specifier: EXPRESS_RANGE, version: EXPRESS_RESOLVED });
    expect(deps?.["@hono/node-server"]).toEqual({ specifier: HONO_RANGE, version: HONO_RESOLVED });
    expect(snapshots).toHaveProperty(`express@${EXPRESS_RESOLVED}`);
    expect(snapshots).toHaveProperty(`@hono/node-server@${HONO_RESOLVED}`);
  });
});

describe("declared dependencies wiring: ajv is declared by both importers that need it", () => {
  it("keeps the KG dev dependency at the range root used to carry", () => {
    expect(kgPkg.devDependencies?.ajv).toBe(AJV_RANGE);
    expect(kgPkg.dependencies?.ajv).toBeUndefined();
  });

  it("declares it at root as a production dependency, never a dev one", () => {
    expect(rootPkg.dependencies?.ajv).toBe(AJV_RANGE);
    expect(rootPkg.devDependencies?.ajv).toBeUndefined();
  });

  it("records both lockfile edges at the one ajv resolution", () => {
    expect(importers["packages/llmwiki-kg/ts"]?.devDependencies?.ajv).toEqual({
      specifier: AJV_RANGE,
      version: AJV_RESOLVED,
    });
    expect(importers["."]?.dependencies?.ajv).toEqual({ specifier: AJV_RANGE, version: AJV_RESOLVED });
    expect(snapshots).toHaveProperty(`ajv@${AJV_RESOLVED}`);
  });
});

describe("declared dependencies wiring: what the ajv moves left alone", () => {
  it("keeps every ajv resolution the tree already carried", () => {
    // Peer suffixes are stripped so a re-resolution under a different peer set
    // still surfaces as a version string this list does not contain.
    const versions = [
      ...new Set(
        Object.keys(snapshots)
          .filter((key) => key.startsWith("ajv@"))
          .map((key) => key.slice("ajv@".length).replace(/\(.*\)$/u, "")),
      ),
    ].sort();
    expect(versions).toEqual(AJV_RESOLUTIONS);
  });

  it("keeps the fallow ignore list strict JSON, extended after picomatch by exactly the three", () => {
    // `JSON.parse` is itself the strict-JSON assertion: a trailing comma or a
    // comment leaves the repository tooling unable to read its own config.
    const fallow = JSON.parse(read(".fallowrc.json")) as FallowConfig;
    const ignored = fallow.ignoreDependencies ?? [];
    expect(ignored.slice(-FALLOW_ENGINE_TAIL.length)).toEqual(FALLOW_ENGINE_TAIL);
    expect(ignored[ignored.length - FALLOW_ENGINE_TAIL.length - 1]).toBe(FALLOW_PRECEDING_ENTRY);
    expect(ignored).toHaveLength(new Set(ignored).size);
  });

  it("ignores only names the root manifest really declares", () => {
    // The list is an exemption for a dependency declared for the RUNTIME and never imported
    // by name — `postgres` and `dotenv` predate the collapse, the engine's three joined it.
    // An ignored name that no manifest declares would be a phantom nothing can resolve, so
    // each one is held to the root `dependencies` block here.
    const fallow = JSON.parse(read(".fallowrc.json")) as FallowConfig;
    for (const name of FALLOW_ENGINE_TAIL) {
      expect(rootPkg.dependencies, `${name} is ignored but not declared at root`).toHaveProperty(name);
    }
  });

  it("keeps the KG dead-code baseline free of unlisted dependencies", () => {
    const baseline = JSON.parse(read(KG_DEAD_CODE_BASELINE)) as DeadCodeBaseline;
    expect(baseline.unlisted_dependencies).toEqual([]);
  });
});

/**
 * READ THIS BEFORE WIDENING THE GUARD BELOW TO THE WHOLE MANIFEST.
 *
 * The subject is root `dependencies`, and only that block, because that is the
 * only block an embedder's installer reads. Root `package.json:103-106` carries
 * four `workspace:*` entries — `@repo/api`, `@repo/foundation`, `@repo/kg` and
 * `@repo/wiki` — and all four are inside `devDependencies`. They are COSMETIC
 * and HARMLESS: no package manager installs the `devDependencies` of a package
 * you install, so a consumer never sees them and never tries to resolve one.
 *
 * They must NOT be "fixed". That assertion belongs to `give the workspace build
 * its edge, not the consumer`: the workspace build needs those links to compile
 * this repository, and rewriting them to registry versions would break it to
 * satisfy a rule no consumer can observe. The acceptance criterion that demanded
 * a `workspace:`-free packed manifest was retracted for exactly this reason.
 *
 * The scope is also pinned from the other side: `test/affected-escalation-wiring.test.ts`
 * REQUIRES `@repo/kg` to stay `workspace:*` under `devDependencies`. A guard
 * asserting a whole-manifest absence would therefore go RED on a correct tree,
 * which is how a guard becomes noise and then gets deleted.
 *
 * What DOES protect an embedder is the block asserted here: `dependencies` must
 * carry no local protocol, and every range there must be registry-ranged or
 * URL-shaped. That is the negative and the positive half of the same claim —
 * absence alone would pass on an empty or mangled block. The INSTALLED tarball's
 * manifest gets the same two assertions in `test/sdk/packaging.test.ts`, because
 * this checkout cannot see what a packer actually ships.
 */
describe("declared dependencies wiring: root dependencies reach a consumer intact", () => {
  it("pins nothing to a local protocol such as workspace:", () => {
    const pinned = findDependenciesByProtocol(rootPkg.dependencies, [WORKSPACE_PROTOCOL_PREFIX]);
    expect(pinned, `workspace-pinned dependencies: ${describeDependencyViolations(pinned)}`).toEqual([]);
  });

  it("declares only registry-ranged or URL-shaped dependency ranges", () => {
    expect(rootPkg.dependencies).toBeDefined();
    const uninstallable = findUninstallableDependencies(rootPkg.dependencies);
    expect(uninstallable, `uninstallable dependencies: ${describeDependencyViolations(uninstallable)}`).toEqual([]);
  });
});
