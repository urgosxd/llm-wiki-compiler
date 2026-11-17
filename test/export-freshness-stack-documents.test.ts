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
 *
 * ## The corpus was threaded; the STATE was not, and that is the second half
 *
 * A snapshot is built from two reads: the compile STATE and the source corpus. Only
 * the corpus took the caller's `env`; the state was read with NO environment, so it
 * fell back to ambient `process.env` and the two halves of one snapshot could come
 * from different projects. The consequence was measured, not feared: a request that
 * named its Stack reported `AKS_DATABASE_URL is configured, so this run must have a
 * Stack, but no database handle was supplied to resolve it` — the corpus said "rows"
 * and the state read, handed no Stack at all, refused. Before that refusal existed the
 * same omission was worse, because it silently answered from the file backend while
 * the corpus came from rows (S5 of `odd/tasks/single-stack-authority.md`).
 *
 * The pin below is the two halves of one call against ONE root: the same file state and
 * the same Stack rows are both present, and only the caller's `env` differs. A snapshot
 * that reads rows when the env names a Stack and the file when the env names no
 * database can only produce these two answers if the env reaches BOTH reads.
 */
import "./fixtures/file-mode.js";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import * as seam from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { buildProjectFreshnessSnapshot } from "../packages/wiki/src/freshness/index.js";
import { writeWikiStateToRows } from "../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "./fixtures/kg-postgres.js";

/** The identity the file state records, and the only one a file read can report. */
const FILE_IDENTITY = "https://example.test/doc";

/** The identity the Stack's ROWS record — deliberately not the file's. */
const ROW_IDENTITY = "https://example.test/from-rows";

/** The named `file` mode: no database configured at all (S2), never a missing Stack. */
const NO_DATABASE_ENV = { AKS_DATABASE_URL: "" } as NodeJS.ProcessEnv;

/** The environment that names this Stack — precedence 1 of the one authority. */
function stackEnv(harness: KgPostgresHarness): NodeJS.ProcessEnv {
  return { AKS_DATABASE_URL: harness.url, AKS_STACK_ID: harness.stackId } as NodeJS.ProcessEnv;
}

/** The corpus this Stack holds, as the row-backed read answers it. */
const ROW_CORPUS = [{ sourceIdentity: ROW_IDENTITY, contentHash: "rows-hash" }];

/**
 * Seed one document and the compile record that refers to it.
 *
 * A document has to exist before its compile record can: `source_compile_state`
 * references `source_documents`, which is the real ordering (ingest, then compile).
 */
async function seedStackRows(harness: KgPostgresHarness): Promise<void> {
  await saveSourceDocument(harness.db, harness.stackId, {
    title: "Rows",
    document: `---\ntitle: Rows\n---\n${ROW_IDENTITY}`,
    source: ROW_IDENTITY,
  });
  await writeWikiStateToRows(harness.db, harness.stackId, {
    version: 1,
    indexHash: "",
    sources: {
      [ROW_IDENTITY]: {
        hash: "rows-hash",
        concepts: ["beta"],
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
}

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
      [FILE_IDENTITY]: {
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

/**
 * The caller's `env` reaches the STATE read, not only the corpus read.
 *
 * One root, one file state, one Stack with rows: both backends are available at once and
 * the only difference between the two calls is the environment the caller supplied. The
 * file mode half is the touched-behaviour pin — a run with no database at all is the
 * named `file` mode (S2), never a failure — and it stays green with the same strength as
 * the cases above.
 */
describe("buildProjectFreshnessSnapshot: the caller's env decides the state backend", () => {
  let harness: KgPostgresHarness;

  beforeEach(async () => {
    harness = await createKgPostgresHarness(`freshness-${randomUUID().slice(0, 8)}`);
    await seedStackRows(harness);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("reads the Stack's rows with a Stack-naming env, and the file with a database-less env", async () => {
    // Rows first: the env names a Stack, so BOTH reads — state and corpus — must be that
    // Stack's. The corpus is supplied, which is the shape `collectExportPages` uses when it
    // hands over a listing, so nothing here can mask a state read that went elsewhere.
    const fromStack = await buildProjectFreshnessSnapshot(dir, undefined, ROW_CORPUS, stackEnv(harness));

    expect(fromStack.stateStatus).toBe("ok");
    // Exactly the ROW state: had the state read kept using ambient `process.env`, this
    // would be the file's identity, which no Stack row records.
    expect(Object.keys(fromStack.sources)).toEqual([ROW_IDENTITY]);
    expect(fromStack.sources[ROW_IDENTITY]).toMatchObject({
      recordedHash: "rows-hash",
      currentHash: "rows-hash",
      exists: true,
      concepts: ["beta"],
    });

    // Then files, from the SAME root with the same rows still in place: an env that names
    // no database is the named `file` mode, and it reads the file state it always read.
    const fromFiles = await buildProjectFreshnessSnapshot(dir, undefined, undefined, NO_DATABASE_ENV);

    expect(fromFiles.stateStatus).toBe("ok");
    expect(Object.keys(fromFiles.sources)).toEqual([FILE_IDENTITY]);
    // No `sources/` file matches a capability URL, exactly as in file mode above.
    expect(fromFiles.sources[FILE_IDENTITY]?.exists).toBe(false);
  });
});
