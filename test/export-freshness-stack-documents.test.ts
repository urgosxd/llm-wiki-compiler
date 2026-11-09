/**
 * @file test/export-freshness-stack-documents.test.ts
 * @description Every freshness consumer must judge the corpus the project
 * actually has — and a call site must not be able to forget which one that is.
 *
 * WHY THIS EXISTS
 *
 * `buildFreshnessSnapshot` took the Stack's documents as an OPTIONAL third
 * argument. A caller that omitted it silently fell back to hashing `sources/`,
 * where a Stack has nothing and whose keys are capability URLs — so every source
 * read as deleted and every owned page was classified `orphaned`.
 *
 * The omission shipped in two places and was nearly shipped in three more. The
 * worst is `collectExportPages`, which filters orphaned pages out: an export on a
 * healthy Stack dropped 233 of 387 pages with no error and no warning.
 *
 * `buildProjectFreshnessSnapshot` resolves the corpus itself, so the backend is a
 * property of the project rather than of the caller's memory. These tests pin the
 * delegation, because that is the whole fix: with a Stack listing present the
 * snapshot must use the ROWS, and with none it must keep hashing disk exactly as
 * before.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import * as seam from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { buildProjectFreshnessSnapshot } from "../packages/wiki/src/freshness/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "freshness-corpus-"));
  await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
  // One recorded owner, keyed by source IDENTITY — what a Stack stores, and what no
  // file under `sources/` can ever match.
  await writeFile(path.join(dir, ".llmwiki/state.json"), JSON.stringify({
    version: 1,
    indexHash: "",
    sources: {
      "https://example.test/doc": {
        hash: "recorded-hash",
        concepts: ["alpha"],
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Serve a Stack listing from the seam, as a configured Stack would. */
function withStackCorpus(documents: Array<{ sourceIdentity: string; contentHash: string }>) {
  return vi.spyOn(seam, "withSourceDocuments").mockImplementation(
    async (_env, fn) => await fn({ list: async () => documents }),
  );
}

describe("buildProjectFreshnessSnapshot", () => {
  it("judges availability against the Stack's documents when one is configured", async () => {
    withStackCorpus([{ sourceIdentity: "https://example.test/doc", contentHash: "recorded-hash" }]);

    const snapshot = await buildProjectFreshnessSnapshot(dir);

    // The identity exists in the corpus and its hash matches, so the owner is live.
    expect(snapshot.sources["https://example.test/doc"]?.exists).toBe(true);
    expect(snapshot.sources["https://example.test/doc"]?.currentHash).toBe("recorded-hash");
  });

  it("reports a document the Stack no longer holds as absent", async () => {
    withStackCorpus([]);

    const snapshot = await buildProjectFreshnessSnapshot(dir);

    // Absent from the corpus is a real fact about the rows, not a failed disk read.
    expect(snapshot.sources["https://example.test/doc"]?.exists).toBe(false);
  });

  it("falls back to hashing sources/ when no Stack is configured", async () => {
    vi.spyOn(seam, "withSourceDocuments").mockImplementation(async (_env, fn) => await fn(undefined));

    const snapshot = await buildProjectFreshnessSnapshot(dir);

    // No `sources/` file matches a capability URL, exactly as before this change.
    expect(snapshot.sources["https://example.test/doc"]?.exists).toBe(false);
  });
});
