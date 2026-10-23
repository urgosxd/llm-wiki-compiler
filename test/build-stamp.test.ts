/**
 * @file Unit tests for the globalSetup build cache.
 *
 * The cache exists to skip a ~42s tsup build, but its failure mode is
 * asymmetric: a wrong skip tests stale code, while a wrong rebuild only costs
 * time. These tests therefore pin the fail-safe direction on every uncertain
 * case (absent stamp, corrupt stamp, missing outputs, changed inputs) and prove
 * the happy path still recognises an unchanged tree.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearStamp, computeInputsHash, isBuildFresh, STAMP_PATH, writeStamp } from "../scripts/build-stamp.js";

let root: string;

/** Create the minimum tree the stamp inspects, plus every required output. */
function seedProject(): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/index.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "tsup.config.ts"), "export default {};\n");
  for (const output of [
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "packages/llmwiki-core/dist/index.js",
    "packages/llmwiki-local-workflows/dist/index.js",
  ]) {
    mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
    writeFileSync(path.join(root, output), "built\n");
  }
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

  it("is true right after a build is recorded", () => {
    writeStamp(root);
    expect(isBuildFresh(root)).toBe(true);
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
    rmSync(path.join(root, "dist/cli.js"));
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
    writeFileSync(path.join(root, "dist/cli.js"), "rebuilt differently\n");
    expect(computeInputsHash(root)).toBe(before);
  });

  it("changes when source content changes", () => {
    const before = computeInputsHash(root);
    writeFileSync(path.join(root, "src/index.ts"), "export const a = 3;\n");
    expect(computeInputsHash(root)).not.toBe(before);
  });
});
