/**
 * @file test/dimensions/kg-ingest-item2.test.ts
 * @description Item 2 of `odd/tasks/kg-ingest-speed-only.md` (T4 and T5): a re-ingest must
 * not pay to extract chunks it has already extracted, and the skip must be visible in the
 * per-document summary so a reused chunk can never read as a failed one.
 *
 * ## Why both directions are pinned here, and why the fixture is borrowed
 *
 * S5 names the two ways a hash ledger can lie, and one test per way is the only proof that
 * they do not: the SAME content must skip (or nothing was saved), and one changed character
 * must re-extract the chunk it landed in (or a stale extraction is served as fresh, which is
 * a correctness bug rather than a slow run). Both directions run against the item-1 fixture
 * document -- a sentence repeated past the 1024-token budget -- because S7 fixes one document
 * per before/after comparison and a second fixture would measure a different program.
 *
 * ## The two harnesses, and what each one is allowed to say
 *
 * `measureKgIngest` drives the PRODUCTION entry (`ingestTextSource`, both dimensions, the
 * mutation lock), so it is the only harness whose numbers describe what a user pays for. It
 * derives the source identity from a digest of title and text, which makes it exactly right
 * for the unchanged re-ingest (same digest, same source, same ledger key) and exactly wrong
 * for the changed-character case (a new digest is a new source, so nothing could be reused).
 * That second case therefore drives `createKgDimension` directly, with the source identity
 * stated explicitly, and the summary is read from `commit` -- the ONE per-document signal a
 * caller sees.
 *
 * ## Why nothing here imports `@repo/kg`
 *
 * The `wiki -> kg` ratchet counts `test/**`, and `scripts/lint-ratchet.ts` accepts no new
 * allowance for a file whose rules have not moved. Activity is therefore counted at the
 * wire, by the same `fetch` stub item 1 introduced, and the ledger is read as plugin SQL --
 * never through a KG symbol.
 *
 * ## What the real database is for
 *
 * The ledger the skip reads lives in Postgres, so a mocked store would prove that the mock
 * skips. The suite is guarded by the house database-skip pattern and never sets
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE`, exactly as its siblings are.
 */

import "./kg-runtime-provider-env.js";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  DIMENSIONS_ENV_VAR,
} from "../../packages/wiki/src/dimensions/activation.js";
import {
  createLedgerReader,
  type ExtractedChunkHashesReader,
} from "../../packages/wiki/src/dimensions/kg/chunk-reuse.js";
import { createKgDimension } from "../../packages/wiki/src/dimensions/kg/index.js";
import type { Dimension, DimensionInput } from "../../packages/wiki/src/dimensions/types.js";
import { INGEST_DIMENSIONS } from "../../packages/wiki/src/services/ingest/service.js";
import { measureKgIngest } from "../fixtures/kg-ingest-measure.js";
import {
  capturedRequests,
  chatRequestCount,
  clearCapturedRequests,
  installKgProviderStub,
  uninstallKgProviderStub,
} from "../fixtures/kg-provider-fetch.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { appRoleExists } from "../fixtures/rls-probe.js";
import { roleScopedDb } from "../fixtures/role-scoped-db.js";

const harness = await createKgPostgresHarness("kg-ingest-item2");
const { db, stackId, reachable } = harness;

/**
 * Whether the non-superuser role the production connection runs as exists here.
 *
 * Probed at module scope, like `kg-rls-tenant-binding.test.ts` and for its reason: `it.skipIf`
 * is decided when the file is DEFINED, so a probe inside `beforeAll` would read `false` and
 * skip the case silently. Only a reachable database is asked, so an unreachable one keeps the
 * single `reachable` skip instead of a second, noisier one.
 */
const appRole = reachable ? await appRoleExists(db) : false;

/** Outside the worktree, and removed below: the wiki writes its projection into it. */
const root = await mkdtemp(path.join(tmpdir(), "kg-ingest-item2-"));

afterAll(async () => {
  await shutDown();
});

/** Close the database and remove the scratch root, in that order. */
async function shutDown(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
}

/** The provider edge for ONE case, so every count belongs to the assertion that asked. */
beforeEach(() => {
  clearCapturedRequests();
  installKgProviderStub();
});

afterEach(() => uninstallKgProviderStub());

/** Long enough for several real ingests with a real extraction budget. */
const TEST_TIMEOUT_MS = 180_000;

/**
 * The fixture document: one sentence repeated far past the 1024-token chunk budget.
 *
 * The house idiom from `packages/llmwiki-kg/ts/src/routes/ingest-ontology.test.ts:95-98`, and
 * the SAME document item 1 measured, because S7 compares every item on one document. Only the
 * body is chunked, so this is the one input every number below depends on.
 */
const LONG_BODY = Array.from({ length: 200 }, (_, index) =>
  `The gateway routes embedding traffic for the office. ${String(index)}.`,
).join(" ");

/** The source identity the reuse sequence is keyed by, for both the ledger and the runs. */
const REUSE_SOURCE = "https://example.test/reuse-fixture";

/** The one numbered sentence a changed-character run edits, well inside the document. */
const EDITED_SENTENCE_INDEX = 150;

/**
 * {@link LONG_BODY} with exactly ONE character changed.
 *
 * The edit replaces a digit inside the numbered sentence, so the sentence count, the
 * punctuation and the character classes are untouched: the chunker's boundaries stay where
 * they were and only the chunk holding that sentence can produce a new hash. Editing a whole
 * sentence instead would move a chunk boundary and make "exactly one chunk" a claim about the
 * tokenizer rather than about the ledger.
 */
const EDITED_BODY = LONG_BODY.replace(
  `office. ${String(EDITED_SENTENCE_INDEX)}.`,
  `office. ${String(EDITED_SENTENCE_INDEX + 9)}.`,
);

/**
 * The graph hash the branch recorded BEFORE this change, on this fixture document.
 *
 * A literal on purpose: S2's claim is that extraction did not move, so a value recomputed
 * from the new code would prove nothing. If this differs, the change altered what the model
 * saw and the correct response is to stop, not to update the literal.
 */
const BASELINE_GRAPH_HASH = "99cbdad5faa2b45cd90a9ddebab289dbdc5bf5e90f447dbfb99ed3575f46d30c";

/** The four-chunk baseline S2 also fixes, so a moved count is reported as a moved count. */
const BASELINE_CHUNK_COUNT = 4;

/** The chat requests one first ingest of the fixture costs: one per chunk, sequentially. */
const BASELINE_CHAT_REQUESTS = 4;

/** The document title the production path uses; the digest of it and the body names the source. */
const TITLE = "KG ingest item 2 fixture";

/** Requests the slot is scoped to; the measurement instrument requires a live array. */
const lockSpans: number[] = [];

/** The environment a deployment runs both dimensions in, for this suite's Stack. */
function ingestEnv(): NodeJS.ProcessEnv {
  return {
    [AKS_DATABASE_URL_ENV_VAR]: DATABASE_URL,
    [DIMENSIONS_ENV_VAR]: INGEST_DIMENSIONS.join(","),
    [AKS_STACK_ID_ENV_VAR]: stackId,
  };
}

/** One ingest of the fixture document through the production entry. */
async function ingestThroughService(body = LONG_BODY) {
  return await measureKgIngest({
    root,
    db,
    stackId,
    env: ingestEnv(),
    title: TITLE,
    body,
    lockSpans,
    providerRequests: capturedRequests(),
  });
}

/** Both production measurements, in the order they were taken. */
type ProductionRuns = Awaited<ReturnType<typeof measureFirstAndSecondIngest>>;

/** The first and the unchanged re-ingest, measured once for the whole file. */
let productionRuns: ProductionRuns | undefined;

/**
 * Ingest the fixture twice through production, the second time with identical content.
 *
 * Memoized: the second run's zero is only meaningful against the first run's numbers, and
 * the counts are fixed at the moment of measurement, so a later capture reset cannot change
 * them.
 *
 * @returns Both measurements, in the order they were taken.
 */
async function measureFirstAndSecondIngest() {
  const first = await ingestThroughService();
  const second = await ingestThroughService();
  return { first, second };
}

/**
 * The production measurements, taken once.
 *
 * @returns Both measurements, in the order they were taken.
 */
async function firstAndSecond(): Promise<ProductionRuns> {
  productionRuns ??= await measureFirstAndSecondIngest();
  return productionRuns;
}

/**
 * The kg dimension as a deployment builds it: real ledger reader, stated Stack and database.
 *
 * `loadOntology` is the ONLY stub, and for item 1's reason: this Stack stores no declaration,
 * so the stub answers exactly what the database would while keeping the assertion about the
 * LEDGER rather than about the ontology column. Everything else -- the chunker, the prompt,
 * the parser, the consolidation SQL and the ledger reader -- is shipped code.
 *
 * @returns The dimension under test.
 */
function kgDimension(): Dimension {
  return createKgDimension({
    stackId,
    stackName: "reuse fixture",
    databaseUrl: DATABASE_URL,
    loadOntology: async () => undefined,
  });
}

/** The document one direct-dimension run is asked to ingest. */
function dimensionInput(source: string, body: string): DimensionInput {
  return { source, title: TITLE, document: `# ${TITLE}\n\n${body}\n`, body };
}

/** What one direct-dimension run cost and reported. */
interface DimensionRun {
  /** Chunks `prepare` produced: unchanged by reuse, which S2 requires. */
  readonly chunkCount: number;
  /** Chat completions this run sent; the number reuse is supposed to drive to zero. */
  readonly chatRequests: number;
  /** The per-document summary `commit` returned. */
  readonly summary: string;
}

/** How many chunks a prepared handle carries, through the port's opaque token. */
function chunkCountOf(handle: unknown): number {
  const chunks = (handle as { chunks?: unknown } | null | undefined)?.chunks;
  return Array.isArray(chunks) ? chunks.length : 0;
}

/**
 * Ingest one body for one source through the dimension itself.
 *
 * The source identity is stated explicitly, which is the whole reason this harness exists:
 * the production entry derives it from a digest of the content, so an edited body would name
 * a DIFFERENT source and could never reuse a hash.
 *
 * @param source - Source identity the ledger is keyed by.
 * @param body - The document body.
 * @returns What the run cost and what summary it reported.
 */
async function ingestDirect(source: string, body: string): Promise<DimensionRun> {
  clearCapturedRequests();
  const dimension = kgDimension();
  const prepared = await dimension.prepare(dimensionInput(source, body));
  const committed = await dimension.commit(prepared);
  return {
    chunkCount: chunkCountOf(prepared.handle),
    chatRequests: chatRequestCount(),
    summary: committed.summary,
  };
}

/** The fresh run and the unchanged one, taken once. */
type SequencedRuns = Awaited<ReturnType<typeof sequencedRuns>>;

/** The three direct runs whose relationship is the point: reuse, then one edited chunk. */
let reuseSequence: SequencedRuns | undefined;

/**
 * One source ingested three times: fresh, unchanged, and with one character edited.
 *
 * Sequenced rather than independent because the ledger is CUMULATIVE: the second run's
 * answer depends on the first having recorded its hashes, and the third depends on both.
 *
 * @returns The fresh run and the unchanged one; the edited run is taken by its own case.
 */
async function sequencedRuns() {
  const first = await ingestDirect(REUSE_SOURCE, LONG_BODY);
  const repeats = await ingestDirect(REUSE_SOURCE, LONG_BODY);
  return { first, repeats };
}

/**
 * The sequenced runs, taken once.
 *
 * @returns The fresh run and the unchanged one.
 */
async function sequence(): Promise<SequencedRuns> {
  reuseSequence ??= await sequencedRuns();
  return reuseSequence;
}

/** How many ledger rows this Stack holds for one source. */
async function ledgerRowsFor(source: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    `select count(*)::int as n from wiki.kg_extracted_chunks
      where stack_id = '${stackId}' and source = '${source}'`,
  );
  return rows[0]?.n ?? -1;
}

/**
 * How many DISTINCT hashes this Stack holds for one source.
 *
 * Read beside {@link ledgerRowsFor} because the two together are the unique key's meaning: a
 * table that stopped de-duplicating could still report the same total if a row it dropped had
 * been replaced by a duplicate of another.
 *
 * @param source - Source identity the ledger is keyed by.
 * @returns The number of distinct recorded hashes.
 */
async function distinctLedgerRowsFor(source: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    `select count(distinct content_hash)::int as n from wiki.kg_extracted_chunks
      where stack_id = '${stackId}' and source = '${source}'`,
  );
  return rows[0]?.n ?? -1;
}

describe.skipIf(!reachable)("a re-ingest through the production entry", () => {
  it("still produces the branch baseline for a first ingest", async () => {
    const { first } = await firstAndSecond();
    console.log(`kg-ingest-item2-baseline ${JSON.stringify(first)}`);

    // S2's comparison anchor, unchanged: same entities, same relationships, same graph.
    expect(first.graphHash).toBe(BASELINE_GRAPH_HASH);
    // S2's "same chunk boundaries" and "same per-chunk calls", stated separately so a moved
    // count is named as a moved count rather than absorbed into the hash.
    expect(first.chunkCount).toBe(BASELINE_CHUNK_COUNT);
    expect(first.chatRequests).toBe(BASELINE_CHAT_REQUESTS);
    // The embedding batch still ran, so this is a real first ingest and not a cache hit.
    expect(first.embeddingRequests).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("sends no chat request for unchanged content and keeps the graph identical", async () => {
    const { first, second } = await firstAndSecond();
    console.log(`kg-ingest-item2-reuse ${JSON.stringify(second)}`);

    // S5's headline, as an ABSOLUTE zero: extraction was not called at all.
    expect(second.chatRequests).toBe(0);
    // The saving is the extraction alone: chunking and embedding are untouched, so the
    // boundaries S2 fixes did not move to buy the skip.
    expect(second.chunkCount).toBe(first.chunkCount);
    expect(second.embeddingRequests).toBe(first.embeddingRequests);
    // Identity: the graph a reader sees is byte-identical after the skipping run.
    expect(second.graphHash).toBe(first.graphHash);
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(!reachable)("the skip's reporting and its two failure modes", () => {
  it("reports a fully reused run as reuse, never as a failure", async () => {
    const { repeats } = await sequence();
    console.log(`kg-ingest-item2-full-reuse ${repeats.summary}`);

    expect(repeats.chatRequests).toBe(0);
    // The split is stated, so the run cannot be mistaken for one that extracted everything
    // -- and a reused chunk is reported as reused, which is what keeps it out of the
    // failure count the summary renders separately.
    expect(repeats.summary).toBe(
      `kg:${String(BASELINE_CHUNK_COUNT)} chunks, 0 entities, 4 chunks reused, 0 chunks extracted`,
    );
    expect(repeats.summary).not.toContain("failed");
  }, TEST_TIMEOUT_MS);

  it("re-extracts exactly the chunk whose text changed, and no other", async () => {
    await sequence();
    const edited = await ingestDirect(REUSE_SOURCE, EDITED_BODY);
    console.log(`kg-ingest-item2-edited ${edited.summary}`);

    // Not zero (the ledger noticed the change) and not all (the ledger is per chunk).
    expect(edited.chatRequests).toBe(1);
    expect(edited.chunkCount).toBe(BASELINE_CHUNK_COUNT);
    expect(edited.summary).toBe(
      `kg:${String(BASELINE_CHUNK_COUNT)} chunks, 3 entities, 3 chunks reused, 1 chunk extracted`,
    );
  }, TEST_TIMEOUT_MS);

  it("does not skip a hash recorded for a different source", async () => {
    await sequence();
    // Same text, different source identity: nothing was ever extracted FOR THIS SOURCE, so
    // the ledger must not answer for the other one.
    const other = await ingestDirect("https://example.test/other-source", LONG_BODY);

    expect(other.chatRequests).toBe(BASELINE_CHAT_REQUESTS);
    expect(other.summary).not.toContain("reused");
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(!reachable || !appRole)("the ledger read as the application role", () => {
  /**
   * The ledger reader the kg dimension SHIPS, with its statements run as `llmwiki_app`.
   *
   * Built around `roleScopedDb` -- the fixture whose every transaction drops to the application
   * role INSIDE that transaction -- and not around a hand-rolled copy of the SQL: the connector
   * is the seam `createLedgerReader` exists to expose, so what runs below is the shipped
   * statement and the shipped `app.stack_id` binding.
   *
   * The role is the whole point. This harness connects as `aks`, a SUPERUSER with BYPASSRLS,
   * under which the ledger's FORCED policy never evaluates: a binding that never landed would
   * still return rows, so every read in the sibling cases is green for a reason nobody can see.
   *
   * @returns A reader in the shape the dimension's `readExtractedChunkHashes` takes.
   */
  function ledgerReaderAsAppRole(): ExtractedChunkHashesReader {
    return createLedgerReader(
      async (_databaseUrl, work) => await roleScopedDb(db).transaction(work),
    );
  }

  it("keeps a hash recorded for one Stack invisible to another", async () => {
    await sequence();
    const recorded = await distinctLedgerRowsFor(REUSE_SOURCE);
    // Non-vacuity of the FIXTURE, before the boundary is even asked about: a case about
    // hiding rows proves nothing if the rows were never written, and every assertion below
    // would pass over an empty ledger.
    expect(recorded).toBeGreaterThan(0);

    const otherStackId = randomUUID();
    await db.execute(
      `insert into stacks (id, name, domain)
       values ('${otherStackId}', 'kg-ingest-item2 other', 'kg-ingest-item2-other')`,
    );
    try {
      const reader = ledgerReaderAsAppRole();

      // Load-bearing together with the assertion after it, and weightless on its own: if the
      // binding did not reach the transaction the read runs in, `current_setting` would be
      // unset, the policy would compare against NULL and this Stack would see NOTHING -- a
      // silent empty set that reads as "nothing was ever extracted" and disables the skip.
      // Under the superuser this could not be observed.
      expect((await reader(stackId, REUSE_SOURCE)).size).toBe(recorded);

      // The boundary the skip depends on: same source identity, different Stack, and the
      // hashes recorded for the first are not visible to the second.
      expect((await reader(otherStackId, REUSE_SOURCE)).size).toBe(0);

      // And the isolation is the POLICY's, not the statement's `where stack_id = ...`: the
      // same Stack bound, asked for every row in the ledger with no predicate at all, still
      // sees none. Without this, dropping FORCE from the new table would leave the two
      // assertions above green while the tenant guard was gone.
      const visibleToOther = await roleScopedDb(db).transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.stack_id', ${otherStackId}, true)`);
        const rows = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from wiki.kg_extracted_chunks`,
        );
        return rows[0]?.n ?? -1;
      });
      expect(visibleToOther).toBe(0);
    } finally {
      await db.execute(`delete from stacks where id = '${otherStackId}'`);
    }
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(!reachable)("what the ledger records", () => {
  it("still writes no document_chunks row on this path", async () => {
    await sequence();

    // The reason the ledger is a separate table: rows appearing here would change what the
    // graph's own retrieval, reclassify and description readers find on the compile path, and
    // that would be an algorithm change bought with a speed change.
    const rows = await db.execute<{ n: number }>(
      `select count(*)::int as n from document_chunks where stack_id = '${stackId}'`,
    );
    expect(rows[0]?.n).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("records no duplicate ledger row for a repeated ingest", async () => {
    await sequence();
    const before = await ledgerRowsFor(REUSE_SOURCE);
    await ingestDirect(REUSE_SOURCE, LONG_BODY);

    // The count is a function of the CHUNK TEXTS seen, not of how many times the source was
    // ingested: the unique key absorbs the repeat instead of stacking a row per run, which
    // is what makes "already extracted" answerable at all.
    expect(await ledgerRowsFor(REUSE_SOURCE)).toBe(before);
    // And the rows really are distinct: a count that agreed with itself while holding two
    // rows for the same chunk would satisfy the assertion above and still lie.
    expect(await distinctLedgerRowsFor(REUSE_SOURCE)).toBe(before);
  }, TEST_TIMEOUT_MS);
});
