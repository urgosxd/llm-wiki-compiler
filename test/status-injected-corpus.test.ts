/**
 * @file test/status-injected-corpus.test.ts
 * @description A status call that is handed a corpus must judge EVERYTHING by it.
 *
 * WHY THIS EXISTS
 *
 * `collectStatus` accepts `sourceDocuments` as an option, and the MCP `wiki_status`
 * tool passes the real listing it resolved from the Stack. That listing must reach
 * the pending-change list AND the freshness snapshot, because they answer questions
 * about one corpus.
 *
 * When the freshness helper started resolving its own corpus from ambient
 * `process.env`, it silently stopped honouring the injected one. Both halves then
 * read different sources: on a machine with no `AKS_STACK_ID`, a page whose owner
 * sat in the injected listing was classified `orphaned` — a live page reported as
 * having lost all its evidence.
 *
 * The helper still owns the default (resolve it when nothing is supplied), so no
 * call site can forget. What this pins is that an explicit corpus wins, which is
 * the path the status tests and the MCP tool actually drive.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectStatus } from "../src/status/collect.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A project whose single page is owned by one source IDENTITY, as a Stack stores it. */
async function projectWithOwnedPage(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "status-corpus-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts/alpha.md"), "---\ntitle: Alpha\nsummary: s\n---\n\nBody.\n");
  await writeFile(path.join(root, ".llmwiki/state.json"), JSON.stringify({
    version: 1,
    indexHash: "",
    sources: {
      "https://x.test/doc": { hash: "h", concepts: ["alpha"], compiledAt: "2026-01-01T00:00:00.000Z" },
    },
  }));
  return root;
}

/** The listing a Stack would hand over: the identity is present with a matching hash. */
const liveListing = {
  list: async () => [{ sourceIdentity: "https://x.test/doc", contentHash: "h" }],
};

describe("collectStatus with an injected corpus", () => {
  it("classifies an owned page from the injected listing, not from ambient env", async () => {
    dir = await projectWithOwnedPage();

    // No Stack in the environment: only the injected listing knows the source.
    const status = await collectStatus(dir, { sourceDocuments: liveListing });

    expect(status.orphanedCount).toBe(0);
    expect(status.staleCount).toBe(0);
  });

  it("still reports the page as orphaned when the injected corpus lacks its owner", async () => {
    dir = await projectWithOwnedPage();

    const status = await collectStatus(dir, { sourceDocuments: { list: async () => [] } });

    // The corpus is authoritative: absent from it means the evidence is gone.
    expect(status.orphanedCount).toBe(1);
  });
});
