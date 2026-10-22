import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Express } from "express";
import type { Sql } from "postgres";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
} from "../db.js";
import { createApp } from "../server.js";
import type { Database } from "../db.js";
import { retrieveRelevantChunks, toVectorLiteral } from "../core/retrieval.js";
import type { AksRouterDependencies } from "./aks.js";

/**
 * Integration tests for the AKS query endpoints, against the live compose
 * database on port 5434.
 *
 * ## Cost discipline — how many live LLM calls this suite makes
 *
 * **One** `/context` call, in the single `describe("aks context (live gateway)")`
 * block, enabled only with `AKS_TEST_GATEWAY=1`. It is skipped by default, so an
 * ordinary `npm test` makes **zero** provider calls. Every other test — entity
 * listing, filtering, traversal, export, retrieval scoring, and the whole
 * validation surface — is answered without the gateway and is fully testable
 * offline.
 *
 * The `/context` test asserts structure and types only. Measured on the oracle:
 * three identical requests produced 5, 3 and 4 entities, so any assertion on an
 * LLM-derived count would be a flake generator. What *is* stable — and therefore
 * asserted — is the response key set, the types of every field, the confidence
 * vocabulary, and the fact that the returned entities are a subset of the
 * fixture's catalog.
 *
 * ## Fixture isolation
 *
 * Every Stack this suite creates has a `domain` starting with {@link DOMAIN_PREFIX}.
 * All child tables reference `stacks(id)` with `on delete cascade`, so deleting
 * the prefixed Stacks cleans up completely; the child-first deletes are defence
 * in depth, matching the sibling suites.
 *
 * The suite skips — never fails — when the database is unreachable.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Unique domain prefix; the only key cleanup ever deletes on. */
const DOMAIN_PREFIX = "w2aks-";

/** An unknown-but-valid UUID used where a 404 is expected. */
const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

/**
 * Provider configuration, hoisted above the imports that read it.
 *
 * `config` parses `process.env` once at module load, so the environment must be
 * set before `../config.js` is imported by any transitively loaded module. When
 * `AKS_TEST_GATEWAY=1` the real values from `.env` are used (the live block needs
 * them); otherwise placeholders are installed, because no test in the default
 * run reaches a provider.
 */
vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

/** Key sets, in the oracle's order, for the two nested shapes. */
const ENTITY_KEYS = [
  "id",
  "name",
  "type",
  "description",
  "properties",
  "confidence",
  "contributing_documents",
  "last_seen_at",
  "source",
] as const;

const SOURCE_KEYS = [
  "document_id",
  "connector_id",
  "source_kind",
  "extracted_at",
  "model",
  "verified",
  "pipeline",
] as const;

const RELATIONSHIP_KEYS = [
  "id",
  "from_entity_id",
  "to_entity_id",
  "type",
  "description",
  "confidence",
  "source",
] as const;

const BUNDLE_KEYS = [
  "aks_version",
  "domain",
  "stack_id",
  "stack_name",
  "compiled_at",
  "scope",
  "entity_count",
  "relationship_count",
  "document_count",
  "compilation_strategy",
  "documents",
  "entities",
  "relationships",
] as const;

const TRAVERSE_KEYS = ["start", "max_depth", "steps", "entity_count"] as const;

const TRAVERSE_STEP_KEYS = [
  "from_entity",
  "relationship",
  "to_entity",
  "depth",
  "confidence",
] as const;

const CONTEXT_KEYS = [
  "query",
  "entities",
  "relationships",
  "traversal_path",
  "reasoning",
  "confidence",
  "source_type",
] as const;

const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    state.client = candidate;
    state.database = createDatabase(candidate);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(`[aks.test] skipping integration tests — ${state.skipReason}`);
}

/** Narrows the setup state for the compiler without an unchecked cast. */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

/** Deletes every row this suite created, children first. */
async function deleteFixtureRows(): Promise<void> {
  const prefixed = sql`select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;

  await database().execute(
    sql`delete from entity_source_documents where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_relationships where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_entities where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from document_chunks where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from stack_documents where stack_id in (${prefixed})`,
  );
  await database().execute(sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`);
}

/** Counts this suite's remaining rows; proves cleanup actually happened. */
async function countFixtureRows(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select
      (select count(*) from ontology_entities
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      + (select count(*) from ontology_relationships
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      + (select count(*) from document_chunks
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      + (select count(*) from stack_documents
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      as total
  `);
  // The sum of `count(*)` values is `numeric`, which postgres-js delivers as a
  // string; `Number` is the narrowing. A missing row means "cleanup did not run".
  const total = rows[0]?.total;
  return total === undefined ? -1 : Number(total);
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureRows()).toBe(0);

  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/** Builds the full application the way `createApp` does, bound to this pool. */
function createTestApp(): Express {
  const deps: AksRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface (`auth.test.ts`).
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };
  return createApp(deps);
}

/** A Stack plus its fixture graph, all under {@link DOMAIN_PREFIX}. */
interface Fixture {
  readonly stackId: string;
  readonly domain: string;
  readonly entityIds: { readonly gateway: string; readonly model: string; readonly limit: string };
  readonly relationshipIds: { readonly uses: string; readonly has: string };
  readonly documentId: string;
}

/**
 * Creates the canonical three-entity, two-edge fixture graph.
 *
 * ```
 * Gateway --USED_BY--> Embedding Model --HAS--> Rate Limit
 * ```
 *
 * A linear chain is deliberate: it makes depth bounds observable (depth 1 finds
 * one step, depth 2 finds two), and it gives the cycle-safety and visited-set
 * behaviour something to prove.
 */
async function createFixture(options: { withDocument?: boolean } = {}): Promise<Fixture> {
  const stackId = randomUUID();
  const domain = `${DOMAIN_PREFIX}${randomUUID().slice(0, 8)}`;
  const documentId = randomUUID();
  const gateway = randomUUID();
  const model = randomUUID();
  const limit = randomUUID();
  const uses = randomUUID();
  const has = randomUUID();

  await database().execute(sql`
    insert into stacks (id, name, domain, description, scope, compilation_strategy)
    values (${stackId}, ${`w2aks ${domain.slice(-8)}`}, ${domain}, ${"fixture stack"}, ${"stack"}, ${"incremental"})
  `);

  if (options.withDocument !== false) {
    await database().execute(sql`
      insert into stack_documents (
        id, stack_id, filename, storage_path, size_bytes, source_hash,
        truncated, original_length, audit
      )
      values (
        ${documentId}, ${stackId}, ${"fixture.txt"},
        ${"uploads/fixture.txt"}, ${120}, ${`hash-${documentId}`},
        ${false}, ${120}, ${null}
      )
    `);
  }

  await database().execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, description, properties, confidence,
      verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${gateway}, ${stackId}, ${"Gateway"}, ${"SYSTEM"},
       ${"Routes model traffic"}, ${JSON.stringify({ tier: "edge" })}::jsonb, ${0.9},
       ${true}, ${"model-a"}, ${"document"},
       ${"llamaindex-schema-extraction"}),
      (${model}, ${stackId}, ${"Embedding Model"}, ${"TECHNOLOGY"},
       ${null}, ${"{}"}::jsonb, ${0.6},
       ${false}, ${"model-a"}, ${"document"},
       ${"llamaindex-schema-extraction"}),
      (${limit}, ${stackId}, ${"Rate Limit"}, ${"CONCEPT"},
       ${"Caps throughput"}, ${"{}"}::jsonb, ${0.4},
       ${false}, ${null}, ${"document"}, ${"llamaindex-schema-extraction"})
  `);

  await database().execute(sql`
    insert into ontology_relationships (
      id, stack_id, from_entity_id, to_entity_id, type, description,
      confidence, verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${uses}, ${stackId}, ${gateway}, ${model}, ${"USED_BY"},
       ${"gateway uses model"}, ${0.75}, ${false}, ${"model-a"},
       ${"document"}, ${"llamaindex-schema-extraction"}),
      (${has}, ${stackId}, ${model}, ${limit}, ${"HAS"},
       ${"model has limit"}, ${0.55}, ${true}, ${"model-b"},
       ${"document"}, ${"llamaindex-schema-extraction"})
  `);

  if (options.withDocument !== false) {
    await database().execute(sql`
      insert into entity_source_documents (entity_id, document_id, stack_id)
      values (${gateway}, ${documentId}, ${stackId})
    `);
  }

  return {
    stackId,
    domain,
    entityIds: { gateway, model, limit },
    relationshipIds: { uses, has },
    documentId,
  };
}

/** Renders a query string from pairs, percent-encoding as needed. */
function qs(pairs: Record<string, string>): string {
  return new URLSearchParams(pairs).toString();
}

describe.skipIf(state.skipReason !== false)("aks entities (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("lists entities most confident first, with the oracle's key set", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}`)
      .expect(200);

    const entities = response.body as Array<Record<string, unknown>>;
    expect(entities.map((entity) => entity["name"])).toEqual([
      "Gateway",
      "Embedding Model",
      "Rate Limit",
    ]);

    // Key order comes from the DTO, so it is asserted exactly, not as a set.
    for (const entity of entities) {
      expect(Object.keys(entity)).toEqual([...ENTITY_KEYS]);
      expect(Object.keys(entity["source"] as object)).toEqual([...SOURCE_KEYS]);
    }

    // The nested source block is the traceability contract.
    expect(entities[0]?.["source"]).toEqual({
      document_id: null,
      connector_id: null,
      source_kind: "document",
      extracted_at: expect.any(String) as unknown,
      model: "model-a",
      verified: true,
      pipeline: "llamaindex-schema-extraction",
    });
    expect(entities[0]?.["properties"]).toEqual({ tier: "edge" });
    expect(entities[0]?.["contributing_documents"]).toEqual([fixture.documentId]);
    expect(entities[1]?.["contributing_documents"]).toEqual([]);
    expect(entities[1]?.["description"]).toBeNull();
  });

  it("filters by type, honouring an empty value as no filter", async () => {
    const fixture = await createFixture();

    const filtered = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=SYSTEM`)
      .expect(200);
    expect((filtered.body as Array<{ name: string }>).map((e) => e.name)).toEqual(["Gateway"]);

    // Python's `if type:` is a truthiness test, so `?type=` filters nothing.
    const empty = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=`)
      .expect(200);
    expect((empty.body as unknown[]).length).toBe(3);

    const missingType = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&type=NOPE`)
      .expect(200);
    expect(missingType.body).toEqual([]);
  });

  it("applies min_confidence and limit, and takes the last repeated limit", async () => {
    const fixture = await createFixture();

    const confident = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=0.5`)
      .expect(200);
    expect((confident.body as Array<{ name: string }>).map((e) => e.name)).toEqual([
      "Gateway",
      "Embedding Model",
    ]);

    const one = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&limit=1`)
      .expect(200);
    expect((one.body as unknown[]).length).toBe(1);

    // Measured: `?limit=1&limit=3` behaves like `?limit=3` — Starlette keeps the
    // last occurrence.
    const repeated = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}&limit=1&limit=3`)
      .expect(200);
    expect((repeated.body as unknown[]).length).toBe(3);
  });

  it("answers 200 with an empty array for a Stack with no entities", async () => {
    const fixture = await createFixture({ withDocument: false });
    await database().execute(sql`
      delete from ontology_relationships where stack_id = ${fixture.stackId}
    `);
    await database().execute(sql`
      delete from ontology_entities where stack_id = ${fixture.stackId}
    `);

    const response = await request(app)
      .get(`/aks/v1/entities?domain=${fixture.domain}`)
      .expect(200);

    // `[]`, not `null` and not a 404: an existing Stack with no entities is a
    // valid, empty answer.
    expect(response.body).toEqual([]);
  });

  it("resolves the Stack by stack_id as well as by domain", async () => {
    const fixture = await createFixture();

    const byId = await request(app)
      .get(`/aks/v1/entities?stack_id=${fixture.stackId}`)
      .expect(200);
    expect((byId.body as unknown[]).length).toBe(3);

    // Measured: a valid stack_id wins over a nonexistent domain.
    const both = await request(app)
      .get(`/aks/v1/entities?stack_id=${fixture.stackId}&domain=nonexistent`)
      .expect(200);
    expect((both.body as unknown[]).length).toBe(3);
  });

  it("returns a single entity by case-insensitive exact name", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities/cto?domain=${fixture.domain}`)
      .expect(404);
    // Detail echoes the *requested* text, not any row's name.
    expect(response.body).toEqual({ detail: "Entity 'cto' not found in Stack" });

    const found = await request(app)
      .get(`/aks/v1/entities/gateway?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(found.body as object)).toEqual([...ENTITY_KEYS]);
    expect((found.body as { name: string }).name).toBe("Gateway");
    expect((found.body as { contributing_documents: string[] }).contributing_documents).toEqual([
      fixture.documentId,
    ]);
  });

  it("answers 404 when neither stack_id nor domain is resolvable", async () => {
    await request(app).get("/aks/v1/entities?domain=nonexistent").expect(404).expect({
      detail: "Stack 'nonexistent' not found",
    });

    await request(app)
      .get(`/aks/v1/entities?stack_id=${UNKNOWN_UUID}`)
      .expect(404)
      .expect({ detail: `Stack '${UNKNOWN_UUID}' not found` });

    await request(app)
      .get(`/aks/v1/entities?domain=${fixtureDomainNeverCreated()}`)
      .expect(404);
  });

  it("validates the query before resolving the Stack", async () => {
    // FastAPI resolves every parameter before the handler body runs, so a bad
    // `limit` beats a nonexistent domain. Measured on the oracle.
    const response = await request(app)
      .get("/aks/v1/entities?domain=nonexistent&limit=0")
      .expect(422);

    expect(response.body).toEqual({
      detail: [
        {
          type: "greater_than_equal",
          loc: ["query", "limit"],
          msg: "Input should be greater than or equal to 1",
          input: "0",
          ctx: { ge: 1 },
        },
      ],
    });
  });

  it("reports every failing query parameter in declaration order", async () => {
    const response = await request(app)
      .get("/aks/v1/entities?stack_id=nope&min_confidence=2&limit=0")
      .expect(422);

    const detail = (response.body as { detail: Array<{ loc: string[]; type: string }> }).detail;
    expect(detail.map((entry) => entry.loc)).toEqual([
      ["query", "stack_id"],
      ["query", "min_confidence"],
      ["query", "limit"],
    ]);
    expect(detail.map((entry) => entry.type)).toEqual([
      "uuid_parsing",
      "less_than_equal",
      "greater_than_equal",
    ]);
  });

  it("rejects an empty stack_id even when a domain is supplied", async () => {
    // `?stack_id=` is present-but-unparseable, which is a 422 before the
    // resolver ever sees the domain. Measured.
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/entities?stack_id=&domain=${fixture.domain}`)
      .expect(422);

    const detail = (response.body as { detail: Array<{ type: string; loc: string[]; input: string }> })
      .detail;
    expect(detail).toHaveLength(1);
    expect(detail[0]?.type).toBe("uuid_parsing");
    expect(detail[0]?.loc).toEqual(["query", "stack_id"]);
    expect(detail[0]?.input).toBe("");
  });

  it("accepts these valid filter values and rejects those", async () => {
    const fixture = await createFixture();

    // Accepted forms measured on the oracle.
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1000`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=0`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=1`).expect(200);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=.5`).expect(200);

    // Rejected forms, each with the oracle's error code.
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=1001`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&limit=abc`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=abc`).expect(422);
    await request(app).get(`/aks/v1/entities?domain=${fixture.domain}&min_confidence=1.5`).expect(422);
  });
});

/** A domain that is guaranteed not to exist, without creating one. */
function fixtureDomainNeverCreated(): string {
  return `${DOMAIN_PREFIX}absent`;
}

describe.skipIf(state.skipReason !== false)("aks traverse (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("walks one hop at depth 1 and two hops at depth 2", async () => {
    const fixture = await createFixture();

    const depth1 = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "gateway", domain: fixture.domain, max_depth: "1" })}`)
      .expect(200);

    expect(Object.keys(depth1.body as object)).toEqual([...TRAVERSE_KEYS]);
    const body1 = depth1.body as {
      start: string;
      max_depth: number;
      steps: Array<Record<string, unknown>>;
      entity_count: number;
    };
    expect(body1.start).toBe("Gateway");
    expect(body1.max_depth).toBe(1);
    expect(body1.entity_count).toBe(2);
    expect(body1.steps).toHaveLength(1);
    expect(body1.steps[0]).toMatchObject({
      from_entity: "Gateway",
      relationship: "USED_BY",
      to_entity: "Embedding Model",
      depth: 1,
    });
    expect(body1.steps[0]?.["confidence"]).toBeCloseTo(0.75, 4);

    const depth2 = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "gateway", domain: fixture.domain, max_depth: "2" })}`)
      .expect(200);

    const body2 = depth2.body as { steps: Array<Record<string, unknown>>; entity_count: number };
    expect(body2.steps).toHaveLength(2);
    expect(body2.steps[1]).toMatchObject({
      from_entity: "Embedding Model",
      relationship: "HAS",
      to_entity: "Rate Limit",
      depth: 2,
    });
    expect(body2.steps[1]?.["confidence"]).toBeCloseTo(0.55, 4);
    expect(body2.entity_count).toBe(3);
    for (const step of body2.steps) {
      expect(Object.keys(step)).toEqual([...TRAVERSE_STEP_KEYS]);
    }
  });

  it("defaults max_depth to 2 and honours the relationship_types filter", async () => {
    const fixture = await createFixture();

    const defaults = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain })}`)
      .expect(200);
    expect((defaults.body as { max_depth: number }).max_depth).toBe(2);
    expect((defaults.body as { steps: unknown[] }).steps).toHaveLength(2);

    const onlyUses = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: "USED_BY",
        })}`,
      )
      .expect(200);
    expect((onlyUses.body as { steps: unknown[] }).steps).toHaveLength(1);
    expect((onlyUses.body as { entity_count: number }).entity_count).toBe(2);

    // An empty filter value follows every edge, because Python tests truthiness.
    const emptyFilter = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: "",
        })}`,
      )
      .expect(200);
    expect((emptyFilter.body as { steps: unknown[] }).steps).toHaveLength(2);

    // `","` splits into no usable types, so nothing is followed. Measured.
    const commas = await request(app)
      .get(
        `/aks/v1/traverse?${qs({
          start: "Gateway",
          domain: fixture.domain,
          relationship_types: ",,",
        })}`,
      )
      .expect(200);
    expect(commas.body).toEqual({
      start: "Gateway",
      max_depth: 2,
      steps: [],
      entity_count: 1,
    });
  });

  it("follows edges in one direction only", async () => {
    const fixture = await createFixture();

    // Starting at the chain's tail: `Rate Limit` has no outgoing edge, so the
    // walk finds nothing. A two-way interpretation would walk back up the chain.
    const backwards = await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "Rate Limit", domain: fixture.domain })}`)
      .expect(200);

    expect(backwards.body).toEqual({
      start: "Rate Limit",
      max_depth: 2,
      steps: [],
      entity_count: 1,
    });
  });

  it("is cycle-safe: a back-edge does not produce a repeated step", async () => {
    const fixture = await createFixture();
    // Close the loop: Rate Limit -> Gateway.
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.limit},
        ${fixture.entityIds.gateway}, ${"PART_OF"}, ${0.65}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "5" })}`,
      )
      .expect(200);

    const body = response.body as { steps: Array<{ to_entity: string }>; entity_count: number };
    // Gateway is already in `visited`, so the back-edge to it is skipped and the
    // walk terminates with exactly the two forward steps.
    expect(body.steps).toHaveLength(2);
    expect(body.entity_count).toBe(3);
  });

  it("returns one step per path through a diamond, but counts entities once", async () => {
    const fixture = await createFixture();
    // Gateway -> Rate Limit directly, so `Rate Limit` is reachable by two paths.
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${fixture.entityIds.limit}, ${"HAS"}, ${0.7}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "2" })}`,
      )
      .expect(200);

    const body = response.body as { steps: unknown[]; entity_count: number };
    // The visited array travels with each path, so the diamond produces BOTH
    // paths (measured on the oracle: three steps, two of them ending at `Rate
    // Limit`), while `entity_count` counts the distinct set once.
    expect(body.steps).toHaveLength(3);
    expect(body.entity_count).toBe(3);
  });

  it("reports entity_count as a distinct set, not as steps plus one", async () => {
    const fixture = await createFixture();
    // A second child of Gateway, making the walk span four distinct entities in
    // three steps — the case `len(steps) + 1` would over-count.
    const extra = randomUUID();
    await database().execute(sql`
      insert into ontology_entities (id, stack_id, name, type, confidence)
      values (${extra}, ${fixture.stackId}, ${"Cache"}, ${"SYSTEM"}, ${0.8})
    `);
    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, confidence
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${extra}, ${"USED_BY"}, ${0.7}
      )
    `);

    const response = await request(app)
      .get(
        `/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: "2" })}`,
      )
      .expect(200);

    const body = response.body as { steps: unknown[]; entity_count: number };
    expect(body.steps).toHaveLength(3);
    expect(body.entity_count).toBe(4);
  });

  it("answers 404 for an unknown start entity, and 422 for a missing start", async () => {
    const fixture = await createFixture();

    await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "nope", domain: fixture.domain })}`)
      .expect(404)
      .expect({ detail: "Entity 'nope' not found in Stack" });

    // An empty start is a real value, so it is a 404 rather than a 422.
    await request(app)
      .get(`/aks/v1/traverse?${qs({ start: "", domain: fixture.domain })}`)
      .expect(404)
      .expect({ detail: "Entity '' not found in Stack" });

    await request(app)
      .get(`/aks/v1/traverse?domain=${fixture.domain}`)
      .expect(422)
      .expect({
        detail: [
          { type: "missing", loc: ["query", "start"], msg: "Field required", input: null },
        ],
      });
  });

  it("bounds max_depth to 1..5", async () => {
    const fixture = await createFixture();

    for (const depth of ["0", "6", "abc"]) {
      const response = await request(app)
        .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: depth })}`)
        .expect(422);
      expect((response.body as { detail: Array<{ loc: string[] }> }).detail[0]?.loc).toEqual([
        "query",
        "max_depth",
      ]);
    }

    for (const depth of ["1", "5"]) {
      await request(app)
        .get(`/aks/v1/traverse?${qs({ start: "Gateway", domain: fixture.domain, max_depth: depth })}`)
        .expect(200);
    }
  });

  it("answers 422 when neither stack reference is given", async () => {
    await request(app)
      .get("/aks/v1/traverse?start=Gateway")
      .expect(422)
      .expect({ detail: "Either stack_id (UUID) or domain (slug) must be provided" });
  });
});

describe.skipIf(state.skipReason !== false)("aks export (no gateway)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("exports the whole Stack with the oracle's key set and counts", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(response.body as object)).toEqual([...BUNDLE_KEYS]);
    const bundle = response.body as Record<string, unknown>;

    expect(bundle["aks_version"]).toBe("0.2.0");
    expect(bundle["domain"]).toBe(fixture.domain);
    expect(bundle["stack_id"]).toBe(fixture.stackId);
    expect(bundle["scope"]).toBe("stack");
    expect(bundle["entity_count"]).toBe(3);
    expect(bundle["relationship_count"]).toBe(2);
    expect(bundle["document_count"]).toBe(1);
    expect(bundle["compilation_strategy"]).toBe("incremental");

    // `compiled_at` is request time, serialized the way Pydantic renders a UTC
    // datetime: six fractional digits and a `Z`.
    expect(bundle["compiled_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const documents = bundle["documents"] as Array<Record<string, unknown>>;
    expect(Object.keys(documents[0] ?? {})).toEqual([
      "id",
      "filename",
      "ingested_at",
      "source_hash",
      "truncated",
      "original_length",
      "audit",
    ]);
    expect(documents[0]?.["id"]).toBe(fixture.documentId);

    const relationships = bundle["relationships"] as Array<Record<string, unknown>>;
    for (const relationship of relationships) {
      expect(Object.keys(relationship)).toEqual([...RELATIONSHIP_KEYS]);
    }
  });

  it("filters entities and keeps only edges whose both ends survive", async () => {
    const fixture = await createFixture();

    const confident = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&min_confidence=0.5`)
      .expect(200);

    const body = confident.body as {
      entity_count: number;
      relationship_count: number;
      entities: Array<{ name: string }>;
      relationships: Array<{ type: string }>;
      document_count: number;
    };
    expect(body.entities.map((entity) => entity.name)).toEqual(["Gateway", "Embedding Model"]);
    // `HAS` has `Rate Limit` as its target, which the filter removed, so it is
    // dropped. Both endpoints must survive for an edge to be exported.
    expect(body.relationships.map((relationship) => relationship.type)).toEqual(["USED_BY"]);
    expect(body.entity_count).toBe(2);
    expect(body.relationship_count).toBe(1);
    // Documents are per Stack, not per selected entity, so the count is unchanged.
    expect(body.document_count).toBe(1);
  });

  it("honours verified_only and entity_type", async () => {
    // Base fixture: `Gateway` is verified, the other two are not.
    const fixture = await createFixture();

    const verified = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&verified_only=true`)
      .expect(200);
    const verifiedBody = verified.body as { entities: Array<{ name: string }>; relationship_count: number };
    // Only `Gateway` is verified in the base fixture (`?verified=true` on it).
    expect(verifiedBody.entities.map((entity) => entity.name)).toEqual(["Gateway"]);
    expect(verifiedBody.relationship_count).toBe(0);

    const byType = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&entity_type=CONCEPT`)
      .expect(200);
    const typeBody = byType.body as { entities: Array<{ name: string }>; relationship_count: number };
    expect(typeBody.entities.map((entity) => entity.name)).toEqual(["Rate Limit"]);
    expect(typeBody.relationship_count).toBe(0);

    // An empty entity_type filters nothing (Python truthiness).
    const all = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&entity_type=`)
      .expect(200);
    expect((all.body as { entity_count: number }).entity_count).toBe(3);
  });

  it("exports an empty Stack with empty arrays, not nulls", async () => {
    const fixture = await createFixture({ withDocument: false });
    await database().execute(sql`
      delete from ontology_relationships where stack_id = ${fixture.stackId}
    `);
    await database().execute(sql`
      delete from ontology_entities where stack_id = ${fixture.stackId}
    `);

    const response = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}`)
      .expect(200);

    expect(response.body).toMatchObject({
      entity_count: 0,
      relationship_count: 0,
      document_count: 0,
      documents: [],
      entities: [],
      relationships: [],
    });
  });

  it("validates verified_only and min_confidence before resolving the Stack", async () => {
    const response = await request(app)
      .get("/aks/v1/export?domain=nonexistent&min_confidence=5&verified_only=maybe")
      .expect(422);

    const detail = (response.body as { detail: Array<{ loc: string[] }> }).detail;
    expect(detail.map((entry) => entry.loc)).toEqual([
      ["query", "min_confidence"],
      ["query", "verified_only"],
    ]);
  });

  it("answers 422 when neither stack reference is given", async () => {
    await request(app)
      .get("/aks/v1/export")
      .expect(422)
      .expect({ detail: "Either stack_id (UUID) or domain (slug) must be provided" });
  });
});

/**
 * Retrieval scoring, exercised without the gateway.
 *
 * Vectors are written directly, so every expected score is computable from the
 * formula rather than observed from a model: this is the only way to pin the
 * geometric mean, the two 0.5 text fallbacks and the recency multiplier without
 * spending a provider call.
 */
describe.skipIf(state.skipReason !== false)(
  "hybrid retrieval scoring (no gateway)",
  () => {
    beforeEach(async () => {
      await deleteFixtureRows();
    });

    afterAll(async () => {
      await deleteFixtureRows();
    });

    /** Writes one chunk with an explicit embedding, returning its id. */
    async function createChunk(
      fixture: Fixture,
      content: string,
      embedding: readonly number[],
      chunkIndex: number,
      ageDays = 0,
    ): Promise<string> {
      const chunkId = randomUUID();
      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash,
          token_count, embedding, created_at
        )
        values (
          ${chunkId}, ${fixture.documentId}, ${fixture.stackId}, ${chunkIndex},
          ${content}, ${`hash-${chunkId}`}, ${10},
          ${toVectorLiteral(embedding)}::vector,
          now() - (${ageDays} * interval '1 day')
        )
      `);
      return chunkId;
    }

    it("renders pgvector literals the way Postgres reads them", () => {
      expect(toVectorLiteral([0.1, -0.2, 0])).toBe("[0.1,-0.2,0]");
      expect(toVectorLiteral([])).toBe("[]");
    });

    it("ranks a chunk that matches both signals above one that matches only one", async () => {
      const fixture = await createFixture();
      // Query text is long enough (>= 12 chars) to use trigram similarity.
      const query = "gateway routes embedding traffic";
      const [qa, qb] = await Promise.all([
        // Aligned with the query vector and sharing vocabulary.
        createChunk(fixture, `${query} through the nomic model`, unitVector(0), 0),
        // Aligned with the query vector but sharing no trigrams.
        createChunk(fixture, "zzzz wwwww qqqqq vvvvv", unitVector(0), 1),
      ]);
      // Orthogonal to the query vector but sharing vocabulary.
      const c = await createChunk(fixture, `${query} through the nomic model`, unitVector(1), 2);
      expect(c).not.toBe(qa);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const order = chunks.map((chunk) => chunk.id);
      expect(order[0]).toBe(qa);
      expect(order).toContain(qb);
      // The orthogonal chunk has vector_sim clamped to 0, so its score is 0.
      expect(chunks.find((chunk) => chunk.id === qb)?.similarity).toBeGreaterThan(0);
    });

    it("clamps negative cosine similarity to zero instead of producing NaN", async () => {
      const fixture = await createFixture();
      const query = "opposing vector chunk";
      const id = await createChunk(fixture, query, oppositeVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === id);
      expect(found).toBeDefined();
      expect(Number.isNaN(found?.similarity ?? Number.NaN)).toBe(false);
      expect(found?.similarity).toBe(0);
    });

    it("applies the neutral 0.5 trigram fallback for a short query", async () => {
      const fixture = await createFixture();
      // Under 12 characters, so `text_sim` is exactly 0.5.
      const query = "gateway";
      const chunkId = await createChunk(fixture, "unrelated content entirely", unitVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === chunkId);
      // vector_sim ~= 1, text_sim == 0.5, recency ~= 1 -> sqrt(0.5) ~= 0.7071.
      expect(found?.similarity).toBeCloseTo(Math.sqrt(0.5), 3);
    });

    it("applies the same 0.5 fallback when trigram similarity is below 0.05", async () => {
      const fixture = await createFixture();
      // A long query with no trigram overlap at all: similarity() would be ~0.
      const query = "completely dissimilar phrasing here";
      const chunkId = await createChunk(fixture, "xxxxxxxx yyyyyyyy", unitVector(0), 0);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const found = chunks.find((chunk) => chunk.id === chunkId);
      expect(found?.similarity).toBeCloseTo(Math.sqrt(0.5), 3);
    });

    it("multiplies by the recency factor, so an older chunk scores lower", async () => {
      const fixture = await createFixture();
      const query = "recency comparison chunk";
      const fresh = await createChunk(fixture, query, unitVector(0), 0, 0);
      const old = await createChunk(fixture, query, unitVector(0), 1, 365);

      const chunks = await retrieveRelevantChunks(
        database(),
        fixture.stackId,
        query,
        unitVector(0),
        10,
      );

      const freshScore = chunks.find((chunk) => chunk.id === fresh)?.similarity ?? 0;
      const oldScore = chunks.find((chunk) => chunk.id === old)?.similarity ?? 0;

      expect(freshScore).toBeGreaterThan(oldScore);
      // One year of decay: 0.85 + 0.15 * e^-1, versus ~1.0 when brand new.
      const ratio = oldScore / freshScore;
      expect(ratio).toBeCloseTo(0.85 + 0.15 * Math.exp(-1), 2);
    });

    it("scopes the search to one Stack and skips chunks with no embedding", async () => {
      const mine = await createFixture();
      const other = await createFixture();
      const mineId = await createChunk(mine, "scoped retrieval chunk", unitVector(0), 0);
      await createChunk(other, "scoped retrieval chunk", unitVector(0), 0);

      // A NULL embedding is excluded by `where dc.embedding is not null`.
      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash, token_count
        )
        values (
          ${randomUUID()}, ${mine.documentId}, ${mine.stackId}, 9,
          ${"no embedding here"}, ${randomUUID()}, ${3}
        )
      `);

      const chunks = await retrieveRelevantChunks(
        database(),
        mine.stackId,
        "scoped retrieval chunk",
        unitVector(0),
        10,
      );

      expect(chunks.map((chunk) => chunk.id)).toEqual([mineId]);
    });

    it("honours the limit and returns the highest scores first", async () => {
      const fixture = await createFixture();
      const query = "ordering check chunk";
      const a = await createChunk(fixture, query, unitVector(0), 0);
      const b = await createChunk(fixture, query, unitVector(0), 1, 365);
      const c = await createChunk(fixture, query, orthogonallyMixed(), 2);

      const all = await retrieveRelevantChunks(database(), fixture.stackId, query, unitVector(0), 10);
      expect(all).toHaveLength(3);

      const top = await retrieveRelevantChunks(database(), fixture.stackId, query, unitVector(0), 2);
      expect(top).toHaveLength(2);
      // Fresh, then stale, then the weakly-aligned one.
      expect([top[0]?.id, top[1]?.id]).toEqual([a, b]);
      expect(all.some((chunk) => chunk.id === c)).toBe(true);
      // Scores are non-increasing.
      for (let index = 1; index < all.length; index += 1) {
        const previous = all[index - 1]?.similarity ?? 0;
        const current = all[index]?.similarity ?? 0;
        expect(previous).toBeGreaterThanOrEqual(current);
      }
    });
  },
);

/** A 768-dimension unit vector: 1 at `axis`, 0 elsewhere. */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[axis] = 1;
  return vector;
}

/** The negation of {@link unitVector}, giving cosine similarity -1. */
function oppositeVector(axis: number): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[axis] = -1;
  return vector;
}

/** A half-aligned vector: similarity 0.5 against {@link unitVector}(0). */
function orthogonallyMixed(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[0] = 1;
  vector[1] = Math.sqrt(3);
  const norm = Math.hypot(1, Math.sqrt(3));
  return vector.map((component) => component / norm);
}

/**
 * The one block that spends money.
 *
 * Enabled only with `AKS_TEST_GATEWAY=1`. One `/context` request: an embedding
 * for the query plus one extraction completion, which is the minimum needed to
 * exercise the full pipeline against a real provider.
 *
 * Nothing LLM-derived is asserted as an exact value — measured on the oracle,
 * three identical requests returned 5, 3 and 4 entities. What is asserted is the
 * envelope: key set, field types, the confidence vocabulary, and that every
 * returned entity really belongs to the fixture Stack.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "aks context (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
    });

    afterAll(async () => {
      await deleteFixtureRows();
    });

    it("returns a structurally valid subgraph for a natural-language query", async () => {
      const fixture = await createFixture();
      // Chunks are needed for the pipeline to reach the LLM at all: with no
      // chunks the endpoint short-circuits before calling the model. The
      // embedding comes from the gateway, which is the whole point of this block.
      const { embedQuery } = await import("../core/extraction.js");
      const embedding = await embedQuery("How does the gateway route embedding traffic?");
      expect(embedding).toHaveLength(768);

      await database().execute(sql`
        insert into document_chunks (
          id, document_id, stack_id, chunk_index, content, content_hash,
          token_count, embedding
        )
        values (
          ${randomUUID()}, ${fixture.documentId}, ${fixture.stackId}, 0,
          ${"The gateway routes embedding traffic to the Nomic embedding model, which caps throughput with a rate limit."},
          ${randomUUID()}, ${24}, ${toVectorLiteral(embedding)}::vector
        )
      `);

      const response = await request(app)
        .post("/aks/v1/context")
        .send({ domain: fixture.domain, query: "How does the gateway route embedding traffic?" })
        .expect(200);

      expect(Object.keys(response.body as object)).toEqual([...CONTEXT_KEYS]);

      const body = response.body as {
        query: string;
        entities: Array<Record<string, unknown>>;
        relationships: Array<Record<string, unknown>>;
        traversal_path: string[];
        reasoning: string;
        confidence: string;
        source_type: string;
      };

      expect(body.query).toBe("How does the gateway route embedding traffic?");
      expect(typeof body.reasoning).toBe("string");
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(body.confidence);
      expect(body.source_type).toBe("compiled");
      expect(Array.isArray(body.entities)).toBe(true);
      expect(Array.isArray(body.relationships)).toBe(true);
      expect(Array.isArray(body.traversal_path)).toBe(true);

      // Structure only: the count is model-dependent and must never be pinned.
      for (const entity of body.entities) {
        expect(Object.keys(entity)).toEqual([...ENTITY_KEYS]);
        expect(typeof entity["confidence"]).toBe("number");
      }
      for (const relationship of body.relationships) {
        expect(Object.keys(relationship)).toEqual([...RELATIONSHIP_KEYS]);
      }

      // Whatever the model selected, it can only be a fixture entity, and the
      // trajectory names must be real rows.
      const fixtureNames = ["Gateway", "Embedding Model", "Rate Limit"];
      for (const entity of body.entities) {
        expect(fixtureNames).toContain(entity["name"]);
      }
      for (const name of body.traversal_path) {
        expect(typeof name).toBe("string");
      }
      expect(body.traversal_path).toEqual(body.entities.map((entity) => entity["name"]));
    }, 180_000);
  },
);
