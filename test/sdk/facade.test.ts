import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";
import { provisionEnvStack } from "../fixtures/env-stack.js";
import { useStackEnv } from "../fixtures/stack-env.js";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";

// The facade ingests, which writes a wiki page row, so it needs a real Stack.
// Provisioned per FILE, never shared -- see test/fixtures/env-stack.ts for why a
// persistent Stack makes ingest suites fail on the second run only.
const env = await provisionEnvStack("sdk-facade");

afterAll(async () => {
  await env.cleanup();
});

describe("createWiki facade (non-LLM)", () => {
  // Every dimension is Postgres-backed, so a Stack is required before any ingest.
  useStackEnv("facade");
  it.skipIf(!env.reachable)("ingests, lists seeded pages, exports — silently — under a normalized root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-sdk-"));
    // SEED THE ACTIVE BACKEND. A Stack makes pages ROWS, so writing
    // `wiki/concepts/a.md` would leave `listPages` reading an empty table and the
    // assertion would fail for a reason that has nothing to do with the facade.
    const handle = createDimensionsDatabase(process.env);
    try {
      await createPageWriteSink(handle.db, process.env.AKS_STACK_ID as string)({
        directory: "concepts", slug: "a", body: "---\ntitle: A\nsummary: s\n---\nbody",
      });
    } finally {
      await handle.close();
    }
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wiki = createWiki({ root });
    await wiki.ingestText({ title: "Note", text: "hello" });
    const { pages } = await wiki.listPages();
    const doc = await wiki.exportJson();
    expect((await readdir(path.join(root, "sources"))).length).toBe(1);
    expect(pages.map((p) => p.slug)).toContain("a");
    expect(doc.schemaVersion).toBe(1);
    expect(logSpy).not.toHaveBeenCalled(); // quiet by default
    expect(warnSpy).not.toHaveBeenCalled(); // note() routes to console.warn
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
