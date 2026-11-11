/**
 * @file test/sdk/packaging.test.ts
 * @description Install-from-tarball packaging smoke test for the SDK library entry.
 *
 * Validates the full publish contract by running `npm pack`, installing the
 * resulting tarball into a throwaway ESM fixture project, and importing
 * `createWiki` from the installed package via a probe script.
 *
 * ## The tarball is installed ALONE (spec S2 of `odd/tasks/collapse-core-package.md`)
 *
 * `PACK_DISTRIBUTION` used to name two directories, and this fixture packed both,
 * so the root tarball was never proved installable on its own: `npm i <root.tgz>`
 * failed `ETARGET` on the pinned `@atomicstrata/llmwiki-core@1.4.0-dev.20260919`,
 * a prerelease the registry does not carry. Now the list is `["."]`, nothing is
 * installed beside the root tarball, and an ingest is EXECUTED through the
 * installed package rather than merely imported.
 *
 * Two consequences are asserted here because nothing else sees them:
 *
 *   - The packed manifest must declare the dependencies of the engine the root
 *     bundle now carries (`@hono/node-server`, `ajv`, `express`) and must require
 *     an `@modelcontextprotocol/sdk` at or above `^1.32.1`. The workspace sets
 *     `nodeLinker: hoisted`, so those three are reachable flat in a developer's
 *     `node_modules` whether or not they are declared — which is exactly why a
 *     green `pnpm test` and a green `docker build` can both pass over a broken
 *     published tarball. Only this clean-project install sees the difference.
 *   - The ingest needs a Stack, so this case asks the repository's own probe
 *     fixture for one and applies its loud no-database rule. The INSTALL case
 *     stays database-free: the probe is imported lazily, so a machine without a
 *     database still runs the packaging proof and fails only the ingest, with the
 *     shared actionable message.
 *
 * The quiet half of S4 lives here too: S4 requires a BEHAVIOURAL quiet proof, and the
 * collapse removes the core package that published `withQuiet` on its own `./compiler-sdk`
 * subpath. T2 therefore re-points that subpath at the root package, built from
 * `packages/wiki/src/sdk/compiler-composition.ts`. The specifier is NOT hard-coded here:
 * this fixture reads the INSTALLED manifest, requires an `exports["./compiler-sdk"]` entry
 * with an `import` target that exists in the installed tarball, and only then imports the
 * constructed specifier dynamically. One case therefore asserts three things the contract
 * needs at once — the successor subpath is DECLARED, it RESOLVES, and `withQuiet` entered
 * through it runs a real ingest with both captured streams empty. Until T2 lands, the
 * manifest declares no such key, which is this file's RED for S4.
 *
 * This catches mistakes that a local `dist/` import would miss:
 *   - Wrong/missing `exports` map entries
 *   - Files accidentally excluded from the `files` field
 *   - A shebang on the library bundle that would break `import`
 *   - Missing type declarations (`.d.ts`)
 *   - An engine dependency the packed manifest does not declare
 *   - A `dependencies` range that only resolves inside this workspace, which a
 *     consumer's installer fails on with `EUNSUPPORTEDPROTOCOL`
 *
 * Network-dependent: `npm install <tarball>` resolves llmwiki's ~17 runtime
 * deps fresh from the registry, so this is a developer-invoked `test:pack`
 * smoke test excluded from the default/CI `npm test` run.
 * Run explicitly with: `npm run test:pack`
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACK_DISTRIBUTION } from "./pack-distribution.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import {
  WORKSPACE_PROTOCOL_PREFIX,
  describeDependencyViolations,
  findDependenciesByProtocol,
  findUninstallableDependencies,
} from "../fixtures/manifest-dependencies.js";

/** Pack every directory named by {@link PACK_DISTRIBUTION} into the destination. */
function packDistribution(repo: string, destination: string): string[] {
  return [...PACK_DISTRIBUTION].map(directory => {
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: path.join(repo, directory), encoding: "utf8" });
    const [packed] = JSON.parse(output) as Array<{ filename: string }>;
    expect(packed!.filename).toMatch(/\.tgz$/);
    return path.join(destination, packed!.filename);
  });
}

/**
 * A mixed-package consumer must see ONE contract through both published packages.
 *
 * The facade's `Wiki` is the core's `WikiCore` with nothing added, so the two
 * declarations are mutually assignable, and the facade's `createWiki` accepts the
 * core's `CreateWikiOptions` -- a divergence in either package breaks this file.
 * `SlugSafe` proves the branded identifier types still survive the shipped
 * declarations as brands: a second copy of core's `.d.ts` (or a hand-written
 * duplicate) would either lose the brand or be indistinguishable from `string`.
 *
 * ## The dimensions port is proved from the INSTALLED declarations too (spec S9)
 *
 * Two claims, both read off the tarballs a consumer installs rather than off this
 * checkout's sources:
 *
 * 1. **The port type is publicly REACHABLE and SATISFIABLE.** A hand-written
 *    object literal is declared as `NonNullable<CreateWikiOptions["dimensionsPort"]>`
 *    and passed through the same `createWiki` call the probe already makes. A field
 *    whose type an embedder cannot name -- because its only spelling lives in a
 *    private workspace package -- is not a public option, so this is the claim that
 *    the addition is actually usable, not merely declared.
 * 2. **The option stays OPTIONAL** (spec S3): `createWiki({ root: "/tmp/x" })` also
 *    type-checks. Omitting the port is valid, and that is the non-breaking half.
 *
 * Both are type-level only. Nothing here opens a database or starts a dimension, so
 * the gate stays DB-free; the DB-backed ingest through the built entry belongs to
 * the artifact tier (`test/artifact/entries-ingest-port.test.ts`).
 */
async function verifyInstalledTypes(repo: string, fixture: string): Promise<void> {
  await writeFile(path.join(fixture, "types.ts"), `
    import { createWiki, type CreateWikiOptions as FacadeOptions, type Wiki } from "llm-wiki-compiler";
    import type { SlugSafe, WikiCore } from "@atomicstrata/llmwiki-core";
    import type { CreateWikiOptions } from "@atomicstrata/llmwiki-core/compiler-sdk";
    declare const wiki: Wiki;
    declare const options: CreateWikiOptions;
    declare const slug: SlugSafe;
    /** True only when each package's type is assignable to the other's. */
    type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    /** True when a branded type collapsed to plain string in the published .d.ts. */
    type ErasedToPlainString<T> = [T] extends [string] ? ([string] extends [T] ? true : false) : false;
    const sameContract: MutuallyAssignable<Wiki, WikiCore> = true;
    const core: WikiCore = wiki;
    const facade: Wiki = createWiki(options);
    const slugText: string = slug;
    const brandSurvives: ErasedToPlainString<SlugSafe> = false;

    /** The port type as the core's installed declarations state it. */
    type CorePort = NonNullable<CreateWikiOptions["dimensionsPort"]>;
    /** The same field as the ROOT facade's installed declarations state it. */
    type FacadePort = NonNullable<FacadeOptions["dimensionsPort"]>;

    /** A hand-written port: no private package is needed to satisfy the contract. */
    const port: CorePort = { resolve: () => [] };
    /** Both published entries name the SAME port type, so a consumer cannot drift. */
    const samePortType: MutuallyAssignable<CorePort, FacadePort> = true;
    /** Supplying it is accepted through the public option. */
    const supplied: Wiki = createWiki({ ...options, dimensionsPort: port });
    /** Omitting it stays valid (spec S3): the field is optional, never required. */
    const omitted: Wiki = createWiki({ root: "/tmp/x" });
    void [sameContract, core, facade, slugText, brandSurvives, samePortType, supplied, omitted];
  `);
  execFileSync(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "types.ts"],
  { cwd: fixture, stdio: "pipe" });
}

/**
 * The INSTALLED manifest is the packed one, and NOTHING else reads it.
 *
 * `test/declared-dependencies-wiring.test.ts` can only inspect this checkout's
 * `package.json`; what a packer rewrites, drops or leaves verbatim is invisible
 * to it. So the two properties the guard there asserts are asserted again here
 * against `node_modules/llm-wiki-compiler/package.json` — the file an embedder's
 * installer actually resolves. Same helper, same grammar, different artefact:
 * no local protocol such as `workspace:`, and every range registry-ranged or
 * URL-shaped.
 */
async function verifyInstalledManifest(fixture: string): Promise<void> {
  const manifestPath = path.join(fixture, "node_modules/llm-wiki-compiler/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(Object.keys(manifest.dependencies ?? {}).length).toBeGreaterThan(0);
  const pinned = findDependenciesByProtocol(manifest.dependencies, [WORKSPACE_PROTOCOL_PREFIX]);
  expect(pinned, `packed manifest pins a local protocol: ${describeDependencyViolations(pinned)}`).toEqual([]);
  const uninstallable = findUninstallableDependencies(manifest.dependencies);
  expect(uninstallable, `packed manifest has uninstallable ranges: ${describeDependencyViolations(uninstallable)}`).toEqual([]);
}

/**
 * Runtime dependencies the collapsed root manifest must declare and install.
 *
 * The engine bundled into `dist/index.js` externalizes these three, each for a
 * recorded reason (`Dynamic require of "ajv"/"tty" is not supported` when a
 * CommonJS dependency is bundled into ESM output), so a manifest that omits one
 * publishes a tarball that cannot start. The split hid this by declaring them in
 * the second package; the collapse moves them here.
 */
const ENGINE_RUNTIME_DEPENDENCIES: readonly string[] = ["@hono/node-server", "ajv", "express"];

/** The floor the bundled engine requires of the MCP SDK, which the split let root under-declare. */
const MCP_SDK_FLOOR = "1.32.1";

/**
 * Compare two dotted versions numerically.
 *
 * Written here rather than pulled from a semver dependency: this fixture asserts
 * one range, and adding an install for it would make the packaging gate depend on
 * a package it does not otherwise need.
 *
 * @param left - First version, dotted.
 * @param right - Second version, dotted.
 * @returns Negative, zero or positive, as `left` sorts before, equal or after `right`.
 */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The lowest version a range admits, which is what an installer must satisfy. */
function rangeFloor(range: string): string {
  return range.replace(/^[^0-9]*/, "");
}

/**
 * The engine's dependencies are declared in the PACKED manifest and really installed.
 *
 * Both halves matter: a declaration whose package is missing from the tree is a
 * tarball that fails at its first import, and a package present only because the
 * hoisted workspace layout made it ambient is the blind spot this whole case exists
 * for. Reading `node_modules/<name>/package.json` under the CLEAN fixture proves the
 * consumer's installer put it there.
 *
 * @param fixture - The clean project the tarball was installed into.
 */
async function verifyInstalledRuntimeDependencies(fixture: string): Promise<void> {
  const installed = path.join(fixture, "node_modules");
  const manifest = JSON.parse(await readFile(path.join(installed, "llm-wiki-compiler/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declared = manifest.dependencies ?? {};
  const undeclared = ENGINE_RUNTIME_DEPENDENCIES.filter(name => declared[name] === undefined);
  expect(undeclared, "the packed manifest must declare every external of the engine it bundles").toEqual([]);
  for (const name of ENGINE_RUNTIME_DEPENDENCIES) {
    const resolved = await stat(path.join(installed, name, "package.json")).catch(() => null);
    expect(resolved?.isFile() ?? false, `${name} must be installed for the bundled engine to import it`).toBe(true);
  }
  const declaredRange = declared["@modelcontextprotocol/sdk"] ?? "";
  expect(
    compareVersions(rangeFloor(declaredRange), MCP_SDK_FLOOR),
    `the packed manifest declares @modelcontextprotocol/sdk ${declaredRange}, below the ${MCP_SDK_FLOOR} the engine needs`,
  ).toBeGreaterThanOrEqual(0);
  const sdk = JSON.parse(await readFile(path.join(installed, "@modelcontextprotocol/sdk/package.json"), "utf8")) as {
    version?: string;
  };
  expect(compareVersions(sdk.version ?? "0.0.0", MCP_SDK_FLOOR)).toBeGreaterThanOrEqual(0);
}

/** The title the installed package gives the page it ingests. */
const INGEST_TITLE = "Installed Tarball Ingest";
/** Enough body text to clear the minimum source length the ingest enforces. */
const INGEST_BODY = "Body long enough to clear the minimum source length the ingest enforces.";

/**
 * The probe the CLEAN fixture runs: only the installed package, no repo alias.
 *
 * It writes its verdict to a file instead of stdout because the ingest is allowed to
 * log progress, and a test that parsed the last stdout line would be reading the
 * engine's logging rather than the ingest's result.
 */
const INGEST_PROBE = `
import { writeFile } from "node:fs/promises";
const { createWiki } = await import("llm-wiki-compiler");
const wiki = createWiki({ root: process.env.WIKI_INGEST_ROOT });
const result = await wiki.ingestText({ title: process.env.WIKI_INGEST_TITLE, text: process.env.WIKI_INGEST_BODY });
const pages = await wiki.listPages();
await writeFile(process.env.WIKI_INGEST_RESULT, JSON.stringify({
  writeStatus: result.writeStatus,
  titles: pages.pages.map((page) => page.title),
}));
`;

/**
 * A REAL ingest, executed by the INSTALLED package (spec S2's second half).
 *
 * `typeof createWiki === "function"` says the entry loads; it says nothing about
 * whether the engine behind it runs. An ingest writes through the dimensions, so it
 * needs a Stack: the repository's probe fixture provides one and applies the shared
 * loud no-database rule, which FAILS rather than silently skipping. There is no
 * database-free ingest to use instead — `writeToDimensions` provisions the default
 * Stack at `packages/wiki/src/services/ingest/service.ts:190` before any
 * `dimensionsPort` is consulted, and the wiki dimension writes pages as Postgres rows.
 *
 * @param fixture - The clean project the tarball was installed into.
 * @param probe - The suite's probe Stack, naming the Stack and database the probe uses.
 */
async function ingestThroughInstalledPackage(fixture: string, probe: ProbeStack): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-ingest-"));
  const resultPath = path.join(fixture, "ingest-result.json");
  try {
    await writeFile(path.join(fixture, "ingest.mjs"), INGEST_PROBE);
    execFileSync("node", ["ingest.mjs"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        ...probe.env(),
        WIKI_INGEST_ROOT: root,
        WIKI_INGEST_RESULT: resultPath,
        WIKI_INGEST_TITLE: INGEST_TITLE,
        WIKI_INGEST_BODY: INGEST_BODY,
      },
    });
    const ingested = JSON.parse(await readFile(resultPath, "utf8")) as { writeStatus?: string; titles?: string[] };
    expect(ingested.writeStatus).toBe("created");
    expect(ingested.titles, "the ingest must be readable back through the installed package").toContain(INGEST_TITLE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The installed package that is the whole distribution once the collapse lands. */
const INSTALLED_PACKAGE = "llm-wiki-compiler";

/** The `exports` key the collapse must hand embedders in place of the core's own subpath. */
const COMPILER_SDK_EXPORT_KEY = "./compiler-sdk";

/** The little of the INSTALLED manifest this file reads. */
interface InstalledManifest {
  exports?: Record<string, unknown>;
}

/**
 * The compiler-sdk specifier, resolved FROM THE INSTALLED MANIFEST rather than hard-coded.
 *
 * Naming the specifier in this file would assert only that one string works in one checkout.
 * Reading the subpath out of the PACKED manifest asserts what an embedder actually depends on,
 * and asserts it three times over: the key is DECLARED, its `import` target EXISTS inside the
 * installed tarball, and — once the probe imports the constructed specifier — it RESOLVES. A
 * rename, a forgotten `files` entry or an unpublished subpath therefore fails here, and it
 * fails with the manifest key named instead of with a bare resolution error.
 *
 * @param fixture - The clean project the tarball was installed into.
 * @returns The specifier to import, built from the key the manifest declares.
 */
async function resolveInstalledCompilerSdk(fixture: string): Promise<string> {
  const packageRoot = path.join(fixture, "node_modules", INSTALLED_PACKAGE);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as InstalledManifest;
  const declared = manifest.exports?.[COMPILER_SDK_EXPORT_KEY] as Record<string, string | undefined> | string | undefined;
  expect(
    declared,
    `the packed manifest must DECLARE exports["${COMPILER_SDK_EXPORT_KEY}"]: it is an embedder's only door to withQuiet`,
  ).toBeDefined();
  const target = typeof declared === "string" ? declared : declared?.["import"];
  expect(target, `exports["${COMPILER_SDK_EXPORT_KEY}"] must name an \`import\` target`).toBeTruthy();
  const resolved = await stat(path.resolve(packageRoot, target ?? "")).catch(() => null);
  expect(
    resolved?.isFile() ?? false,
    `exports["${COMPILER_SDK_EXPORT_KEY}"] -> ${target} must exist inside the installed tarball`,
  ).toBe(true);
  return `${INSTALLED_PACKAGE}/${COMPILER_SDK_EXPORT_KEY.replace(/^\.\//, "")}`;
}

/**
 * The quiet probe: enter `withQuiet` FROM THE PACKAGED SUBPATH and emit through the engine.
 *
 * The subpath arrives in `WIKI_COMPILER_SDK` because {@link resolveInstalledCompilerSdk} derives
 * it from the installed manifest; a literal here would be the hard-coded assertion that step
 * exists to replace.
 *
 * `ingestText` is the emitting operation because it is the one whose engine path writes
 * through `utils/output.ts` (`services/ingest/service.ts:251` prints
 * `Ingesting [<type>]: <source>` via `output.status`). Both streams are captured, not
 * filtered: quiet means SILENT, and a warning on stderr is as much a defect as a status
 * line on stdout.
 */
const QUIET_PROBE = `
import { writeFile } from "node:fs/promises";
const { withQuiet } = await import(process.env.WIKI_COMPILER_SDK);
const { createWiki } = await import("llm-wiki-compiler");
const wiki = createWiki({ root: process.env.WIKI_QUIET_ROOT });
const result = await withQuiet(() => wiki.ingestText({
  title: process.env.WIKI_INGEST_TITLE,
  text: process.env.WIKI_INGEST_BODY,
}));
await writeFile(process.env.WIKI_QUIET_RESULT, JSON.stringify({ writeStatus: result.writeStatus }));
`;

/**
 * Quiet output survives the collapse, proven by EXECUTION through the installed tarball (S4).
 *
 * The RED this encodes is the absent manifest key: until root publishes `exports["./compiler-sdk"]`,
 * {@link resolveInstalledCompilerSdk} fails with the key named, so the subpath is unproven before a
 * single byte of output is considered.
 *
 * WHAT THIS ASSERTS, AND WHAT IT CANNOT (measured, not assumed). Every `WikiCore`
 * method is wrapped in `runQuiet` (`packages/wiki/src/sdk/core.ts:59`, applied at
 * `:96`-`:212`), so an SDK operation emits nothing whether or not the caller opened a
 * quiet scope — six public operations called on a fresh root produced zero bytes. The
 * duck-typed instance-identity hazard therefore cannot be OBSERVED through a public
 * method: a duplicate `AsyncLocalStorage` would leave this stream assertion green.
 * That half is asserted structurally in `test/artifact/bundle-engine.test.ts`, which
 * requires `dist/compiler-sdk.js` to construct NO quiet scope of its own. What this
 * case does prove is what S4 is about at the artefact level: a real ingest runs through
 * the published subpath inside a quiet scope and NOTHING reaches either stream.
 *
 * @param fixture - The clean project the tarball was installed into.
 * @param probe - The suite's probe Stack, naming the Stack and database the probe uses.
 */
async function quietScopeThroughInstalledSubpath(fixture: string, probe: ProbeStack): Promise<void> {
  const specifier = await resolveInstalledCompilerSdk(fixture);
  const root = await mkdtemp(path.join(tmpdir(), "wiki-quiet-"));
  const resultPath = path.join(fixture, "quiet-result.json");
  try {
    await writeFile(path.join(fixture, "quiet.mjs"), QUIET_PROBE);
    const run = spawnSync("node", ["quiet.mjs"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        ...probe.env(),
        WIKI_COMPILER_SDK: specifier,
        WIKI_QUIET_ROOT: root,
        WIKI_QUIET_RESULT: resultPath,
        WIKI_INGEST_TITLE: INGEST_TITLE,
        WIKI_INGEST_BODY: INGEST_BODY,
      },
    });
    expect(run.status, `the packaged ${specifier} probe must run; stderr:\n${run.stderr}`).toBe(0);
    const quieted = JSON.parse(await readFile(resultPath, "utf8")) as { writeStatus?: string };
    expect(quieted.writeStatus, "the quiet ingest must still do its work").toBe("created");
    expect(run.stdout, "quiet output must be silent on stdout").toBe("");
    expect(run.stderr, "quiet output must be silent on stderr").toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Run the installed-tarball probes against one probe Stack.
 *
 * One Stack for both probes: provisioning is a real database operation, and neither probe
 * needs isolation from the other — each writes to its own temp root under its own title.
 * The fixture is imported LAZILY so a machine without a database still runs the install
 * and import assertions above, and fails only here, with the shared actionable message.
 *
 * @param fixture - The clean project the tarball was installed into.
 * @param run - The probes, given the Stack they share.
 */
async function withInstalledProbeStack(fixture: string, run: (probe: ProbeStack) => Promise<void>): Promise<void> {
  const { createProbeSuite } = await import("../fixtures/probe-stack-suite.js");
  const suite = await createProbeSuite({
    label: "pack-install",
    databaseContext: "test/sdk/packaging.test.ts",
    title: "the installed tarball runs the engine",
  });
  const probe = suite.probeStack();
  try {
    await run(probe);
  } finally {
    await probe.harness.cleanup();
  }
}

describe("packaging (slow; run via `npm run test:pack`)", () => {
  it("the root tarball installs alone, imports, and ingests", async () => {
    const repo = process.cwd();
    execFileSync("npm", ["run", "build"], { stdio: "ignore", cwd: repo });
    expect((await readFile(path.join(repo, "dist/index.js"), "utf-8")).startsWith("#!")).toBe(false);
    await readFile(path.join(repo, "dist/index.d.ts"), "utf-8"); // throws if missing

    const out = await mkdtemp(path.join(tmpdir(), "wiki-pack-"));    // pack INTO temp
    const fixture = await mkdtemp(path.join(tmpdir(), "wiki-fix-"));
    try {
      const tarballs = packDistribution(repo, out);
      await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "f", type: "module" }));
      expect(tarballs, "the root tarball is the whole distribution: nothing is installed beside it")
        .toHaveLength(1);
      const install = spawnSync("npm", ["install", "--ignore-scripts", ...tarballs], {
        cwd: fixture,
        encoding: "utf8",
      });
      // npm's own stderr, carried into the failure: an installer that refuses this
      // tarball says WHY (`ETARGET`, `EUNSUPPORTEDPROTOCOL`, a missing peer), and a
      // silent `stdio: "ignore"` turned that into an unattributable "Command failed".
      expect(install.status, `the root tarball must install alone; npm said:\n${install.stderr}`).toBe(0);
      await verifyInstalledManifest(fixture);
      await verifyInstalledRuntimeDependencies(fixture);
      await writeFile(path.join(fixture, "probe.mjs"), `import { createWiki } from "llm-wiki-compiler"; if (typeof createWiki !== "function") process.exit(2);`);
      execFileSync("node", ["probe.mjs"], { cwd: fixture, stdio: "ignore" });
      await verifyInstalledTypes(repo, fixture);
      await withInstalledProbeStack(fixture, async probe => {
        await ingestThroughInstalledPackage(fixture, probe);
        await quietScopeThroughInstalledSubpath(fixture, probe);
      });
    } finally {
      await rm(out, { recursive: true, force: true });   // no .tgz left in the repo
      await rm(fixture, { recursive: true, force: true });
    }
  }, 180_000);
});
