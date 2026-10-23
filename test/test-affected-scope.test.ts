/**
 * @file Unit tests for the pre-push change-scope resolver.
 *
 * The hook decides how much of the suite to run on each push, so its two
 * failure modes both matter. Over-selecting wastes the time the hook exists to
 * save; under-selecting ships a broken push to CI with local confidence it never
 * earned. These tests pin the global fallbacks (which must never be skipped),
 * the narrowing path, and the "nothing to run" path.
 */

import { describe, expect, it } from "vitest";
import {
  isGlobalScope,
  resolveAffectedScope,
  selectableFiles,
} from "../scripts/test-affected.js";

describe("isGlobalScope", () => {
  it.each([
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "tsconfig.json",
    "tsconfig.test.json",
    "scripts/test-partition.ts",
  ])("treats %s as suite-wide", (file) => {
    expect(isGlobalScope(file)).toBe(true);
  });

  it.each([
    "src/utils/constants.ts",
    "src/compiler/prompts.ts",
    "test/context-graph.test.ts",
    "docs/cli/compile.mdx",
    "src/scripts-adjacent.ts",
  ])("does not treat %s as suite-wide", (file) => {
    expect(isGlobalScope(file)).toBe(false);
  });
});

describe("selectableFiles", () => {
  it("keeps source and test files", () => {
    expect(selectableFiles(["src/a.ts", "test/b.test.ts"])).toEqual(["src/a.ts", "test/b.test.ts"]);
  });

  it("drops paths that cannot select a test", () => {
    expect(selectableFiles(["README.md", "docs/x.mdx", "data.json"])).toEqual([]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(selectableFiles(["b.ts", "a.ts", "b.ts"])).toEqual(["b.ts", "a.ts"]);
  });
});

describe("resolveAffectedScope", () => {
  it("returns a scope object with a recognised kind", () => {
    const scope = resolveAffectedScope(process.cwd());
    expect(["global", "files", "none"]).toContain(scope.kind);
  });

  it("never returns an empty file selection", () => {
    const scope = resolveAffectedScope(process.cwd());
    if (scope.kind === "files") expect(scope.files.length).toBeGreaterThan(0);
  });

  it("explains a global fallback instead of failing silently", () => {
    const scope = resolveAffectedScope(process.cwd());
    if (scope.kind === "global") expect(scope.reason.length).toBeGreaterThan(0);
  });
});

describe("resolveAffectedScope in a synthetic repository", () => {
  it("detects an untracked new source file that git diff alone would miss", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "scope-"));
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    try {
      run(["init", "-q", "."]);
      run(["config", "user.email", "t@t"]);
      run(["config", "user.name", "t"]);
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src/kept.ts"), "export const a = 1;\n");
      writeFileSync(path.join(dir, "package.json"), "{}\n");
      run(["add", "-A"]);
      run(["commit", "-qm", "base"]);
      run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
      run(["remote", "add", "origin", dir]);
      // Untracked: `git diff --name-only HEAD` reports nothing for this.
      writeFileSync(path.join(dir, "src/added.ts"), "export const b = 1;\n");
      const scope = resolveAffectedScope(dir);
      expect(scope.kind).toBe("files");
      if (scope.kind === "files") expect(scope.files).toContain("src/added.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
