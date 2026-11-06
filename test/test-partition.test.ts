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
import { readdirSync } from "node:fs";
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
    // STRONGER than the single-directory count this replaces. The classifier
    // now walks several roots, so the expectation walks those roots ITSELF
    // rather than letting `test/` stand in for the whole suite — a tree added
    // later must fail here by name instead of being silently agreed with. The
    // root list and skip list are duplicated on purpose: an oracle that imports
    // the constant it checks cannot catch a missing entry in it.
    const suiteRoots = ["test", "packages", "src", "scripts"];
    const skipped = new Set(["node_modules", "dist", ".worktrees", ".claude", ".git", ".llmwiki"]);
    const onDisk = suiteRoots.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { recursive: true })
        .filter((entry) => typeof entry === "string" && entry.endsWith(".test.ts"))
        .map((entry) => `${dir}/${entry.split(path.sep).join("/")}`)
        .filter((entry) => !entry.split("/").some((segment) => skipped.has(segment))),
    );
    const classifiedByPath = new Set(classified.map((entry) => entry.file));
    const unclassified = onDisk.filter((file) => !classifiedByPath.has(file));
    const fabricated = [...classifiedByPath].filter((file) => !onDisk.includes(file));
    expect(unclassified, `on disk but not classified: ${unclassified.join(", ")}`).toEqual([]);
    expect(fabricated, `classified but not on disk: ${fabricated.join(", ")}`).toEqual([]);
    expect(classified.length, "classified files vs files on disk").toBe(onDisk.length);
  });

  it("splits the suite with no file lost and no file duplicated", () => {
    const { unit, integration } = partition(classified);
    expect(unit.length + integration.length).toBe(classified.length);
    const union = new Set([...unit, ...integration]);
    expect(union.size).toBe(classified.length);
  });

  it("puts known spawn-heavy suites in the integration tier", () => {
    const { integration } = partition(classified);
    // Both entries used to name suites the purge removed (`products/product-cli`,
    // `workflow-submit-cli`). Repointed at suites that still spawn a child and are
    // still classified integration, so this keeps asserting the behaviour and not
    // just the absence of crashes.
    const known = [
      "test/context-integration.test.ts",
      "test/activity-log-integration.test.ts",
      // Spawns the built `node dist/cli.js` through `runCLI`, so it must never fall
      // into the fast unit loop; if the classifier stops matching `runCLI(`, this
      // fails by name instead of the parity signal being skipped without a trace.
      "test/parity-default.test.ts",
    ];
    // Filtered instead of asserted per entry: `toContain` reports only the first
    // file that fell out of the tier, which hides the rest of the regression.
    const lost = known.filter((file) => !integration.includes(file));
    expect(lost).toEqual([]);
  });

  it("puts pure unit suites in the fast tier", () => {
    const { unit } = partition(classified);
    expect(unit).toContain("test/context-links-here.test.ts");
    expect(unit).toContain("test/context-graph.test.ts");
  });

  it("keeps every entry a repo-relative .test.ts path", () => {
    // Anchored to the enumerated roots rather than to `test/` alone: an entry
    // from anywhere else is either a fabricated path or a root nobody declared.
    for (const entry of classified) {
      expect(entry.file).toMatch(/^(test|packages|src|scripts)\/.*\.test\.ts$/);
      expect(entry.file.startsWith("/")).toBe(false);
    }
  });
});
