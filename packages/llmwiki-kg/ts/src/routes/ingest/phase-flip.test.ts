/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/phase-flip.test.ts
 * @description The two guarantees the phase split itself rests on (S1, S4): an ingest
 * forms nothing, and compiling an unchanged document changes nothing.
 *
 * WHY THIS FILE EXISTS. Both facts are invisible in a suite that only ever looks at the
 * end state of an ingest-then-compile PAIR:
 *
 * 1. "Ingest stores, compile extracts" fails silently in the worst direction. An ingest
 *    that still extracted would leave a graph behind, and every assertion on the final
 *    graph would still pass — the compile that ran afterwards would simply corroborate
 *    rows that were already there. So the only way to observe the split is a stack in
 *    which the FIRST phase ran and the graph is still empty, plus a provider call count
 *    that proves the model was never asked.
 * 2. "Recompiling an unchanged document changes nothing" is the entire guarantee the
 *    future lint feature will stand on: whatever observes a problem may call compile
 *    again, as often as it likes, and the graph must not drift. The guard that delivers
 *    it already holds (a contribution row is inserted with `on conflict ... do nothing`,
 *    so `updateEntity` only runs on genuinely new corroboration), and that is exactly
 *    why this must be a test: a property asserted only in prose is one a refactor can
 *    delete silently.
 * 3. Repeat compiles are not the only way an edge is re-upserted. Two DOCUMENTS that
 *    carry the same triple corroborate each other through the same statement, and there
 *    the rule is aggregation, not identity: `greatest(stored, excluded)` keeps the
 *    stronger confidence and the description that came with it
 *    (`core/document-consolidation.ts:441-450`). A snapshot taken from ONE scripted
 *    document cannot see that rule at all — with one contributor both `greatest` and
 *    `least` are no-ops over equal values — so the second corroboration below is pinned
 *    separately.
 *
 * Every provider answer is scripted by the shared fetch stub and no classifier is
 * configured, so nothing here reaches a network and the call counters are exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Provider configuration, hoisted above every import — see `ingest-formation.test.ts`. */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  delete process.env["TYPESAFE_API_KEY"];
});

import request from "supertest";
import type { Express } from "express";
import { sql } from "drizzle-orm";

import {
  embeddingCalls,
  installFetchStub,
  setToolResponse,
  toolCalls,
  uninstallFetchStub,
} from "../../core/extraction-harness.js";
import {
  compileUrl,
  createDocument,
  createStack,
  createTestApp,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { withFixtureTenant } from "../fixture-tenant.js";

useDomainPrefix("phase-flip");

/** A real body: two entities and one relationship, so an extracting ingest would write. */
const BODY = "Acme employs Ada Lovelace. Globex employs nobody at all.";

/** What the extraction model answers for {@link BODY}. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "company", name: "Acme" },
      relation: { type: "employs" },
      object: { type: "person", name: "Ada Lovelace" },
    },
  ],
  entities: [{ type: "company", name: "Globex" }],
};

/** A second document, whose text differs from {@link BODY} so its chunk is its own. */
const CORROBORATING_BODY = "A second report confirms that Acme employs Ada Lovelace.";

/**
 * What the model answers for {@link CORROBORATING_BODY}: the SAME triplet as
 * {@link ANSWER}, so extraction contributes to the identical
 * `(stack_id, from_entity_id, to_entity_id, type)`.
 *
 * The confidence it arrives with is not a choice — extraction assigns every
 * relationship the constant `EXTRACTED_CONFIDENCE`, 0.7 (`core/extraction-types.ts:133`),
 * and the empty description, because the model is never asked for either. So the only
 * way this corroboration can be LOWER than the stored edge is for the stored edge to
 * sit above 0.7, which the fixture below arranges.
 */
const CORROBORATING_ANSWER = {
  triplets: [
    {
      subject: { type: "company", name: "Acme" },
      relation: { type: "employs" },
      object: { type: "person", name: "Ada Lovelace" },
    },
  ],
  entities: [],
};

/** The description carried by the higher-confidence edge the fixture installs. */
const STRONGER_DESCRIPTION = "Raised by an approved backfeed proposal after human review.";

/** How many rows of each kind one Stack holds. */
type Counts = {
  readonly chunks: number;
  readonly entities: number;
  readonly relationships: number;
};

/** Reads the three counts, one Stack at a time so the read stays single-tenant. */
async function counts(stackId: string): Promise<Counts> {
  return withFixtureTenant(database(), { stackId }, async (tx) => {
    const rows = await tx.execute<Counts>(sql`
      select
        (select count(*)::int from document_chunks where stack_id = ${stackId}) as chunks,
        (select count(*)::int from ontology_entities where stack_id = ${stackId}) as entities,
        (select count(*)::int from ontology_relationships where stack_id = ${stackId}) as relationships
    `);
    return rows[0] ?? { chunks: -1, entities: -1, relationships: -1 };
  });
}

/**
 * Every row a repeat compile could touch, `select *` and in a deterministic order.
 *
 * WHY `select *`: the pin exists to catch a mutation in ANY graph or chunk column — the
 * edge upsert rewriting `confidence` with `excluded.confidence`, an edge deleted and
 * re-inserted under a new id, an `extracted_at` bumped to NOW. Naming a column list here
 * would silently stop covering a column added later, which is exactly the kind of hole
 * the entity-only snapshot this replaces had.
 */
type FullState = {
  readonly chunks: readonly unknown[];
  readonly entities: readonly unknown[];
  readonly relationships: readonly unknown[];
  readonly evidence: number;
};

/** The whole stored state of one Stack, as a value that can be compared byte for byte. */
async function fullState(stackId: string): Promise<FullState> {
  return withFixtureTenant(database(), { stackId }, async (tx) => {
    const chunks = await tx.execute(
      sql`select * from document_chunks where stack_id = ${stackId} order by chunk_index, id`,
    );
    const entities = await tx.execute(
      sql`select * from ontology_entities where stack_id = ${stackId} order by name, id`,
    );
    const relationships = await tx.execute(
      sql`select * from ontology_relationships where stack_id = ${stackId} order by id`,
    );
    const evidence = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from kg_evidence where stack_id = ${stackId}`,
    );
    return { chunks, entities, relationships, evidence: evidence[0]?.n ?? -1 };
  });
}

/** The app under test: the production transaction shape, no classifier. */
let app: Express;

/**
 * Raises the Stack's single edge to a state the compile pipeline cannot produce by
 * itself: a confidence ABOVE the 0.7 every extracted relationship arrives with
 * (`core/extraction-types.ts:133`; the extractor never asks the model for one) and a
 * description that arrived with it.
 *
 * WHY the fixture writes this. Two documents compiled through the routes can only ever
 * AGREE on 0.7 and on the empty description, and an aggregation rule exercised over
 * equal values proves nothing: `greatest` and `least` are both no-ops. A confidence
 * above 0.7 has one production producer — an approved backfeed proposal, whose upsert
 * stores the confidence the proposal carries (`core/consolidation.ts:224-245`) — so
 * raising the row directly is the same fixture shortcut
 * `routes/pages-pages.test.ts:254` takes for an entity's confidence, rather than a
 * second route grown into this file for one assertion.
 *
 * @param stackId - The Stack whose single edge is raised.
 */
async function holdStrongerEdge(stackId: string): Promise<void> {
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(sql`
      update ontology_relationships
      set confidence = ${0.9}, description = ${STRONGER_DESCRIPTION}
      where stack_id = ${stackId}
    `),
  );
}

beforeEach(async () => {
  await deleteFixtureRows();
  app = createTestApp();
  installFetchStub();
});

afterEach(async () => {
  uninstallFetchStub();
  await deleteFixtureRows();
});

describe.skipIf(skipReason !== false)("ingest is phase one and forms nothing (S1)", () => {
  it("stores the chunks and leaves the graph empty without ever asking the model", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);

    const response = await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // The document really was chunked and embedded — an ingest that did nothing at all
    // would also pass the empty-graph assertions below.
    expect(embeddingCalls()).toBeGreaterThan(0);
    expect(await counts(stackId)).toEqual({ chunks: 1, entities: 0, relationships: 0 });
    // And NOT ONE `/chat/completions` request was made: that is the endpoint the
    // extraction model is called on, and the answer below was scripted before the ingest
    // so a call would have been answered rather than failing. One call here is one
    // extraction, which is the whole thing this phase no longer does.
    expect(toolCalls()).toBe(0);
    // The response says the same thing the rows do, rather than reporting work that a
    // later phase may or may not do.
    expect(response.body).toMatchObject({
      chunks_created: 1,
      entities_extracted: 0,
      relationships_extracted: 0,
      relationships_written: 0,
      descriptions_synthesized: false,
      entities_in_stack: 0,
      relationships_in_stack: 0,
    });
  });
});

describe.skipIf(skipReason !== false)("compiling an unchanged document changes nothing (S4)", () => {
  it("leaves the whole stored state byte-identical and adds no row on a second compile", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    setToolResponse([ANSWER]);
    await request(app).post(compileUrl(stackId, documentId)).expect(200);
    const firstRun = await fullState(stackId);
    // The first compile has to have written something, or a second run that wrote
    // nothing at all would be indistinguishable from a guard that works: one triplet
    // plus one free entity is three entity rows, one edge and evidence for both.
    expect(firstRun.entities).toHaveLength(3);
    expect(firstRun.relationships).toHaveLength(1);
    expect(firstRun.evidence).toBeGreaterThan(0);
    expect(firstRun.chunks).toHaveLength(1);

    setToolResponse([ANSWER]);
    await request(app).post(compileUrl(stackId, documentId)).expect(200);
    const secondRun = await fullState(stackId);

    // Byte-identical, not "approximately equal": `confidence` drifting by a rounding
    // pass, `last_seen_at`/`updated_at`/`extracted_at` moving to NOW, an edge re-inserted
    // under a fresh id or a chunk row rewritten with a fabricated embedding are each the
    // failure mode this pins, and each is a different column moving for a different
    // reason. The evidence COUNT is snapped too: `kg_evidence` is append-only, so a
    // second run that forgets its `not exists` guard grows it without changing the graph.
    expect(JSON.stringify(secondRun)).toBe(JSON.stringify(firstRun));
  });

  it("rewrites a re-ingested document's chunk in place: same row, same created_at", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const firstIngest = await fullState(stackId);
    expect(firstIngest.chunks).toHaveLength(1);

    // The same document ingested twice: the second write must hit
    // `on conflict (document_id, chunk_index) do update`, not append a sibling row.
    await request(app).post(ingestUrl(stackId, documentId)).expect(200);
    const secondIngest = await fullState(stackId);

    // One row, the same id, and the FIRST write's `created_at`: the upsert updates
    // `content, content_hash, token_count, embedding` and nothing else, which is what
    // makes "when was this chunk set first stored" answerable at all.
    expect(secondIngest.chunks).toHaveLength(1);
    const first = firstIngest.chunks[0] as Record<string, unknown> | undefined;
    const second = secondIngest.chunks[0] as Record<string, unknown> | undefined;
    expect(second?.["id"]).toBe(first?.["id"]);
    expect(second?.["created_at"]).toEqual(first?.["created_at"]);
    // A second ingest forms nothing either: phase one never touches the graph.
    expect(secondIngest.entities).toHaveLength(0);
    expect(secondIngest.relationships).toHaveLength(0);
  });
});

/**
 * The AGGREGATION half of `S4`, in its own callback because it pins a different rule
 * from the repeat-compile one above: not "the same document twice", but "two documents
 * against one triple", where the edge upsert has to keep the stronger value rather than
 * the last one it saw. It is also separated by a hard limit — `max-lines-per-function`
 * (39, comments and blank lines excluded) counts nested `it` bodies, so a third test in
 * that callback would trip the lint ratchet for a file with no frozen allowance.
 */
describe.skipIf(skipReason !== false)(
  "an edge keeps the stronger confidence across documents (S4)",
  () => {
    it("keeps a higher stored confidence when a second document corroborates the same edge lower", async () => {
      const stackId = await createStack();
      const firstDocument = await createDocument(stackId, BODY);
      await request(app).post(ingestUrl(stackId, firstDocument)).expect(200);
      setToolResponse([ANSWER]);
      await request(app).post(compileUrl(stackId, firstDocument)).expect(200);
      // The stored edge now sits above anything a compile can contribute, which is the
      // input that tells `greatest(...)` apart from `least(...)` and from a plain
      // `description = excluded.description`. See `holdStrongerEdge`.
      await holdStrongerEdge(stackId);
      const before = await fullState(stackId);
      expect(before.relationships).toHaveLength(1);

      const secondDocument = await createDocument(stackId, CORROBORATING_BODY);
      await request(app).post(ingestUrl(stackId, secondDocument)).expect(200);
      setToolResponse([CORROBORATING_ANSWER]);
      const corroborating = await request(app)
        .post(compileUrl(stackId, secondDocument))
        .expect(200);
      // The second document really did reach the edge upsert: without this the
      // assertions below would also pass on a compile that extracted nothing at all.
      expect(corroborating.body).toMatchObject({ relationships_written: 1 });

      const after = await fullState(stackId);
      // One row for the triple: a weaker corroboration updates the edge it collides
      // with, it never appends a sibling.
      expect(after.relationships).toHaveLength(1);
      const edge = after.relationships[0] as Record<string, unknown> | undefined;
      // These two are what the `greatest(...)` and `case when excluded.confidence > ...`
      // branches decide (`core/document-consolidation.ts:441-450`): `least(stored,
      // excluded)` would leave 0.7 here, and a plain
      // `description = excluded.description` would blank the description. Neither move
      // is observable from a single document, which is why this probe exists.
      expect(edge?.["confidence"]).toBe(0.9);
      expect(edge?.["description"]).toBe(STRONGER_DESCRIPTION);
      // And nothing else on the row moved either — id, predicate, identity key, the
      // classification columns and every timestamp are in this comparison.
      expect(JSON.stringify(after.relationships)).toBe(JSON.stringify(before.relationships));
    });
  },
);
