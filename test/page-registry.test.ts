/**
 * Tests for the live page registry: metadata-only id-set, lazy confined entry
 * with live hashes, and the confined-read loaders.
 *
 * Security invariant: the loaders NEVER read out-of-tree. Absent, forged, and
 * symlinked-escaping pageIds are all dropped before any bytes are read.
 *
 * Namespace resolution: typed entity namespaces resolve via the profile's
 * `entities[type].directory` (not a hardcoded `wiki/<namespace>`). Unknown
 * namespaces are dropped — never fall through to `wiki/<namespace>`.
 *
 * Eligibility parity: `buildLiveIdSet` applies the SAME embed-eligibility predicate
 * as the writer so orphaned/untitled/profile-invalid pages cannot resurrect from a
 * stale or forged v3 store (the prefilter drops their store entries).
 */

import { describe, it, expect } from "vitest";
import { writeFile, symlink } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { writePage } from "./fixtures/write-page.js";
import { splitIntoChunks, hashChunkText } from "../src/utils/retrieval.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import {
  buildLiveIdSet,
  buildLiveRegistryEntry,
  buildNamespaceDirs,
  loadPageRecordsByPageId,
  loadSelectedPagesByPageId,
} from "../src/utils/page-registry.js";
import type { ProfilePack, LoadedProfile } from "../src/profile/types.js";

// ---------------------------------------------------------------------------
// buildLiveIdSet — metadata-only (no body read)
// ---------------------------------------------------------------------------

describe("buildLiveIdSet", () => {
  it("returns qualified PageIds for concepts and queries without reading bodies", async () => {
    const root = await makeTempRoot("registry-ids");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "s" }, "body text");
    await writePage(path.join(root, "wiki/queries"), "beta", { title: "Beta", summary: "s" }, "body text");
    const ids = await buildLiveIdSet(root, ["concepts", "queries"]);
    expect(ids.has("concepts/alpha")).toBe(true);
    expect(ids.has("queries/beta")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("scans only the requested namespaces", async () => {
    const root = await makeTempRoot("registry-ids-ns");
    await writePage(path.join(root, "wiki/concepts"), "gamma", { title: "G", summary: "" }, "body");
    await writePage(path.join(root, "wiki/queries"), "delta", { title: "D", summary: "" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/gamma")).toBe(true);
    expect(ids.has("queries/delta")).toBe(false);
  });

  it("returns empty set when namespace directory is absent", async () => {
    const root = await makeTempRoot("registry-ids-empty");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.size).toBe(0);
  });

  // The eligibility gate below is NOT a profile feature: it is the legacy
  // concept/query rule that a page must be live (not orphaned) and titled to be
  // embedded, and it mirrors the WRITE gate in `readConfinedPageRecord`. These
  // three cases assert `buildLiveIdSet`'s side of it specifically; the
  // `embeddings-load` suite covers the retrieved-store side, so without them a
  // break confined to this function would pass every other test.
  it("excludes an orphaned concept (meta.orphaned:true) — matches writer which never embeds it", async () => {
    const root = await makeTempRoot("elig-orphaned");
    await writePage(path.join(root, "wiki/concepts"), "ghost", { title: "Ghost", orphaned: true }, "body");
    await writePage(path.join(root, "wiki/concepts"), "live", { title: "Live" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/ghost")).toBe(false);
    expect(ids.has("concepts/live")).toBe(true);
  });

  it("excludes an untitled concept — matches writer which never embeds it", async () => {
    const root = await makeTempRoot("elig-untitled");
    await writePage(path.join(root, "wiki/concepts"), "no-title", { summary: "s" }, "body");
    await writePage(path.join(root, "wiki/concepts"), "titled", { title: "Titled" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/no-title")).toBe(false);
    expect(ids.has("concepts/titled")).toBe(true);
  });

  it("regression: eligible concepts/queries are present; ineligible (orphaned) are absent — gate is applied", async () => {
    const root = await makeTempRoot("elig-regression-default");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "sum" }, "body");
    // An orphaned concept in the same namespace — the eligibility gate must exclude it
    await writePage(path.join(root, "wiki/concepts"), "dead", { title: "Dead", orphaned: true }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/alpha")).toBe(true);
    expect(ids.has("concepts/dead")).toBe(false);
    expect(ids.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildLiveRegistryEntry — lazy confined entry with live hashes
// ---------------------------------------------------------------------------

describe("buildLiveRegistryEntry", () => {
  it("returns entry with correct embeddingTextHash and chunkHashes for a real page", async () => {
    const root = await makeTempRoot("registry-entry");
    const body = "First paragraph.\n\nSecond paragraph.";
    await writePage(path.join(root, "wiki/concepts"), "mypage", { title: "My Page", summary: "A summary" }, body);
    const entry = await buildLiveRegistryEntry(root, "concepts/mypage");
    expect(entry).not.toBeNull();
    const expectedEmbText = buildEmbeddingText({ title: "My Page", summary: "A summary" });
    expect(entry!.embeddingTextHash).toBe(hashChunkText(expectedEmbText));
    const chunks = splitIntoChunks(body);
    expect(entry!.chunkHashes).toEqual(chunks.map(hashChunkText));
  });

  it("returns null for a non-live pageId", async () => {
    const root = await makeTempRoot("registry-entry-absent");
    const entry = await buildLiveRegistryEntry(root, "concepts/nonexistent");
    expect(entry).toBeNull();
  });

  it("drops a symlink-escaping page (returns null)", async () => {
    const root = await makeTempRoot("registry-entry-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "secret.md"), "---\ntitle: Evil\nsummary: s\n---\n\nevil body");
    const conceptsDir = path.join(root, "wiki/concepts");
    await symlink(path.join(outside, "secret.md"), path.join(conceptsDir, "secret.md"));
    const entry = await buildLiveRegistryEntry(root, "concepts/secret");
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadPageRecordsByPageId — confined read, drops absent/forged/escaping ids
// ---------------------------------------------------------------------------

describe("loadPageRecordsByPageId", () => {
  it("resolves a live pageId to its content via confined read", async () => {
    const root = await makeTempRoot("load-by-id");
    await writePage(path.join(root, "wiki/concepts"), "mypage", { title: "My Page", summary: "sum" }, "hello body");
    const records = await loadPageRecordsByPageId(root, ["concepts/mypage"]);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("My Page");
  });

  it("drops an absent pageId without error", async () => {
    const root = await makeTempRoot("load-absent");
    const records = await loadPageRecordsByPageId(root, ["papers/deleted"]);
    expect(records).toHaveLength(0);
  });

  it("drops a forged path-traversal id without reading out-of-tree", async () => {
    const root = await makeTempRoot("load-forged");
    // "../../etc/passwd" fails parseQualifiedPageId (dangerous chars)
    const records = await loadPageRecordsByPageId(root, ["../../etc/passwd"]);
    expect(records).toHaveLength(0);
  });

  it("drops a symlink-escaping page and never reads out-of-tree", async () => {
    const root = await makeTempRoot("load-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "evil.md"), "---\ntitle: Evil\nsummary: s\n---\n\nevil");
    const conceptsDir = path.join(root, "wiki/concepts");
    await symlink(path.join(outside, "evil.md"), path.join(conceptsDir, "evil.md"));
    const records = await loadPageRecordsByPageId(root, ["concepts/evil"]);
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSelectedPagesByPageId — same security surface as loadPageRecordsByPageId
// ---------------------------------------------------------------------------

describe("loadSelectedPagesByPageId", () => {
  it("resolves multiple live pageIds and returns their records", async () => {
    const root = await makeTempRoot("load-selected");
    await writePage(path.join(root, "wiki/concepts"), "a", { title: "A", summary: "sa" }, "body a");
    await writePage(path.join(root, "wiki/queries"), "b", { title: "B", summary: "sb" }, "body b");
    const records = await loadSelectedPagesByPageId(root, ["concepts/a", "queries/b"]);
    expect(records.map((r) => r.title).sort()).toEqual(["A", "B"]);
  });

  it("drops absent and invalid refs silently", async () => {
    const root = await makeTempRoot("load-selected-drop");
    await writePage(path.join(root, "wiki/concepts"), "real", { title: "Real", summary: "" }, "body");
    const records = await loadSelectedPagesByPageId(root, ["concepts/real", "concepts/ghost", "../../bad"]);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Real");
  });
});

// ---------------------------------------------------------------------------
// buildNamespaceDirs — typed entity directory resolution (the hardcode fix)
// ---------------------------------------------------------------------------

/** Minimal profile with `papers` at a standard dir and `research` at a custom dir. */
function typedProfile(papersDir: string): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "test",
    entities: {
      papers: { directory: papersDir },
      ideas: { directory: "wiki/ideas" },
    },
  };
}

describe("buildNamespaceDirs", () => {
  // The two typed-namespace cases this block used to carry — a declared directory
  // resolving to its own path, and an unknown namespace NOT falling back to
  // `wiki/<ns>` — are gone with the ability to declare an entity type. What is
  // left is the invariant they were protecting, now unconditionally true: exactly
  // the two reserved namespaces, at their canonical directories.
  it("resolves concepts/queries to the reserved dirs", () => {
    const dirs = buildNamespaceDirs();
    expect(dirs.get("concepts")).toBe("wiki/concepts");
    expect(dirs.get("queries")).toBe("wiki/queries");
  });

  it("returns nothing for an unknown namespace (no wiki/<ns> fallback)", () => {
    const dirs = buildNamespaceDirs();
    expect(dirs.get("unknown-ns")).toBeUndefined();
  });

  it("holds exactly the two reserved namespaces", () => {
    expect(buildNamespaceDirs().size).toBe(2);
  });
});
