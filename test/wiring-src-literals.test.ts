/**
 * @file Pin the reviewed scope of the test type-check gate, so a root removed
 * from `tsconfig.test.json` fails instead of narrowing the gate silently.
 *
 * The gate in `scripts/test-typecheck-program.ts` no longer carries its own list
 * of source trees. It reads `include` out of the configuration it is supposed to
 * police, expands every entry against the disk and refuses any file TypeScript's
 * own globs left out — which is what caught the nine `packages/api/src` test files
 * that had re-entered `include` while a hand-maintained literal still named only
 * `packages/wiki/src` and `test`.
 *
 * That derivation cannot see a root REMOVED from `include`, because a removed
 * root disappears from the expectation too: the gate would narrow and stay green,
 * exactly as it did before. So the reviewed root set is pinned here, asserted
 * against the derived one in both directions. A deliberate change to the scope is
 * a reviewed change to this file; a silent one fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredSourceRoots } from "../scripts/test-typecheck-program.js";

/** The source roots the test type-check gate is reviewed to check, sorted. */
const REVIEWED_SOURCE_ROOTS = [
  "packages/api/src",
  "packages/llmwiki-kg/ts/src",
  "packages/wiki/src",
  "scripts",
  "test",
];

/** The `include` array the committed test configuration declares. */
function committedInclude(): string[] {
  const config = JSON.parse(readFileSync("tsconfig.test.json", "utf8")) as { include?: string[] };
  return config.include ?? [];
}

/** The reviewed roots an `include` array fails to declare, as the gate would report them. */
function undeclaredRoots(include: readonly string[]): string[] {
  const declared = declaredSourceRoots(process.cwd(), include);
  return REVIEWED_SOURCE_ROOTS.filter((root) => !declared.includes(root));
}

describe("test type-check scope", () => {
  it("derives exactly the reviewed roots from the committed include", () => {
    expect(declaredSourceRoots(process.cwd(), committedInclude())).toEqual(REVIEWED_SOURCE_ROOTS);
    expect(undeclaredRoots(committedInclude())).toEqual([]);
  });

  it("names the root a narrowed include drops", () => {
    const include = committedInclude();
    const narrowed = include.filter((entry) => !entry.startsWith("packages/api/src/"));
    expect(narrowed).toHaveLength(include.length - 1);
    expect(undeclaredRoots(narrowed)).toEqual(["packages/api/src"]);
    expect(declaredSourceRoots(process.cwd(), narrowed)).not.toEqual(REVIEWED_SOURCE_ROOTS);
  });

  it("keeps every reviewed root on disk, so no declared root is skipped", () => {
    for (const root of REVIEWED_SOURCE_ROOTS) expect(existsSync(root)).toBe(true);
  });

  it("fails closed on an empty or unparseable include", () => {
    expect(() => declaredSourceRoots(process.cwd(), [])).toThrow(/include/u);
    expect(() => declaredSourceRoots(process.cwd(), "test/**/*")).toThrow(/include/u);
    expect(() => declaredSourceRoots(process.cwd(), ["**/*"])).toThrow(/include/u);
  });
});
