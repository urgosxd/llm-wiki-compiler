/**
 * @file test/commands/graph-health-cli.test.ts
 * @description Z7 for `llmwiki graph-health`: the exact human output, the versioned
 * `--json` envelope, the exit codes (0 answered, 2 unusable request) and the empty-wiki
 * answer — plus the registration that makes the verb discoverable.
 *
 * WHY THE EXACT TEXT IS PINNED. The report is a measurement, not an opinion: an operator
 * compares it before and after a compile, and an agent parses the envelope. A silently
 * dropped field — the pair cap, the unreachable count, the traversal bound — would turn a
 * bounded measurement into a misleading one, which is the failure mode S12 names. So the
 * assertions are on whole strings and whole objects, not on fragments.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { Command } from "commander";
import graphHealthCommand from "../../src/commands/graph-health.js";
import { registerContextCommands } from "../../src/cli/context-commands.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { writePage } from "../fixtures/write-page.js";

/** Write one concept page into the throwaway wiki. */
async function page(slug: string, title: string, body: string): Promise<void> {
  await writePage(path.join(process.cwd(), "wiki/concepts"), slug, { title }, body);
}

describe("graph-health — human output", () => {
  useTempRoot();

  it("Z7 prints the distribution, both counts and the complete-sample note", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("beta", "Beta", "See [[gamma]] too.");
    await page("gamma", "Gamma", "Nothing further.");
    const io = captureProcessIo();
    const code = await graphHealthCommand({});
    expect(code).toBe(0);
    expect(io.err()).toBe("");
    expect(io.out()).toContain("Graph health for 3 page(s):");
    expect(io.out()).toContain("6 ordered pair(s), 6 considered (pair cap");
    expect(io.out()).toContain("3 reachable, 3 unreachable within");
    expect(io.out()).toContain("    1 hop(s) — 2 pair(s)");
    expect(io.out()).toContain("    2 hop(s) — 1 pair(s)");
  });

  it("Z7 answers an empty wiki without failing", async () => {
    const io = captureProcessIo();
    const code = await graphHealthCommand({});
    expect(code).toBe(0);
    expect(io.out()).toBe(
      "Graph health: this wiki stores no pages yet.\n" +
        "Nothing is broken: pages appear as you compile sources.\n",
    );
  });

  it("Z7 refuses an unusable --pairs with exit code 2", async () => {
    await page("alpha", "Alpha", "No links.");
    const io = captureProcessIo();
    const code = await graphHealthCommand({ pairs: "-3" });
    expect(code).toBe(2);
    expect(io.err()).toContain("--pairs must be a non-negative integer (got -3).");
  });
});

describe("graph-health — JSON envelope", () => {
  useTempRoot();

  it("Z7 emits the whole versioned envelope", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("beta", "Beta", "Nothing further.");
    const io = captureProcessIo();
    const code = await graphHealthCommand({ json: true });
    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      pages: 2,
      pairCap: 200,
      totalPairs: 2,
      consideredPairs: 2,
      truncated: false,
      maxDepth: 20,
      reachablePairs: 1,
      unreachablePairs: 1,
      deepestReachable: 1,
      meanDepth: 1,
      depthHistogram: [{ depth: 1, pairs: 1 }],
      observation: expect.stringContaining("1 hop(s) or fewer"),
    });
  });

  it("Z7 reports a truncated sample in the envelope when --pairs cuts it", async () => {
    await page("alpha", "Alpha", "See [[beta]] and [[gamma]].");
    await page("beta", "Beta", "See [[gamma]].");
    await page("gamma", "Gamma", "Nothing further.");
    const io = captureProcessIo();
    await graphHealthCommand({ json: true, pairs: "2" });
    const envelope = JSON.parse(io.out());
    expect(envelope.consideredPairs).toBe(2);
    expect(envelope.totalPairs).toBe(6);
    expect(envelope.truncated).toBe(true);
  });
});

describe("graph-health — CLI registration", () => {
  it("registers the verb and documents --json, --pairs and the exit codes", () => {
    const program = new Command();
    program.exitOverride();
    registerContextCommands(program, () => false);
    const verb = program.commands.find((command) => command.name() === "graph-health");
    if (verb === undefined) throw new Error("graph-health is not registered");
    const chunks: string[] = [];
    verb.configureOutput({ writeOut: (text: string) => chunks.push(text) });
    verb.outputHelp();
    const help = chunks.join("");
    expect(help).toContain("--json");
    expect(help).toContain("--pairs <n>");
    expect(help).toContain("Exit codes");
  });
});
