/**
 * @file Pin the per-package task surfaces and the cache-less turbo graph as data.
 *
 * ## What this file protects
 *
 * Two things in this slice are policy rather than behavior, so no test that RUNS
 * anything can catch their removal: every task in `turbo.json` is declared
 * cache-less, and no gate is routed through Turborepo. A cache hit is a green
 * that did not execute, and the user's goal here is order and selection, not
 * speed — so the day someone flips `cache` to `true`, this file must go red
 * rather than the gate going quietly faster and quieter. The files are therefore
 * read as DATA: `turbo.json` is parsed, `package.json` manifests are parsed, and
 * nothing spawns turbo or any task.
 *
 * ## The frozen scripts are frozen on purpose
 *
 * `FROZEN_ROOT_SCRIPTS` records the root gate scripts byte for byte as they
 * stood when this slice was written. Every gate of record (`test`,
 * `test:unit`, `test:integration`, `test:affected`, `test:pack`, `gates:static`,
 * `build`, `lint`, `fallow:ci`, `fallow:kg`, `typecheck:tests`,
 * `typecheck:kg`) must still be exactly that string, and none may mention
 * `turbo`. That is the "do not route any gate through Turborepo" rule pinned as
 * an assertion: a change that sends `test` through `turbo run test` has to
 * delete this line first, in a diff a reviewer can see.
 *
 * `@repo/kg`'s untouched scripts are frozen the same way, because this slice
 * REPLACES its `test` and `typecheck` values: the fix for a package collecting
 * 142 of 820 files must not quietly take `build`, `dev`, `start`, `test:watch`
 * or `eval:kg` with it.
 *
 * ## The root SCRIPTS are what is frozen, even though CI calls the graph
 *
 * CI's `build-and-test` job runs `turbo run build` and `turbo run test --filter=//`
 * (`odd/tasks/ci-turbo-front-door.md`), so Turborepo is the front door THERE. What the
 * `FROZEN_ROOT_SCRIPTS` assertion below still pins is the ROOT scripts: they stay
 * exactly as they were, and none may mention `turbo`. That is how the two never become
 * each other — the graph calls the scripts, never the reverse — and a change that wires
 * a root script back through `turbo run` has to delete that assertion first.
 *
 * ## `test` has no dependency edge, and `turbo.json` says why
 *
 * The graph once ordered a package's tests after its workspace dependencies'
 * tests (`dependsOn: ["^test"]`) to keep two suites from writing the single
 * pgvector database at once. That was the wrong mechanism for a real concern: a
 * filtered `turbo run test --filter=@repo/wiki` then executed 972 test runs
 * (406 `@repo/foundation` + 566 `@repo/wiki`) instead of the 566 the filter
 * selected, and a dependant's change does **not** invalidate its dependencies'
 * already-passing tests. Database serialisation is a CONCURRENCY concern, so it
 * is declared as `concurrency: "1"` at the root of the graph, where it cannot be
 * forgotten, and every task keeps `dependsOn: []`. This file pins both halves:
 * no task may grow a `^test` edge again, and the concurrency cap must stay in
 * `turbo.json` rather than moving into an environment variable.
 *
 * ## The transitional package is asserted to stay surface-less — by construction now
 *
 * `@atomicstrata/llmwiki-core` was on its way to becoming a thin alias of
 * `@repo/wiki` or disappearing, and it must declare no `test`, `lint`,
 * `typecheck` or `fallow` script while it exists: a task surface added there would
 * be a surface that has to be removed later, and a green that means nothing in the
 * meantime.
 *
 * `odd/tasks/collapse-core-package.md` resolved that choice by DELETION, so the
 * guard below states the stronger form of the same claim: the packages carrying a
 * task surface are exactly the members the root manifest declares, and the deleted
 * package is neither. A directory nobody declares cannot grow a surface, and a
 * declared member cannot ship without one.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/** Absolute repository root, from this test file's location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Every task the graph declares, in sorted order. */
const DECLARED_TASKS: readonly string[] = [
  "//#build",
  "//#test",
  "build",
  "fallow",
  "lint",
  "test",
  "typecheck",
];

/**
 * The root gate scripts, frozen byte for byte at the commit that added this file.
 *
 * A NAME CHANGING VALUE HERE IS A GATE CHANGE, not a refactor: `test` is the gate
 * of record and `test:affected`'s exit codes (78 full tier, 69 uncomputable,
 * 0 true negative) are load-bearing. Update this table only in the same diff that
 * deliberately changes the gate, with the new behavior described.
 */
const FROZEN_ROOT_SCRIPTS: Readonly<Record<string, string>> = {
  test: "vitest run",
  "test:unit": "vitest run $(node scripts/test-partition.ts unit | tr '\\n' ' ')",
  "test:integration":
    "vitest run --maxWorkers=2 $(node scripts/test-partition.ts integration | tr '\\n' ' ')",
  "test:affected": "node scripts/run-affected-tests.ts",
  "test:pack": "vitest run --config test/sdk/vitest.packaging.config.ts",
  "gates:static": "node scripts/static-gates.ts",
  build: "tsup",
  lint: "node scripts/lint-ratchet.ts",
  "fallow:ci": "bash scripts/fallow-ci.sh",
  "fallow:kg":
    "./node_modules/.bin/fallow --root packages/llmwiki-kg/ts -c packages/llmwiki-kg/ts/.fallowrc.json audit --format json --gate new-only --dead-code-baseline baselines/dead-code-baseline.json --health-baseline baselines/health-baseline.json --dupes-baseline baselines/dupes-baseline.json -q",
  "typecheck:tests": "node scripts/typecheck-tests.ts",
  "typecheck:kg": "node scripts/kg-typecheck.ts",
};

/** `@repo/kg`'s scripts this slice does not own, frozen so it cannot widen its own change. */
const FROZEN_KG_SCRIPTS: Readonly<Record<string, string>> = {
  dev: "tsx watch src/index.ts",
  build: "tsc -p tsconfig.build.json",
  start: "node dist/index.js",
  "test:watch": "vitest",
  "eval:kg": "tsx src/core/eval/cli.ts",
};

/** One package that must carry a task surface, with its own relative script path. */
interface SurfaceDeclaration {
  readonly directory: string;
  readonly name: string;
  readonly scriptPath: string;
}

/** The four packages with a task surface; `@repo/kg` sits one level deeper. */
const SURFACES: readonly SurfaceDeclaration[] = [
  { directory: "packages/foundation", name: "@repo/foundation", scriptPath: "../../scripts/package-tasks.ts" },
  { directory: "packages/wiki", name: "@repo/wiki", scriptPath: "../../scripts/package-tasks.ts" },
  { directory: "packages/api", name: "@repo/api", scriptPath: "../../scripts/package-tasks.ts" },
  { directory: "packages/llmwiki-kg/ts", name: "@repo/kg", scriptPath: "../../../scripts/package-tasks.ts" },
];

/** The tasks every package must declare. */
const PER_PACKAGE_TASKS: readonly string[] = ["test", "lint", "typecheck"];

/** One declared turbo task, as this file reads it. */
interface TurboTask {
  cache?: boolean;
  dependsOn?: string[];
}

/**
 * Either a JSON string literal (kept) or a comment (removed), so a comment
 * marker INSIDE a string is never mistaken for a comment.
 */
const STRING_OR_COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Remove `//` and block comments from JSONC without touching string contents. */
function stripJsonComments(text: string): string {
  return text.replace(STRING_OR_COMMENT, (match) => (match.startsWith('"') ? match : ""));
}

/** Read and parse a JSONC file under the repository root. */
function readJsonc<T>(relativePath: string): T {
  const text = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  return JSON.parse(stripJsonComments(text)) as T;
}

/** The whole parsed `turbo.json`, so root-level policy keys are visible too. */
interface TurboConfig {
  concurrency?: string;
  tasks: Record<string, TurboTask>;
}

/** Read the graph itself, root keys included. */
function turboConfig(): TurboConfig {
  return readJsonc<TurboConfig>("turbo.json");
}

/** The declared tasks of the graph, keyed by task name. */
function turboTasks(): Record<string, TurboTask> {
  return turboConfig().tasks;
}

/** The scripts of one workspace member, or of the root when the path is `.`. */
function manifestScripts(directory: string): Record<string, string | undefined> {
  const text = readFileSync(path.join(REPO_ROOT, directory, "package.json"), "utf8");
  return (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
}

/** The workspace directories the root manifest declares, in declared order. */
function declaredWorkspaces(): string[] {
  const text = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return (JSON.parse(text) as { workspaces?: string[] }).workspaces ?? [];
}

it("declares every turbo task cache-less", () => {
  const tasks = turboTasks();
  expect(Object.keys(tasks).sort()).toEqual([...DECLARED_TASKS]);
  for (const [name, task] of Object.entries(tasks)) {
    expect(task.cache, `${name} must not be cached`).toBe(false);
  }
});

it("declares no test dependency edge and orders nothing else", () => {
  const tasks = turboTasks();
  expect(tasks.test?.dependsOn).toEqual([]);
  expect(tasks.lint?.dependsOn).toEqual([]);
  expect(tasks.typecheck?.dependsOn).toEqual([]);
  expect(tasks.fallow?.dependsOn).toEqual([]);
  // A `^test` edge ANYWHERE would re-introduce the defect this ruling removed:
  // a filtered run of one package would execute its dependencies' tests too.
  for (const [name, task] of Object.entries(tasks)) {
    expect(task.dependsOn ?? [], `${name} must not depend on a dependency's tests`).not.toContain("^test");
  }
});

it("serialises task execution in the graph rather than in an environment variable", () => {
  // Database serialisation is real, but it is a concurrency concern: one task at
  // a time. Declared in `turbo.json` it cannot be forgotten; an env var can.
  expect(turboConfig().concurrency).toBe("1");
});

it("declares the root and build tasks cache-less and still gives no non-emitting package a build script", () => {
  const tasks = turboTasks();
  // 1. The build surface exists, and the ROOT project's half of it exists as `//#`
  // entries: turbo names the root package `//`, so a bare `build` key alone would
  // leave the tsup distribution OUT of `turbo run build`.
  for (const name of ["build", "//#build", "//#test"]) {
    expect(Object.keys(tasks), `${name} must be declared`).toContain(name);
  }
  // 2. Cache-less like every other task: a cache hit on a build is an artefact
  // nobody produced in that run, reported as if they had.
  for (const [name, task] of Object.entries(tasks)) {
    expect(task.cache, `${name} must not be cached`).toBe(false);
  }
  // 3. No `^build` edge ANYWHERE. The root tsup run bundles every `@repo/*` package
  // from source, so nothing consumes another build's output; an edge would be a
  // claim about a dependency that does not exist.
  for (const [name, task] of Object.entries(tasks)) {
    expect(task.dependsOn ?? [], `${name} must not depend on a dependency's build`).not.toContain("^build");
  }
  // 4. The invariant the ORIGINAL case protected, kept with its teeth: the members
  // that emit nothing must still declare no `build` script, or `turbo run build`
  // gains a queued task that reports success while producing no artefact.
  for (const surface of SURFACES.filter((entry) => entry.name !== "@repo/kg")) {
    expect(manifestScripts(surface.directory).build, `${surface.name} build`).toBeUndefined();
  }
});

it("keeps every root gate script byte-identical and free of turbo", () => {
  const scripts = manifestScripts(".");
  for (const [name, command] of Object.entries(FROZEN_ROOT_SCRIPTS)) {
    expect(scripts[name], `root script ${name}`).toBe(command);
    expect(command).not.toContain("turbo");
  }
});

it("gives each workspace package a derived test, lint and typecheck surface", () => {
  for (const surface of SURFACES) {
    const scripts = manifestScripts(surface.directory);
    for (const task of PER_PACKAGE_TASKS) {
      const expected = `node ${surface.scriptPath} ${task} --package ${surface.name}`;
      expect(scripts[task], `${surface.name} ${task}`).toBe(expected);
    }
  }
});

it("gives a fallow surface only to the package that has a baseline", () => {
  const kg = manifestScripts("packages/llmwiki-kg/ts");
  expect(kg.fallow).toBe("node ../../../scripts/package-tasks.ts fallow --package @repo/kg");
  for (const surface of SURFACES.filter((entry) => entry.name !== "@repo/kg")) {
    expect(manifestScripts(surface.directory).fallow, `${surface.name} fallow`).toBeUndefined();
  }
});

it("leaves @repo/kg's own scripts untouched apart from test and typecheck", () => {
  const scripts = manifestScripts("packages/llmwiki-kg/ts");
  for (const [name, command] of Object.entries(FROZEN_KG_SCRIPTS)) {
    expect(scripts[name], `kg script ${name}`).toBe(command);
  }
});

it("gives a task surface to exactly the declared workspace members, and none to the removed core", () => {
  const members = declaredWorkspaces();
  // The surface set is DERIVED against the workspace set, so a package added or deleted
  // without thinking about its task surface fails here rather than shipping a surface
  // nobody meant to publish. This is what "the transitional core package has no task
  // surface" became once the collapse resolved that package by deletion: it is not a
  // member, so there is nothing left to carry a script.
  expect(members.length, "an empty workspace list would make this assertion vacuous").toBeGreaterThan(0);
  expect(SURFACES.map((surface) => surface.directory).sort(), "every member carries a surface").toEqual(
    [...members].sort(),
  );

  // The specific package the original case policed: absent from the workspace set AND
  // absent from the disk, so no later edit can hand it a `test`/`lint`/`typecheck`/`fallow`
  // script by re-creating the directory.
  expect(members).not.toContain("packages/llmwiki-core");
  expect(
    existsSync(path.join(REPO_ROOT, "packages/llmwiki-core")),
    "packages/llmwiki-core was collapsed into packages/wiki; a re-created directory would carry no task surface",
  ).toBe(false);
});
