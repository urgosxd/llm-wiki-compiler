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
import { existsSync, readdirSync } from "node:fs";
import { TEST_ROOTS, classifyTests, partition, spawnsChildProcess } from "../scripts/test-partition.js";

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
    // The two shared fixtures that spawn on the caller's behalf. A file whose
    // only child-process construct is one of these imports is still a spawning
    // file: the spawn is real, it just lives one module away from the test.
    [
      "run-cli-server fixture import",
      'import { startViewerCLI } from "./fixtures/run-cli-server.js"',
    ],
    [
      "mcp-test-env fixture import",
      'import { connectMcpClient } from "./fixtures/mcp-test-env.js"',
    ],
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
    const suiteRoots = ["test", "packages", "scripts"];
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

  it("names only roots that exist on disk", () => {
    // The roots are read from the implementation rather than restated here on
    // purpose: this pin exists to catch a PHANTOM entry, and a phantom entry is
    // invisible to an oracle that keeps its own copy of the list. A root that
    // points at a directory the tree does not have contributes no files, so the
    // walk below returns fewer paths and the tier reports success over a tree it
    // never read — exactly what a source relocation leaves behind.
    const missing = TEST_ROOTS.filter((dir) => !existsSync(path.join(ROOT, dir)));
    expect(missing, `suite roots absent from the tree: ${missing.join(", ")}`).toEqual([]);
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
      // Spawns `node dist/api.js host --no-graph` once per case through
      // `fixtures/run-cli-server`, and its source names no child-process API of
      // its own — so it is the fixture-import rule this file exists to hold. It
      // was classified `unit` until the pattern list learned about the fixture.
      "test/viewer-server.test.ts",
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
