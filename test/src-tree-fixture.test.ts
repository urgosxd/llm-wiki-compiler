/**
 * @file test/src-tree-fixture.test.ts
 * @description Pins the src/ tree walker to the directory that actually exists.
 *
 * WHY THIS TEST EXISTS. The walker used to resolve `../../src`, the root tree the
 * package split moved into `packages/wiki/`. When a walker points at a directory
 * that is gone, `readdirSync` throws only if someone imports it — and a *scan* of a
 * moved tree that returns nothing is indistinguishable from a clean tree. Nothing
 * imported this fixture yet, so the stale path was a false green waiting to be
 * wired. These assertions make the drift fail here instead of silently later.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_DIR, srcTsFiles } from "./fixtures/src-tree.js";

describe("src-tree fixture", () => {
  it("resolves SRC_DIR at the relocated wiki package, which exists", () => {
    expect(SRC_DIR.split(path.sep).slice(-3).join("/"), "SRC_DIR must point at the relocated tree, not the deleted root src/").toBe(
      "packages/wiki/src",
    );
    expect(existsSync(SRC_DIR), `${SRC_DIR} is missing — the source tree moved again`).toBe(true);
  });

  it("walks a populated tree instead of reporting zero files", () => {
    const files = srcTsFiles();
    expect(files.length, "a walker over a moved tree returns nothing and reads like a clean scan").toBeGreaterThan(0);
    expect(files).toContain("index.ts");
    expect(files.every((file) => /\.(?:ts|js)$/.test(file))).toBe(true);
  });
});
