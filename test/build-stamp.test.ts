/**
 * @file Unit tests for the globalSetup build cache.
 *
 * The cache exists to skip a ~42s tsup build, but its failure mode is
 * asymmetric: a wrong skip tests stale code, while a wrong rebuild only costs
 * time. These tests therefore pin the fail-safe direction on every uncertain
 * case (absent stamp, corrupt stamp, missing outputs, changed inputs) and prove
 * the happy path still recognises an unchanged tree.
 *
 * One case pins the other direction of the same asymmetry: every required output
 * must be a file this workspace's build really writes. An entry nobody produces
 * is a permanent miss, which silently disables the cache for every run instead
 * of merely costing one build.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearStamp,
  computeInputsHash,
  isBuildFresh,
  REQUIRED_OUTPUTS,
  STAMP_PATH,
  writeStamp,
} from "../scripts/build-stamp.js";

let root: string;

/**
 * The files a real `tsup` run at the repository root writes: two root bundles
 * (the `@repo/api` launcher the container execs, and the library entry with its
 * `d.ts`) plus the built dependency package. Deliberately NOT derived from
 * `REQUIRED_OUTPUTS` — a seed read out of the module under test would make every
 * case below vacuous.
 */
const BUILT_OUTPUTS = [
  "dist/api.js",
  "dist/index.js",
  "dist/index.d.ts",
  "packages/llmwiki-core/dist/index.js",
];

/** Create the minimum tree the stamp inspects, plus every output the build emits. */
function seedProject(): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/index.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "tsup.config.ts"), "export default {};\n");
  for (const output of BUILT_OUTPUTS) {
    mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
    writeFileSync(path.join(root, output), "built\n");
  }
}

/** Workspace directories the root manifest declares, as repository-relative paths. */
function declaredWorkspaces(): string[] {
  const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
    workspaces?: string[];
  };
  return manifest.workspaces ?? [];
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "build-stamp-"));
  seedProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isBuildFresh", () => {
  it("is false before any build has been recorded", () => {
    expect(isBuildFresh(root)).toBe(false);
  });

  it("is true for a tree holding exactly the outputs the build produces", () => {
    writeStamp(root);
    expect(isBuildFresh(root)).toBe(true);
  });

  it("is false when a dependency package output is missing", () => {
    writeStamp(root);
    rmSync(path.join(root, "packages/llmwiki-core/dist/index.js"));
    expect(isBuildFresh(root)).toBe(false);
  });

  it("requires only outputs from packages this workspace declares and builds", () => {
    const workspaces = declaredWorkspaces();
    const packageOutputs = REQUIRED_OUTPUTS.filter((output) => output.startsWith("packages/"));
    expect(packageOutputs.length).toBeGreaterThan(0);
    for (const output of packageOutputs) {
      const directory = output.slice(0, output.indexOf("/dist/"));
      expect(workspaces, `${output} names ${directory}`).toContain(directory);
      expect(existsSync(directory), `${output} names ${directory}`).toBe(true);
    }
  });

  it("is false when an input changes", () => {
    writeStamp(root);
    writeFileSync(path.join(root, "src/index.ts"), "export const a = 2;\n");
    expect(isBuildFresh(root)).toBe(false);
  });

  it("is false when a new input file appears", () => {
    writeStamp(root);
    writeFileSync(path.join(root, "src/added.ts"), "export const b = 1;\n");
    expect(isBuildFresh(root)).toBe(false);
  });

  it("is false when a built output is missing", () => {
    writeStamp(root);
    rmSync(path.join(root, "dist/api.js"));
    expect(isBuildFresh(root)).toBe(false);
  });

  it.each([
    ["not json", "not json at all"],
    ["wrong version", JSON.stringify({ version: 99, inputsHash: "x" })],
    ["missing hash", JSON.stringify({ version: 1 })],
  ])("is false for a %s stamp", (_label, contents) => {
    writeStamp(root);
    writeFileSync(path.join(root, STAMP_PATH), contents);
    expect(isBuildFresh(root)).toBe(false);
  });

  it("is false after the stamp is cleared", () => {
    writeStamp(root);
    clearStamp(root);
    expect(isBuildFresh(root)).toBe(false);
  });
});

describe("computeInputsHash", () => {
  it("ignores an unbuilt sibling directory so churn in dist cannot invalidate it", () => {
    const before = computeInputsHash(root);
    writeFileSync(path.join(root, "dist/api.js"), "rebuilt differently\n");
    expect(computeInputsHash(root)).toBe(before);
  });

  it("changes when source content changes", () => {
    const before = computeInputsHash(root);
    writeFileSync(path.join(root, "src/index.ts"), "export const a = 3;\n");
    expect(computeInputsHash(root)).not.toBe(before);
  });
});
