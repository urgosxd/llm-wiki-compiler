/**
 * @file test/pnpm-migration-wiring.test.ts
 * @description Pins the npm -> pnpm workspaces migration so a later edit cannot
 * silently desync it while the suite stays green.
 *
 * The migration changed exactly one variable — the package manager — and its
 * whole claim is that nothing else moved: one lockfile, the same resolved
 * versions, the flat layout chosen on purpose rather than by accident, and no
 * delivery surface left invoking npm. Every one of those claims is silent when
 * it breaks. A dropped `workspaces` field, a `pnpm-workspace.yaml` drifting from
 * it, a lockfile regenerated against fresh ranges, a workflow that keeps
 * `npm ci` beside its pnpm steps, or a husky hook still calling `npm run`: none
 * of those fail a unit test, a typecheck, or a lint pass, and no local run
 * exercises CI. They fail as a dead pipeline or a different install graph than
 * the one the green suite was measured on, discovered after the fact.
 *
 * Reading the files is deliberate: `execFileSync("git", ...)` makes this an
 * integration-tier test by the repository's own classifier, which is where
 * assertions about tracked-file state belong.
 *
 * Spec: project brief phase 1 — packageManager, a single lockfile, the
 * documented `nodeLinker: hoisted` choice, the mirrored esbuild override, and
 * the removal of the stale nested vite-8 subtree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${REPO_ROOT}/${path}`, "utf8");
const pkg = JSON.parse(read("package.json")) as {
  packageManager?: string;
  workspaces?: string[];
  overrides?: Record<string, string>;
};
const workspace = load(read("pnpm-workspace.yaml")) as {
  packages?: string[];
  overrides?: Record<string, string>;
  nodeLinker?: string;
  allowBuilds?: Record<string, boolean>;
  onlyBuiltDependencies?: string[];
};
const lock = load(read("pnpm-lock.yaml")) as {
  lockfileVersion?: string;
  packages?: Record<string, unknown>;
  snapshots?: Record<string, unknown>;
};

/** name@version pairs, peer suffixes stripped, deduplicated across both sections. */
function lockPairs(): string[] {
  const strip = (key: string): string => {
    const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
    const name = key.slice(0, at);
    let depth = 0;
    let version = "";
    for (const char of key.slice(at + 1)) {
      if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (depth === 0) version += char;
    }
    return `${name}@${version.trim()}`;
  };
  const keys = [...Object.keys(lock.packages ?? {}), ...Object.keys(lock.snapshots ?? {})];
  return [...new Set(keys.map(strip))];
}

describe("pnpm migration wiring: one graph", () => {
  it("declares pnpm as the package manager and keeps the npm workspaces field", () => {
    expect(pkg.packageManager).toBe("pnpm@11.5.0");
    expect(pkg.workspaces).toEqual(["packages/llmwiki-core", "packages/llmwiki-kg/ts"]);
  });

  it("keeps pnpm-workspace.yaml in step with package.json workspaces", () => {
    expect(workspace.packages).toEqual(pkg.workspaces);
  });

  it("binds nodeLinker=hoisted and documents it as a deliberate temporary choice", () => {
    expect(workspace.nodeLinker).toBe("hoisted");
    const npmrc = read(".npmrc");
    expect(npmrc).toMatch(/^node-linker=hoisted$/m);
    expect(npmrc).toContain("DELIBERATE TEMPORARY CHOICE");
    expect(npmrc).toContain("phantom");
  });

  it("mirrors npm's esbuild override instead of inventing a pin", () => {
    expect(workspace.overrides?.esbuild).toBe("0.28.1");
    expect(pkg.overrides?.esbuild).toBe("0.28.1");
  });

  it("allows the build scripts npm used to run", () => {
    expect(workspace.allowBuilds?.esbuild).toBe(true);
    expect(workspace.onlyBuiltDependencies).toContain("esbuild");
  });

});

describe("pnpm migration wiring: one lockfile", () => {
  it("has one lockfile and no npm lockfiles left", () => {
    expect(lock.lockfileVersion).toBe("9.0");
    const tracked = execFileSync("git", ["ls-files", "*package-lock.json"], { cwd: REPO_ROOT });
    expect(tracked.toString().trim()).toBe("");
  });

  it("keeps exactly one vite version and no dead vite-8 subtree", () => {
    const pairs = lockPairs();
    expect(pairs.filter((pair) => pair.startsWith("vite@"))).toEqual(["vite@7.3.6"]);
    const esbuild = pairs.filter((pair) => pair === "esbuild@0.28.1" || pair.startsWith("@esbuild/"));
    expect(esbuild.length).toBeGreaterThan(0);
    expect(esbuild.every((pair) => pair.endsWith("@0.28.1"))).toBe(true);
    const ghost = pairs.filter((pair) => /^(@rolldown\/|@oxc-project\/|rolldown@|lightningcss)/.test(pair));
    expect(ghost).toEqual([]);
  });

});

describe("pnpm migration wiring: delivery surfaces stay on pnpm", () => {
  const WORKFLOWS = [
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
    ".github/workflows/typecheck-tests.yml",
    "packages/llmwiki-kg/.github/workflows/ci.yml",
  ].filter((path) => existsSync(`${REPO_ROOT}/${path}`));

  it("runs every CI workflow through pnpm/action-setup with pnpm cache and a frozen install", () => {
    expect(WORKFLOWS.length).toBe(4);
    for (const path of WORKFLOWS) {
      const text = read(path);
      expect(text).not.toMatch(/\bnpm ci\b/);
      expect(text).toMatch(/pnpm\/action-setup@v4/);
      expect(text.indexOf("pnpm/action-setup")).toBeLessThan(text.indexOf("actions/setup-node"));
      expect(text).toMatch(/cache:\s*pnpm/);
      expect(text).toContain("pnpm install --frozen-lockfile");
    }
  });

  it("leaves no npm invocation in the husky hooks", () => {
    for (const path of [".husky/pre-commit", ".husky/pre-push"]) {
      expect(read(path)).not.toMatch(/(?<!p)npm (ci|install|run)\b/);
    }
  });
});
