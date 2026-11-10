/**
 * @file test/manifest-dependencies-grammar.test.ts
 * @description The grammar under the packed-manifest guard, asserted on its own.
 *
 * The guard's assertions are only as strong as the predicate beneath them:
 * `findUninstallableDependencies(...)` returning `[]` proves nothing if the
 * predicate accepts everything, and it proves nothing about scope if it is ever
 * pointed at the whole manifest. So this file pins the predicate's accept/reject
 * decision directly, and pins WHY the subject is `dependencies`.
 *
 * Spec: S1-S3 of `odd/tasks/packed-manifest-guard.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PROTOCOL_PREFIX,
  findDependenciesByProtocol,
  findUninstallableDependencies,
  isConsumerInstallable,
} from "./fixtures/manifest-dependencies.js";

/** Repository root from this file's own location, never from `process.cwd()`. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** The little of a root manifest this test reads. */
interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const ROOT = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;

/** Ranges a consumer's installer resolves from a registry, or fetches as a URL. */
const INSTALLABLE: readonly string[] = [
  "1.4.0-dev.20260919",
  "^0.3.163",
  "~1.2.3",
  ">=1 <2",
  ">=1.0.0 <2.0.0 || ^3",
  "*",
  "1.x",
  "https://example.test/t.tgz",
  "git+https://example.test/r.git",
  "github:o/r",
  "npm:pkg@^1",
];

/** Ranges that name this workspace or this filesystem, which no embedder can resolve. */
const LOCAL: readonly string[] = [
  "workspace:*",
  "workspace:^1.0.0",
  "file:../x",
  "file:packages/x",
  "link:../x",
  "portal:../x",
];

describe("manifest-dependencies grammar: what a consumer's installer can resolve", () => {
  it("rejects every local protocol, including the workspace one the guard names", () => {
    expect(LOCAL.filter((range) => isConsumerInstallable(range))).toEqual([]);
  });

  it("accepts every registry range and fetchable URL, so the positive half is not a copy of the negative half", () => {
    expect(INSTALLABLE.filter((range) => !isConsumerInstallable(range))).toEqual([]);
  });

  it("reports the offending entry by name instead of a bare boolean", () => {
    expect(findUninstallableDependencies({ a: "workspace:*", b: "^1.2.3", c: "file:../x", d: "*" })).toEqual([
      { name: "a", range: "workspace:*" },
      { name: "c", range: "file:../x" },
    ]);
    expect(findDependenciesByProtocol({ a: "^1.2.3", c: "WORKSPACE:^1" }, [WORKSPACE_PROTOCOL_PREFIX])).toEqual([
      { name: "c", range: "WORKSPACE:^1" },
    ]);
  });

  it("holds today's root dependencies installable, which is the guard's subject", () => {
    expect(Object.keys(ROOT.dependencies ?? {}).length).toBeGreaterThan(0);
    expect(findUninstallableDependencies(ROOT.dependencies)).toEqual([]);
    expect(findDependenciesByProtocol(ROOT.dependencies, [WORKSPACE_PROTOCOL_PREFIX])).toEqual([]);
  });

  it("shows the same predicate would go RED on devDependencies, so the scope is load-bearing", () => {
    expect(findDependenciesByProtocol(ROOT.devDependencies, [WORKSPACE_PROTOCOL_PREFIX])).not.toEqual([]);
    expect(findUninstallableDependencies(ROOT.devDependencies)).not.toEqual([]);
  });
});
