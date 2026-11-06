/**
 * @file CLI-level tests for `llmwiki race <from> <to>`.
 *
 * WHY THROUGH THE COMMAND. The traversal unit tests pin the algorithm; these
 * pin what a caller actually sees — the ordered route, the hop count, the exit
 * code, and the sentence that explains a failure on stderr. The unreachable
 * case is the one that matters most: S12 forbids a silent limit, so a wiki-race
 * that stops at its depth bound must SAY that the bound stopped it, otherwise a
 * reader concludes the destination is unreachable when it is only far away.
 *
 * Every case runs against its own throwaway wiki from `test/fixtures/temp-root.ts`,
 * so nothing here depends on the repository's own `wiki/`, and captures command
 * output through `test/fixtures/process-io.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import raceCommand from "../../src/commands/race.js";
import linksHereCommand from "../../src/commands/links-here.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { writePage } from "../fixtures/write-page.js";

/** Throwaway wiki for the current case: chdir'd into and removed afterwards. */
const ctx = useTempRoot();

/** Write one concept page into the throwaway wiki. */
async function page(slug: string, title: string, body: string): Promise<void> {
  await writePage(path.join(ctx.dir, "wiki/concepts"), slug, { title }, body);
}


/** alpha -> beta -> gamma: two hops, so a bound of one cannot reach gamma. */
async function writeChain(): Promise<void> {
  await page("alpha", "Alpha", "See [[beta]] for more.");
  await page("beta", "Beta", "See [[gamma]] for more.");
  await page("gamma", "Gamma", "The end of the chain.");
}

describe("race — human output", () => {
  it("prints the ordered route and the hop count", async () => {
    await writeChain();
    const io = captureProcessIo();
    const code = await raceCommand("alpha", "gamma", { maxDepth: 2 });
    expect(code).toBe(0);
    expect(io.out()).toBe(
      "2 hop(s) from concepts/alpha to concepts/gamma within --max-depth 2\n\n" +
        "  → concepts/alpha\n  → concepts/beta\n  → concepts/gamma\n",
    );
    expect(io.err()).toBe("");
  });

  it("prints the trivial zero-length route for a page against itself", async () => {
    await page("alpha", "Alpha", "Self.");
    const io = captureProcessIo();
    const code = await raceCommand("alpha", "alpha", {});
    expect(code).toBe(0);
    expect(io.out()).toContain("0 hop(s) from concepts/alpha to concepts/alpha");
    expect(io.out()).toContain("  → concepts/alpha");
  });

  it("is stable across repeated runs of the same wiki", async () => {
    await page("alpha", "Alpha", "Links to [[gamma]] and [[beta]].");
    await page("beta", "Beta", "Links to [[delta]].");
    await page("gamma", "Gamma", "Links to [[delta]].");
    await page("delta", "Delta", "Target.");
    const first = captureProcessIo();
    await raceCommand("alpha", "delta", {});
    const firstOut = first.out();
    vi.restoreAllMocks();
    const second = captureProcessIo();
    await raceCommand("alpha", "delta", {});
    expect(second.out()).toBe(firstOut);
    expect(firstOut).toContain("  → concepts/beta\n  → concepts/delta\n");
  });
});

describe("race — unreachable target", () => {
  it("fails with the depth bound named as the reason, and shows no route", async () => {
    await writeChain();
    const io = captureProcessIo();
    const code = await raceCommand("alpha", "gamma", { maxDepth: 1 });
    expect(code).toBe(1);
    expect(io.err()).toContain("--max-depth 1");
    expect(io.err()).toMatch(/depth bound/i);
    expect(io.err()).toContain("concepts/gamma");
    expect(io.out()).toBe("");
  });

  it("succeeds for the same pair once --max-depth is raised", async () => {
    await writeChain();
    const low = captureProcessIo();
    expect(await raceCommand("alpha", "gamma", { maxDepth: 1 })).toBe(1);
    vi.restoreAllMocks();
    const high = captureProcessIo();
    expect(await raceCommand("alpha", "gamma", { maxDepth: 2 })).toBe(0);
    expect(high.err()).toBe("");
    expect(high.out()).toContain("concepts/gamma");
    expect(low.err()).not.toBe("");
  });

  it("rejects a dangling link target as a destination", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const io = captureProcessIo();
    const code = await raceCommand("alpha", "nowhere", {});
    expect(code).toBe(2);
    expect(io.out()).toBe("");
    expect(io.err()).toContain('No page named "nowhere"');
  });
});

describe("race — arguments and envelope", () => {
  it("rejects an invalid --max-depth instead of guessing", async () => {
    await page("alpha", "Alpha", "See [[beta]].");
    await page("beta", "Beta", "Target.");
    const io = captureProcessIo();
    const code = await raceCommand("alpha", "beta", { maxDepth: -3 });
    expect(code).toBe(2);
    expect(io.err()).toContain("--max-depth");
  });

  it("emits the versioned envelope for a found route", async () => {
    await writeChain();
    const io = captureProcessIo();
    await raceCommand("alpha", "gamma", { maxDepth: 2, json: true });
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      requested: { from: "alpha", to: "gamma" },
      from: "concepts/alpha",
      to: "concepts/gamma",
      resolved: true,
      found: true,
      route: ["concepts/alpha", "concepts/beta", "concepts/gamma"],
      hops: 2,
      maxDepth: 2,
      requestedMaxDepth: 2,
      depthBoundReached: false,
      reason: null,
    });
  });

  it("emits the envelope for the bound-limited failure", async () => {
    await writeChain();
    const io = captureProcessIo();
    await raceCommand("alpha", "gamma", { maxDepth: 1, json: true });
    expect(JSON.parse(io.out())).toMatchObject({
      found: false,
      route: [],
      hops: 0,
      depthBoundReached: true,
      reason: "depth-bound",
    });
  });
});

describe("links-here — unchanged by the race navigation", () => {
  it("still reports the same inbound envelope", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("beta", "Beta", "Target.");
    const io = captureProcessIo();
    const code = await linksHereCommand("beta", { json: true });
    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      version: 1,
      target: "concepts/beta",
      requested: "beta",
      resolved: true,
      inboundCount: 1,
      inbound: [{ pageId: "concepts/alpha", title: "Alpha", mutual: false }],
    });
  });
});
