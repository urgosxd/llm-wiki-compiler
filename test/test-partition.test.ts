/**
 * @file Unit tests for the test-suite partitioner.
 *
 * The partition decides what a developer's fast loop actually covers, so a
 * misclassification silently turns `test:unit` into a lie: a spawn test landing
 * in the fast tier reintroduces the 13.7s average, and a pure unit test landing
 * in the integration tier makes the loop skip real coverage. These tests pin
 * both directions plus the property that matters most — every test file lands in
 * exactly one tier.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { classifyTests, partition, spawnsChildProcess } from "../scripts/test-partition.js";

const ROOT = path.resolve(".");

describe("spawnsChildProcess", () => {
  it.each([
    ["runCLI call", 'await runCLI(["lint"], cwd)'],
    ["execFileSync", 'execFileSync(process.execPath, [])'],
    ["spawnSync", 'spawnSync("node", [])'],
    ["bare spawn", 'spawn("node", [])'],
    ["execFile", 'await execFile("node", [])'],
    ["npm pack", 'await run("npm pack")'],
    ["cli-runner helper import", 'import { exec } from "./fixtures/cli-runner.js"'],
  ])("detects %s", (_label, source) => {
    expect(spawnsChildProcess(source)).toBe(true);
  });

  it.each([
    ["regex exec", "const m = pattern.exec(line);"],
    ["plain describe/it", 'describe("x", () => { it("y", () => {}) })'],
    ["prose mention of spawn", "// this test does not spawn a process"],
  ])("does not flag %s", (_label, source) => {
    expect(spawnsChildProcess(source)).toBe(false);
  });
});

describe("classifyTests", () => {
  const classified = classifyTests(ROOT);

  it("classifies every test file in the suite", () => {
    expect(classified.length).toBeGreaterThan(1000);
  });

  it("splits the suite with no file lost and no file duplicated", () => {
    const { unit, integration } = partition(classified);
    expect(unit.length + integration.length).toBe(classified.length);
    const union = new Set([...unit, ...integration]);
    expect(union.size).toBe(classified.length);
  });

  it("puts known spawn-heavy suites in the integration tier", () => {
    const { integration } = partition(classified);
    const known = [
      "test/context-integration.test.ts",
      "test/workflow-submit-cli.test.ts",
      "test/products/product-cli.test.ts",
    ];
    for (const file of known) expect(integration).toContain(file);
  });

  it("puts pure unit suites in the fast tier", () => {
    const { unit } = partition(classified);
    expect(unit).toContain("test/context-links-here.test.ts");
    expect(unit).toContain("test/context-graph.test.ts");
  });

  it("keeps every entry a repo-relative .test.ts path", () => {
    for (const entry of classified) {
      expect(entry.file).toMatch(/^test\/.*\.test\.ts$/);
      expect(entry.file.startsWith("/")).toBe(false);
    }
  });
});
