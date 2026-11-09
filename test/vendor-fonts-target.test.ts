/**
 * @file Pin the vendoring target to the tree the build actually copies, so a
 * source relocation cannot leave `pnpm run vendor:fonts` writing into a
 * directory the build never reads.
 *
 * The script is not executed here on purpose: it writes into the checkout, and
 * a pin that mutates the tree to prove a path is not a pin a fast gate can run.
 * Reading the literal plus both existence facts is enough to fail by name the
 * moment either side of the contract moves.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("font vendoring target", () => {
  it("writes into the viewer assets the build copies from", () => {
    const script = readFileSync("scripts/vendor-fonts.mjs", "utf8");
    expect(script).toContain('path.join(projectRoot, "packages/wiki/src/viewer/assets/fonts")');
    expect(existsSync("packages/wiki/src/viewer/assets/fonts")).toBe(true);
    expect(existsSync("src")).toBe(false);
  });
});
