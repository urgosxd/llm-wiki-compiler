/**
 * @file Refuse a stale root `src` path in the scripts that walk it: a literal
 * that no longer resolves reports success over a tree it never read.
 *
 * The test-typecheck oracle lists the trees it inspects independently of the
 * tsconfig, and it guards each name with `existsSync`. That guard is what makes
 * a stale literal silent rather than loud: a name pointing at a directory the
 * relocation deleted simply stops contributing files, and the gate stays green
 * while covering less. So the literal itself is pinned.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("root src wiring", () => {
  it("keeps the test-typecheck oracle over every checked source tree", () => {
    const script = readFileSync("scripts/test-typecheck-program.ts", "utf8");
    expect(script).toContain('["packages/wiki/src", "test"]');
    expect(existsSync("src")).toBe(false);
  });
});
