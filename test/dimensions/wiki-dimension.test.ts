/**
 * @file test/dimensions/wiki-dimension.test.ts
 * @description The wiki dimension writes through `saveSource` and rolls back
 * through the compiler's existing intent journal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWikiDimension } from "../../src/dimensions/wiki.js";
import type { DimensionInput } from "../../src/dimensions/types.js";

/** Minimal document for one source. */
function input(body: string, title = "Doc"): DimensionInput {
  return {
    source: "https://example.test/doc",
    title,
    document: `---\ntitle: ${title}\nsource: https://example.test/doc\n---\n\n${body}\n`,
    body,
  };
}

describe("wiki dimension", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-wiki-dim-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the source and reports a created status", async () => {
    const wiki = createWikiDimension(root);

    const prepared = await wiki.prepare(input("hello"));
    const committed = await wiki.commit(prepared);

    expect(committed.summary).toBe("wiki:created");
    const files = await readdir(path.join(root, "sources"));
    expect(files).toHaveLength(1);
    expect(await readFile(path.join(root, "sources", files[0]!), "utf-8")).toContain("hello");
  });

  it("discards a new source, leaving sources/ empty", async () => {
    const wiki = createWikiDimension(root);

    const prepared = await wiki.prepare(input("hello"));
    await wiki.discard(prepared);

    const sourcesDir = path.join(root, "sources");
    const files = existsSync(sourcesDir) ? await readdir(sourcesDir) : [];
    expect(files).toHaveLength(0);
  });

  it("discards an update, restoring the previous bytes", async () => {
    const wiki = createWikiDimension(root);
    const first = await wiki.prepare(input("original"));
    await wiki.commit(first);

    const second = await wiki.prepare(input("replacement"));
    await wiki.discard(second);

    const files = await readdir(path.join(root, "sources"));
    const restored = await readFile(path.join(root, "sources", files[0]!), "utf-8");
    expect(restored).toContain("original");
    expect(restored).not.toContain("replacement");
  });

  it("reports unchanged when the same content is ingested twice", async () => {
    const wiki = createWikiDimension(root);
    const first = await wiki.prepare(input("same"));
    await wiki.commit(first);

    const second = await wiki.prepare(input("same"));

    expect(second.unchanged).toBe(true);
  });

  it("uses a content-derived idempotency key", async () => {
    const wiki = createWikiDimension(root);
    const prepared = await wiki.prepare(input("keyed"));

    const committed = await wiki.commit(prepared);

    expect(committed.idempotencyKey).toMatch(/^wiki:[0-9a-f]{32}$/);
  });

  it("leaves no journal behind after commit", async () => {
    const wiki = createWikiDimension(root);
    const prepared = await wiki.prepare(input("clean"));
    await wiki.commit(prepared);

    const journalDir = path.join(root, ".llmwiki", "journal");
    const entries = existsSync(journalDir) ? await readdir(journalDir) : [];
    expect(entries).toHaveLength(0);
  });

  it("keeps an existing unrelated source untouched on discard", async () => {
    const wiki = createWikiDimension(root);
    await writeFile(path.join(root, "keep.txt"), "keep", "utf-8");
    const prepared = await wiki.prepare(input("new"));

    await wiki.discard(prepared);

    expect(await readFile(path.join(root, "keep.txt"), "utf-8")).toBe("keep");
  });
});
