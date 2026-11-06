/**
 * @file test/sdk/test-pack-selection.test.ts
 * @description Pins WHICH file `npm run test:pack` is allowed to collect, so a sibling
 * checkout cannot change what the packaging gate runs.
 *
 * WHY THIS PIN EXISTS. The gate collecting exactly one file is not self-evident from the
 * command; it is the joint product of a dedicated config and a script that carries no
 * positional argument, and BOTH halves broke before. The original script was
 * `vitest run --config /dev/null test/sdk/packaging.test.ts`; with `/dev/null` as the
 * config, vitest falls back to its built-in defaults and a positional argument becomes a
 * SUBSTRING FILTER over discovered filenames. So every sibling checkout whose tree
 * contained that path — `.worktrees/<branch>/test/sdk/packaging.test.ts` — was collected
 * and run as well. The gate still reported "1 test passed" while running files from
 * unrelated branches, which means its result depended on what happened to be on disk
 * rather than on this repository.
 *
 * WHY IT IS A TEST AND NOT A COMMENT. The property was proved by hand twice: run
 * `vitest list` under the old command shape and see several files, run it under the
 * pinned config and see one. Both proofs were correct and both evaporated, because
 * nothing failed when the command was re-typed or the config relaxed. A one-line comment
 * cannot regress-test a selection; this file can.
 *
 * DO NOT "SIMPLIFY" `test:pack` BACK to `--config /dev/null` plus a positional argument.
 * That shape looks equivalent and is not: it asks vitest to discover-and-filter, and the
 * filter it applies is a substring match, not an exact path. Restoring it reintroduces the
 * whole defect class, and the assertions below will say so instead of letting a
 * "1 passed" masquerade as proof.
 *
 * THE THREE LAYERS, because any one alone is falsely reassuring:
 *   1. the CONFIG contract — `include` is one literal path, not a glob that could match
 *      siblings, and none of the main config's database harness is inherited;
 *   2. the SCRIPT contract — no positional path, since that is what turns an exact file
 *      into a substring filter;
 *   3. the OBSERVED selection — `vitest list` through that config, asserting the collected
 *      file set. Layers 1 and 2 describe intent; only this one watches it hold.
 *
 * NO PROBE FILES ARE CREATED. Proving "a sibling checkout cannot join the run" by making
 * one would put fake repository content inside the checkout, where every tree-walking tool
 * treats it as real (and where cleanup can strand a run). Instead the adversarial path is
 * a pure string matched against the configured `exclude` patterns.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import packagingConfig from "./vitest.packaging.config.js";

/** Repository root, derived from this file's location exactly as the config derives its own. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The config that owns the packaging gate's file selection. */
const CONFIG_PATH = "test/sdk/vitest.packaging.config.ts";

/** The one test file the packaging gate is allowed to collect. */
const PACKAGING_TEST_FILE = "test/sdk/packaging.test.ts";

/** The `test:pack` script verbatim. Any added argument changes what the gate runs. */
const EXPECTED_PACK_SCRIPT = "vitest run --config test/sdk/vitest.packaging.config.ts";

/** A sibling checkout's copy of the packaging test, as a path string only — never created on disk. */
const SIBLING_PACKAGING_PATH = ".worktrees/orchestrator-x/test/sdk/packaging.test.ts";

/**
 * `picomatch` is loaded through `require` because the installed copy ships no type
 * declarations.
 *
 * It is the matcher used on purpose: vitest evaluates `test.exclude` globs with picomatch
 * semantics, so matching the patterns with picomatch tests the gate's actual behaviour
 * instead of a lookalike. `minimatch` and `tinyglobby` are also installed and agree on
 * these patterns, but they would be a proxy for the behaviour rather than the behaviour.
 */
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
const picomatch = requireFromRepo("picomatch") as (pattern: string) => (candidate: string) => boolean;

/** The `test:pack` command as declared by the manifest, or `undefined` if absent. */
function packScript(): string | undefined {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts?.["test:pack"];
}

/**
 * The distinct test files `vitest list` collects through the packaging config.
 *
 * Run through `process.execPath` plus vitest's entry module rather than `npx`: no shell is
 * involved, so the arguments cannot be word-split or glob-expanded by one, and the same
 * Node binary that runs this test performs the collection.
 */
function listCollectedFiles(): string[] {
  const output = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "list", "--config", CONFIG_PATH, "--filesOnly"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, FORCE_COLOR: "0" } },
  );
  const lines = output.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  return [...new Set(lines)];
}

describe("test:pack selection — the config contract", () => {
  it("includes exactly one literal file path", () => {
    // A glob here (say `test/sdk/**/*.test.ts`) would silently widen the gate to every
    // sibling test in this directory, so the expectation is the literal, not a pattern.
    expect(packagingConfig.test?.include).toEqual([PACKAGING_TEST_FILE]);
  });

  it("roots the selection at this repository", () => {
    expect(packagingConfig.root).toBe(REPO_ROOT);
  });

  it("excludes installed dependencies and sibling worktrees", () => {
    expect(packagingConfig.test?.exclude).toContain("**/node_modules/**");
    expect(packagingConfig.test?.exclude).toContain("**/.worktrees/**");
  });

  it("inherits none of the database harness the main config injects", () => {
    // The main config seeds a database URL and provisions Postgres. A packaging smoke test
    // must not need a database, so the pinned config may never grow these three.
    expect(packagingConfig.test?.globalSetup).toBeUndefined();
    expect(packagingConfig.test?.setupFiles).toBeUndefined();
    expect(packagingConfig.test?.env).toBeUndefined();
  });
});

describe("test:pack selection — the script contract", () => {
  it("runs the dedicated config and nothing else", () => {
    expect(packScript()).toBe(EXPECTED_PACK_SCRIPT);
  });

  it("passes no positional path, which vitest reads as a substring filter", () => {
    // This is the original defect stated as an assertion: the presence of the path in the
    // command is what made sibling checkouts join the run.
    expect(packScript()).not.toContain(PACKAGING_TEST_FILE);
  });
});

describe("test:pack selection — the observed selection", () => {
  it("collects exactly one file, by exact path, on any machine", () => {
    // Unconditional on purpose: it must hold with zero sibling checkouts present and with
    // many, so conditioning it on disk state would test the disk instead of the pin.
    expect(listCollectedFiles()).toEqual([PACKAGING_TEST_FILE]);
  }, 120_000);
});

describe("test:pack selection — sibling checkouts are excluded", () => {
  /** True when any configured exclude pattern matches the candidate path. */
  function isExcluded(candidate: string): boolean {
    return (packagingConfig.test?.exclude ?? []).some(pattern => picomatch(pattern)(candidate));
  }

  it("matches a sibling checkout's copy of the packaging test", () => {
    // The `include` pin is the primary defence; this asserts the second layer still holds.
    // It matters for any path that reaches plain discovery (`--changed`, a default run),
    // where `include` alone is not consulted.
    expect(isExcluded(SIBLING_PACKAGING_PATH)).toBe(true);
  });

  it("does not exclude the file the gate must collect", () => {
    // An exclude that also swallowed the pinned file would leave the gate collecting
    // nothing — the failure mode that looks like a pass with a suspiciously small count.
    expect(isExcluded(PACKAGING_TEST_FILE)).toBe(false);
  });
});
