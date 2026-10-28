import { describe, it, expect } from "vitest";

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestTextSource } from "../../src/commands/ingest.js";
import { useStackEnv } from "../fixtures/stack-env.js";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { listSourceDocuments } from "../../src/dimensions/wiki/source-documents-store.js";

/**
 * How many sources exist, read from whichever backend is active.
 *
 * On a Stack the corpus is rows, so `readdir("sources")` throws ENOENT for the
 * right reason and would prove nothing. The property under test is the IDENTITY
 * rule (same title+text collapses, different text coexists), not the storage --
 * so it is counted through the backend that actually holds the answer.
 */
async function countSources(root: string): Promise<number> {
  const stackId = process.env.AKS_STACK_ID;
  if (stackId === undefined) return (await readdir(path.join(root, "sources"))).length;
  const handle = createDimensionsDatabase(process.env);
  try {
    return (await listSourceDocuments(handle.db, stackId)).length;
  } finally {
    await handle.close();
  }
}

describe("ingestTextSource identity", () => {
  // Scoped here, not file-wide: this suite is the only one that ingests.
  useStackEnv("ingest-text-source");

  it("is idempotent for same title+text, coexists for same title+different text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-text-"));
    await ingestTextSource(root, { title: "Note", text: "alpha" });
    await ingestTextSource(root, { title: "Note", text: "alpha" }); // same → idempotent
    expect(await countSources(root)).toBe(1);
    await ingestTextSource(root, { title: "Note", text: "beta" });  // diff → coexist
    expect(await countSources(root)).toBe(2);
  });

  it("uses explicit source when provided", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-text-"));
    const result = await ingestTextSource(root, { title: "Note", text: "alpha", source: "manual:custom-id" });
    expect(result.source).toBe("manual:custom-id");
  });

  it("does not collide when the title/text boundary shifts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-text-"));
    await ingestTextSource(root, { title: "ab", text: "cde" });
    await ingestTextSource(root, { title: "abc", text: "de" });
    expect(await countSources(root)).toBe(2);
  });
});
