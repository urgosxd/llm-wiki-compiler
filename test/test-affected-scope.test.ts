/**
 * @file Unit tests for the pre-push change-scope resolver.
 *
 * The hook decides how much of the suite to run on each push, so its two
 * failure modes both matter. Over-selecting wastes the time the hook exists to
 * save; under-selecting ships a broken push to CI with local confidence it never
 * earned. These tests pin the global fallbacks (which must never be skipped),
 * the narrowing path, and the "nothing to run" path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isGlobalScope,
  resolveAffectedScope,
  selectableFiles,
  type AffectedScope,
} from "../scripts/test-affected.js";

/** A throwaway repository, and the two operations a fixture needs to shape it. */
interface FixtureRepo {
  /** Run git here and return its trimmed stdout. */
  run: (args: readonly string[]) => string;
  /** Write a file, creating its parent directory. */
  write: (file: string, contents: string) => void;
}

/**
 * Build a synthetic repository, let a fixture fill it in, and resolve a scope from it.
 *
 * These cases run real `git`, so `scripts/test-partition.ts` classifies this file
 * into the integration tier by content. That is correct: the property under test IS
 * what git reports, and a stub of `merge-base` would pin the stub.
 *
 * @param build - Creates the history and remotes the case needs.
 * @returns The scope resolved in that repository.
 */
function inSyntheticRepo(build: (repo: FixtureRepo) => void): AffectedScope {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-"));
  const run = (args: readonly string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    run(["init", "-q", "-b", "main", "."]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    build({
      run,
      write: (file, contents) => {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), contents);
      },
    });
    return resolveAffectedScope(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Stage everything and commit it, so the fixture has a history to diff from. */
function commitAll(repo: FixtureRepo, message: string): void {
  repo.run(["add", "-A"]);
  repo.run(["commit", "-qm", message]);
}

/**
 * Give the fixture an `origin/main` that shares no ancestor with its base commit.
 *
 * The ref EXISTS and resolves, but `merge-base` fails against it: the case that
 * tells a resolvable ref apart from a computable change set.
 */
function addUnrelatedOriginMain(repo: FixtureRepo): void {
  repo.run(["checkout", "-q", "--orphan", "unrelated"]);
  repo.run(["commit", "-qm", "unrelated"]);
  repo.run(["update-ref", "refs/remotes/origin/main", repo.run(["rev-parse", "HEAD"])]);
  repo.run(["remote", "add", "origin", "."]);
  repo.run(["checkout", "-q", "main"]);
}

describe("isGlobalScope", () => {
  it.each([
    "package.json",
    "pnpm-lock.yaml",
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
    expect(["global", "files", "none", "unresolved"]).toContain(scope.kind);
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

/**
 * A failed computation is a refusal, never a true negative.
 *
 * `none` means "the computation succeeded and nothing relevant changed". When the
 * base ref cannot be resolved, or the history is unrelated so `merge-base` fails,
 * nothing was computed at all — and reporting that as `none` would be a clean
 * green run over a change set nobody ever looked at.
 */
describe("resolveAffectedScope when the change set cannot be computed", () => {
  it("reports `unresolved`, and not `none`, when no canonical base ref exists", () => {
    const scope = inSyntheticRepo((repo) => {
      repo.write("src/kept.ts", "export const a = 1;\n");
      commitAll(repo, "base");
      // No remote at all: neither origin/main nor upstream/main can be resolved.
    });
    expect(scope.kind, "an absent base ref must not degrade to a clean run").not.toBe("none");
    expect(scope.kind).toBe("unresolved");
  });

  it("reports `unresolved` when the base ref exists but the histories are unrelated", () => {
    const scope = inSyntheticRepo((repo) => {
      repo.write("src/kept.ts", "export const a = 1;\n");
      commitAll(repo, "base");
      addUnrelatedOriginMain(repo);
    });
    expect(scope.kind, "an unresolvable merge-base must not degrade to a clean run").not.toBe("none");
    expect(scope.kind).toBe("unresolved");
  });
});
