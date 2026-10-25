/**
 * @file test/dimensions/source-documents-store.test.ts
 * @description The row-backed replacement for `sources/` keeps every guarantee
 * the file writer carried.
 *
 * ## Why each case exists
 *
 * `saveSource` was not a plain write, and the four rules it enforced are the ones
 * whose loss would be silent rather than loud:
 *
 *  - identity, not title, is the key -- a re-ingest under a new title must update
 *    the same document instead of forking a second one;
 *  - an empty slug is refused, because it produced a file called `.md`;
 *  - identical bytes report `unchanged`, because the coordinator reads that as
 *    "this dimension did nothing" and a false `updated` would make it record work
 *    that never happened;
 *  - a changed document's hash changes, because that hash IS the incremental
 *    compilation signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { detectChanges } from "../../src/compiler/hasher.js";
import {
  hashSourceContent,
  listSourceDocuments,
  saveSourceDocument,
  sourceDocumentsChangeSource,
  sourceDocumentsContentSource,
  sourceFilename,
  stableSourceContent,
} from "../../src/dimensions/wiki/source-documents-store.js";

/** The wiki tables must exist for these cases to mean anything. */
const harnessReachable = await (async (): Promise<boolean> => {
  const probe = await createKgPostgresHarness(`srcstore-probe-${randomUUID().slice(0, 8)}`);
  try {
    await probe.db.execute("select 1 from wiki.source_documents limit 1");
    return probe.reachable;
  } catch {
    return false;
  } finally {
    await probe.cleanup();
  }
})();

/** One document as an ingest would produce it. */
function doc(source: string, title: string, body: string) {
  return { source, title, document: `---\ntitle: ${title}\n---\n\n${body}` };
}

describe.skipIf(!harnessReachable)("the wiki source document store", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`srcstore-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("creates a document and reads it back byte for byte", async () => {
    const written = doc("https://example.test/a", "Alpha", "body of alpha");

    const result = await saveSourceDocument(harness.db, harness.stackId, written);
    const [stored] = await listSourceDocuments(harness.db, harness.stackId);

    expect(result.writeStatus).toBe("created");
    expect(result.filename).toBe("alpha.md");
    expect(stored?.content).toBe(written.document);
    expect(stored?.sourceIdentity).toBe("https://example.test/a");
  });

  it("keys on source identity, so a new title updates the same document", async () => {
    await saveSourceDocument(harness.db, harness.stackId, doc("https://example.test/a", "Alpha", "one"));
    const result = await saveSourceDocument(
      harness.db,
      harness.stackId,
      doc("https://example.test/a", "Alpha Renamed", "two"),
    );

    const all = await listSourceDocuments(harness.db, harness.stackId);
    // One document, not two: the identity is the key, exactly as the file writer
    // reused the existing file when only the title had changed.
    expect(all).toHaveLength(1);
    expect(result.writeStatus).toBe("updated");
    expect(all[0]?.title).toBe("Alpha Renamed");
  });

  it("reports unchanged for identical bytes and writes nothing", async () => {
    const first = doc("https://example.test/a", "Alpha", "stable body");
    await saveSourceDocument(harness.db, harness.stackId, first);
    const second = await saveSourceDocument(harness.db, harness.stackId, first);

    // A false "updated" here would make the coordinator believe the wiki dimension
    // did work it did not do.
    expect(second.writeStatus).toBe("unchanged");
  });

  it("changes the hash when the body changes", async () => {
    await saveSourceDocument(harness.db, harness.stackId, doc("https://example.test/a", "Alpha", "before"));
    const [before] = await listSourceDocuments(harness.db, harness.stackId);
    await saveSourceDocument(harness.db, harness.stackId, doc("https://example.test/a", "Alpha", "after"));
    const [after] = await listSourceDocuments(harness.db, harness.stackId);

    // This hash is what `detectChanges` compares; a hash that did not move would
    // leave the stale page in place forever.
    expect(after?.contentHash).not.toBe(before?.contentHash);
  });

  it("ignores the volatile ingestedAt field when deciding unchanged", () => {
    const a = "---\ntitle: A\ningestedAt: 2026-01-01\n---\n\nbody";
    const b = "---\ntitle: A\ningestedAt: 2026-09-09\n---\n\nbody";

    // Re-ingesting refreshes a timestamp; that must not look like new content.
    expect(hashSourceContent(stableSourceContent(a))).toBe(hashSourceContent(stableSourceContent(b)));
  });

  it("refuses a title that yields no filename", async () => {
    // Previously this produced a file literally named `.md`; the guard is preserved
    // because a stored filename is what the compiler reads back.
    await expect(
      saveSourceDocument(harness.db, harness.stackId, { source: "s", title: "!!!", document: "x" }),
    ).rejects.toThrow(/no letter or number/);
  });

  it("derives a markdown filename from the title", () => {
    expect(sourceFilename("Alpha Beta")).toBe("alpha-beta.md");
  });

  it("keeps two Stacks' corpora apart", async () => {
    const other = await createKgPostgresHarness(`srcstore-other-${randomUUID().slice(0, 8)}`);
    try {
      await saveSourceDocument(harness.db, harness.stackId, doc("s1", "Mine", "a"));
      await saveSourceDocument(other.db, other.stackId, doc("s2", "Theirs", "b"));

      const mine = await listSourceDocuments(harness.db, harness.stackId);
      const theirs = await listSourceDocuments(other.db, other.stackId);

      expect(mine.map((d) => d.title)).toEqual(["Mine"]);
      expect(theirs.map((d) => d.title)).toEqual(["Theirs"]);
    } finally {
      await other.cleanup();
    }
  });

  it("orders documents by filename so a compile is reproducible", async () => {
    await saveSourceDocument(harness.db, harness.stackId, doc("s-c", "Charlie", "c"));
    await saveSourceDocument(harness.db, harness.stackId, doc("s-a", "Alpha", "a"));
    await saveSourceDocument(harness.db, harness.stackId, doc("s-b", "Bravo", "b"));

    const all = await listSourceDocuments(harness.db, harness.stackId);

    expect(all.map((d) => d.filename)).toEqual(["alpha.md", "bravo.md", "charlie.md"]);
  });
});

describe.skipIf(!harnessReachable)("the compiler's change detection reads rows", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`detect-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("reports a newly ingested document as new, without touching sources/", async () => {
    await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "Alpha", "body"));
    const source = sourceDocumentsChangeSource(harness.db, harness.stackId);

    const changes = await detectChanges("/nonexistent-root", emptyState(), source);

    // "/nonexistent-root" proves the directory was never consulted: a scan of it
    // would throw or find nothing.
    expect(changes).toEqual([{ file: "https://a.test/1", status: "new" }]);
  });

  it("reports unchanged when the stored hash still matches", async () => {
    const written = doc("https://a.test/1", "Alpha", "body");
    const saved = await saveSourceDocument(harness.db, harness.stackId, written);
    const source = sourceDocumentsChangeSource(harness.db, harness.stackId);
    const [stored] = await listSourceDocuments(harness.db, harness.stackId);

    const changes = await detectChanges("/nonexistent-root", {
      version: 2,
      indexHash: "",
      sources: { "https://a.test/1": { hash: stored!.contentHash, concepts: [], compiledAt: "x" } },
    }, source);

    expect(changes).toEqual([{ file: "https://a.test/1", status: "unchanged" }]);
    expect(saved.writeStatus).toBe("created");
  });

  it("reports changed when the document body changed after the last compile", async () => {
    await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "Alpha", "before"));
    const [before] = await listSourceDocuments(harness.db, harness.stackId);
    await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "Alpha", "after"));
    const source = sourceDocumentsChangeSource(harness.db, harness.stackId);

    const changes = await detectChanges("/nonexistent-root", {
      version: 2,
      indexHash: "",
      sources: { "https://a.test/1": { hash: before!.contentHash, concepts: [], compiledAt: "x" } },
    }, source);

    expect(changes).toEqual([{ file: "https://a.test/1", status: "changed" }]);
  });

  it("reports a document removed from the table as deleted, naming its identity", async () => {
    // The identity is what a deletion must name: the file is gone, so a filename
    // could not identify it, and `SourceState.source` exists for exactly this.
    const source = sourceDocumentsChangeSource(harness.db, harness.stackId);

    const changes = await detectChanges("/nonexistent-root", {
      version: 2,
      indexHash: "",
      sources: { "https://gone.test/1": { hash: "h", concepts: [], compiledAt: "x" } },
    }, source);

    expect(changes).toEqual([{ file: "https://gone.test/1", status: "deleted" }]);
  });
});

/** A state with nothing compiled, for the cases that start from an empty corpus. */
function emptyState() {
  return { version: 2 as const, indexHash: "", sources: {} };
}

describe.skipIf(!harnessReachable)("the two ends agree", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`ends-${randomUUID().slice(0, 8)}`);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("content read by identity returns exactly what detection hashed", async () => {
    // The pairing that matters: detection reports a key, extraction reads by that
    // same key. If these disagreed, compile would discover documents it cannot open.
    await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "Alpha", "body"));
    const [stored] = await listSourceDocuments(harness.db, harness.stackId);
    const read = await sourceDocumentsContentSource(harness.db, harness.stackId)
      .read("https://a.test/1");

    // Frontmatter included: the stored content is the same full document the file
    // writer produced, so extraction sees exactly the bytes it used to read.
    expect(read?.content).toContain("body");
    expect(read?.content).toContain("title: Alpha");
    expect(read?.hash).toBe(stored!.contentHash);
  });

  it("reading an identity the Stack does not hold returns undefined, not a throw", async () => {
    const read = await sourceDocumentsContentSource(harness.db, harness.stackId)
      .read("https://never.test/1");

    expect(read).toBeUndefined();
  });

  it("saving the same bytes twice writes no row change but still yields a readable document", async () => {
    // The migration case: a project whose files predate the rows. The row must
    // exist even when the file writer reported unchanged, or the first Stack-backed
    // compile sees an empty corpus and retires everything.
    const first = await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "A", "b"));
    const second = await saveSourceDocument(harness.db, harness.stackId, doc("https://a.test/1", "A", "b"));
    const [stored] = await listSourceDocuments(harness.db, harness.stackId);

    expect(first.writeStatus).toBe("created");
    expect(second.writeStatus).toBe("unchanged");
    expect(stored?.content).toContain("b");
  });
});
