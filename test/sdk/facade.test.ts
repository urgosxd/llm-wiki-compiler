import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";
import { provisionEnvStack } from "../fixtures/env-stack.js";

// The facade ingests, which writes a wiki page row, so it needs a real Stack.
// Provisioned per FILE, never shared -- see test/fixtures/env-stack.ts for why a
// persistent Stack makes ingest suites fail on the second run only.
const env = await provisionEnvStack("sdk-facade");

afterAll(async () => {
  await env.cleanup();
});

describe("createWiki facade (non-LLM)", () => {
  it.skipIf(!env.reachable)("ingests, lists seeded pages, exports — silently — under a normalized root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-sdk-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/a.md"), "---\ntitle: A\nsummary: s\n---\nbody", "utf-8");
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
