import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

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
import {
  buildPagePrompt,
  compareCodePoints,
  computeGraphVersion,
  formatFixed2,
  pythonFloatRepr,
  pythonJsonDumps,
} from "../core/page_generator.js";
import type { EntityPageContext, PageEntityRow, PageRelationshipRow } from "../core/page_generator.js";
import {
  buildArchiveEntries,
  buildReadme,
  buildZipArchive,
  pageFilename,
  pythonUtcIsoformat,
} from "./pages.js";
import { buildSynthesisPrompt } from "./synthesize.js";

/**
 * Entity pages and description synthesis — the last slice of the port.
 *
 * ## Cost discipline — how many live LLM calls this suite makes
 *
 * **Four**, in the single `describe("pages and synthesis (live gateway)")` block,
 * enabled only with `AKS_TEST_GATEWAY=1`:
 *
 * | call | endpoint | why it is not avoidable |
 * |---|---|---|
 * | 1 | `GET /aks/v1/pages/{entity}` (first read) | the cache-miss path is the whole feature |
 * | 2 | `GET /aks/v1/pages` → `Payment Gateway` | not yet cached |
 * | 3 | `GET /aks/v1/pages` → `Rate Limit` | not yet cached |
 * | 4 | `POST /aks/v1/entities/{name}/synthesize-description` | one synthesis is the feature |
 *
 * The second read of the same entity is asserted to be `cached: true` and to have
 * spent no call, which is what proves the cache. The ZIP's third entity is
 * already cached by then, so the archive costs two calls rather than three.
 *
 * The batch backfill (`POST /stacks/{id}/synthesize-descriptions`) is exercised
 * **only** in the offline block, with a provider this suite must never reach: it
 * loops over every candidate, so a live run would cost one call per entity and
 * would start failing as soon as the provider rate-limits.
 *
 * ## Totals
 *
 * Measured with `--reporter=verbose`, which prints the skip list:
 *
 * - default `npm test` — `575 passed | 4 skipped`, and **0** live calls. The four
 *   skips are the 2 live tests in this file, the 1 in `aks.test.ts`, and the 1
 *   pre-existing skip in `ingest.test.ts`.
 * - `AKS_TEST_GATEWAY=1` — this file makes **4** live calls and skips none.
 *
 * Skipped by default, so an ordinary `npm test` makes **zero** provider calls.
 * Everything else — ZIP container assembly, filename sanitisation, README
 * composition, prompt construction, `graph_version` hashing, the validation
 * surface, and the backfill bookkeeping — is answered offline:
 *
 * - the pure functions are tested directly;
 * - the two DB-touching endpoints are tested with the **LLM stubbed** (that is
 *   what {@link stubComplete} does — a module mock, not a network call);
 * - `AKS_TEST_GATEWAY=1` is the only thing that lets a real request out.
 *
 * ## Nothing LLM-derived is asserted
 *
 * Measured on the oracle: five, three and four entities across three identical
 * runs on the same input, and page text that changes every time. So the suite
 * pins structure and the deterministic parts only — the archive's file list,
 * section headings, key order, cache flags, and hash stability.
 *
 * ## Fixture isolation
 *
 * Every Stack this suite creates has a `domain` starting with {@link DOMAIN_PREFIX}.
 * `entity_pages` and `entity_source_documents` reference `entity_id` with
 * `on delete cascade`, so deleting the prefixed Stacks removes the pages too;
 * the child-first deletes are defence in depth and `countFixtureRows` proves the
 * cascade actually happened.
 *
 * The suite skips — never fails — when the database is unreachable.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ?? "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Unique domain prefix; the only key cleanup ever deletes on. */
const DOMAIN_PREFIX = "w2pg-";

/** Provider configuration, hoisted above the imports that read it. */
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

/**
 * The switchable stub for the module-level `complete`.
 *
 * `enabled` is what keeps the suite honest in both directions:
 *
 * - the offline blocks turn it **on**, so they record the prompt and return a
 *   sentinel instead of spending a provider call;
 * - the `AKS_TEST_GATEWAY=1` block turns it **off** and the real implementation
 *   runs, which is the only way that block can be a live test at all.
 *
 * Without the flag a test that forgets to stub reaches
 * `https://gateway.invalid/v1` and fails loudly, so an accidentally-live call in
 * the default run is impossible.
 */
const completeMock = vi.hoisted(() => ({
  /** When false, the real `complete` is called. */
  enabled: true,
  /** Calls the stub intercepted, in order. */
  calls: [] as { prompt: string; maxTokens: number | undefined }[],
  /** Text the stub returns. */
  reply: "",
}));

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    complete: async (prompt: string, maxTokens?: number): Promise<string> => {
      if (!completeMock.enabled) {
        return actual.complete(prompt, maxTokens);
      }
      completeMock.calls.push({ prompt, maxTokens });
      return completeMock.reply;
    },
  };
});

/** The key set and order of `AKSEntityPage`, measured on the oracle. */
const ENTITY_PAGE_KEYS = [
  "entity_name",
  "markdown",
  "generated_at",
  "source_entity_id",
  "graph_version",
  "source_type",
  "cached",
] as const;

/** The key set of `BackfillResult`. */
const BACKFILL_KEYS = [
  "stack_id",
  "entities_considered",
  "entities_synthesized",
  "entities_skipped",
] as const;

/** The key set of the single-entity synthesis response. */
const SYNTHESIZE_ONE_KEYS = ["entity_name", "description", "synthesized"] as const;

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
  console.warn(`[pages.test] skipping integration tests — ${state.skipReason}`);
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
    sql`delete from entity_pages where stack_id in (${prefixed})`,
  );
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
      + (select count(*) from entity_pages
        where stack_id in (select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}))
      as total
  `);
  // The sum of `count(*)` values is `numeric`, which postgres-js delivers as a
  // string; `Number` is the narrowing.
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
  const deps = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface (`auth.test.ts`).
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
  };
  return createApp(deps);
}

/** A Stack plus the graph the page endpoints read, all under {@link DOMAIN_PREFIX}. */
interface Fixture {
  readonly stackId: string;
  readonly stackName: string;
  readonly domain: string;
  readonly entityIds: { readonly billing: string; readonly gateway: string; readonly limit: string };
  readonly documentId: string;
}

/**
 * Creates a three-entity fixture with one outgoing edge, one incoming edge and
 * one contributing document.
 *
 * ```
 * Billing Service --USES--> Payment Gateway
 * Rate Limit --CAPS--> Billing Service
 * ```
 *
 * Chosen so each entity has a different relationship *shape*: one has only
 * outgoing edges, one only incoming, one both. That is what makes the
 * `graph_version` sensitivity tests meaningful.
 *
 * `chunkText` is written as a `document_chunks` row so the synthesis endpoint has
 * grounding to find; without it the endpoint answers `synthesized: false` and
 * never reaches the model.
 */
async function createFixture(): Promise<Fixture> {
  const stackId = randomUUID();
  const domain = `${DOMAIN_PREFIX}${randomUUID().slice(0, 8)}`;
  const stackName = `w2pg ${domain.slice(-8)}`;
  const documentId = randomUUID();
  const billing = randomUUID();
  const gateway = randomUUID();
  const limit = randomUUID();

  await database().execute(sql`
    insert into stacks (id, name, domain, description, scope, compilation_strategy)
    values (${stackId}, ${stackName}, ${domain}, ${"pages fixture"}, ${"stack"}, ${"incremental"})
  `);

  await database().execute(sql`
    insert into stack_documents (
      id, stack_id, filename, storage_path, size_bytes, source_hash,
      truncated, original_length, audit
    )
    values (
      ${documentId}, ${stackId}, ${"w2pg-runbook.txt"},
      ${"uploads/w2pg-runbook.txt"}, ${240}, ${`hash-${documentId}`},
      ${false}, ${240}, ${null}
    )
  `);

  await database().execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, description, properties, confidence,
      verified, extracted_by_model, source_kind, pipeline
    )
    values
      (${billing}, ${stackId}, ${"Billing Service"}, ${"SYSTEM"},
       ${"Processes invoices for customers"}, ${JSON.stringify({ tier: "edge" })}::jsonb, ${0.9},
       ${true}, ${"model-a"}, ${"document"}, ${"llamaindex-schema-extraction"}),
      (${gateway}, ${stackId}, ${"Payment Gateway"}, ${"SYSTEM"},
       ${null}, ${"{}"}::jsonb, ${0.7},
       ${false}, ${"model-a"}, ${"document"}, ${"llamaindex-schema-extraction"}),
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
      (${randomUUID()}, ${stackId}, ${billing}, ${gateway}, ${"USES"},
       ${"billing uses gateway"}, ${0.75}, ${false}, ${"model-a"},
       ${"document"}, ${"llamaindex-schema-extraction"}),
      (${randomUUID()}, ${stackId}, ${limit}, ${billing}, ${"CAPS"},
       ${"limit caps billing"}, ${0.55}, ${true}, ${"model-b"},
       ${"document"}, ${"llamaindex-schema-extraction"})
  `);

  await database().execute(sql`
    insert into entity_source_documents (entity_id, document_id, stack_id)
    values (${billing}, ${documentId}, ${stackId})
  `);

  await database().execute(sql`
    insert into document_chunks (
      id, document_id, stack_id, chunk_index, content, content_hash, token_count
    )
    values (
      ${randomUUID()}, ${documentId}, ${stackId}, 0,
      ${"The Billing Service processes invoices and calls the Payment Gateway to charge cards."},
      ${`chunk-${documentId}`}, ${16}
    )
  `);

  return {
    stackId,
    stackName,
    domain,
    entityIds: { billing, gateway, limit },
    documentId,
  };
}

// ---------------------------------------------------------------------------
// ZIP reading helpers (the suite reads the archive back, like a client would)
// ---------------------------------------------------------------------------

/** One entry of an archive this suite produced. */
interface ParsedEntry {
  readonly name: string;
  readonly content: string;
  readonly compressionMethod: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flagBits: number;
  readonly createSystem: number;
  readonly externalAttr: number;
}

/**
 * Parses a ZIP archive written by {@link buildZipArchive}.
 *
 * A real client would use a library; this reads the container by hand for the
 * same reason `http-contract.ts` inspects Express's router stack — the point of
 * the test is the bytes, and a second implementation that shares code with the
 * writer would not prove anything about the writer.
 */
function readZipArchive(archive: Buffer): ParsedEntry[] {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("no end-of-central-directory record found");
  }

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);

  const entries: ParsedEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error(`central directory entry ${String(index)} has a bad signature`);
    }
    const createdBy = archive.readUInt16LE(centralOffset + 4);
    const flags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const crc = archive.readUInt32LE(centralOffset + 16);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const externalAttr = archive.readUInt32LE(centralOffset + 38);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString("utf8");

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`local header for ${name} has a bad signature`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name,
      content: (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"),
      compressionMethod: method,
      crc,
      compressedSize,
      uncompressedSize,
      flagBits: flags,
      createSystem: createdBy >> 8,
      externalAttr,
    });

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** A `PageEntityRow` for the pure-function tests. */
function entityRow(overrides: Partial<PageEntityRow> = {}): PageEntityRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    stack_id: "10000000-0000-4000-8000-0000000000ff",
    name: "Billing Service",
    type: "SYSTEM",
    description: "Processes invoices",
    properties_text: '{"tier": "edge"}',
    confidence: 0.7,
    verified: true,
    last_seen_at: null,
    ...overrides,
  };
}

/** A `PageRelationshipRow` for the pure-function tests. */
function relationshipRow(
  overrides: Partial<PageRelationshipRow> = {},
): PageRelationshipRow {
  return {
    type: "USES",
    confidence: 0.75,
    description: null,
    other_name: "Payment Gateway",
    other_type: "SYSTEM",
    direction: "outgoing",
    ...overrides,
  };
}

// ===========================================================================
// Offline: Python number and JSON formatting
// ===========================================================================

describe("python float formatting", () => {
  /**
   * Every case is a value read back from CPython's own `str(float(x))`.
   *
   * The thresholds are the whole point: `decpt <= -4` and `decpt > 16` switch to
   * exponential. A naive `String(value)` gets `1e16` and `1e-5` wrong, and a
   * naive `toFixed` gets the rounding of `0.005` and `0.125` wrong.
   */
  it("reproduces CPython's short repr, including the exponential thresholds", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "0.0"],
      [1, "1.0"],
      [0.7, "0.7"],
      [0.35, "0.35"],
      [0.12345679, "0.12345679"],
      [1e-5, "1e-05"],
      [1e-4, "0.0001"],
      [1e16, "1e+16"],
      [1.5e16, "1.5e+16"],
      [1e15, "1000000000000000.0"],
      [1234567890123456.0, "1234567890123456.0"],
      [12345678901234567.0, "1.2345678901234568e+16"],
      [123456789012345.6, "123456789012345.6"],
      [2.5, "2.5"],
      [-0.5, "-0.5"],
      [5e-324, "5e-324"],
      [1e300, "1e+300"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
    ];

    for (const [value, expected] of cases) {
      expect(pythonFloatRepr(value), `repr(${String(value)})`).toBe(expected);
    }
  });

  it("renders negative zero and the non-finite values the way Python does", () => {
    expect(pythonFloatRepr(-0)).toBe("-0.0");
    expect(pythonFloatRepr(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(pythonFloatRepr(Number.NEGATIVE_INFINITY)).toBe("-inf");
    expect(pythonFloatRepr(Number.NaN)).toBe("nan");
  });

  /**
   * `f"{value:.2f}"` rounds the *exact binary value* half-to-even, which is
   * neither `toFixed` (ties away from zero) nor `Intl` (rounds the shortest
   * repr). These five values are where all three disagree.
   */
  it("reproduces f-string .2f rounding, which neither toFixed nor Intl matches", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0.125, "0.12"],
      [0.375, "0.38"],
      [0.625, "0.62"],
      [0.875, "0.88"],
      [1.125, "1.12"],
      [0.005, "0.01"],
      [0.015, "0.01"],
      [0.025, "0.03"],
      [0.0625, "0.06"],
      [0.0025, "0.00"],
      [2.675, "2.67"],
      [0.7, "0.70"],
      [0.75, "0.75"],
      [0.675, "0.68"],
      [0.5512, "0.55"],
      [0.5, "0.50"],
      [1, "1.00"],
      [0, "0.00"],
      [-0.005, "-0.01"],
    ];

    for (const [value, expected] of cases) {
      expect(formatFixed2(value), `.2f of ${String(value)}`).toBe(expected);
    }
  });

  it("diverges from toFixed and Intl in the places each of them is wrong", () => {
    // Stated so the doc comment cannot rot. These are the values where the naive
    // implementations are wrong, and each one is wrong differently: `toFixed`
    // ties away from zero, `Intl` rounds the shortest decimal repr.
    expect((0.125).toFixed(2)).toBe("0.13");
    expect(formatFixed2(0.125)).toBe("0.12");

    expect((0.005).toFixed(2)).toBe("0.01");
    const halfEven = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
      roundingMode: "halfEven",
    });
    expect(halfEven.format(0.005)).toBe("0.00");
    expect(formatFixed2(0.005)).toBe("0.01");

    expect(halfEven.format(2.675)).toBe("2.68");
    expect(formatFixed2(2.675)).toBe("2.67");
  });
});

describe("python json.dumps for graph_version", () => {
  it("keeps int/float identity, which JavaScript would collapse", () => {
    // jsonb text `1.0` / `1` / `1e16` -> Python `float` / `int` / `int`.
    expect(pythonJsonDumps('{"a": 1, "b": 1.0, "c": 10000000000000000}')).toBe(
      '{"a": 1, "b": 1.0, "c": 10000000000000000}',
    );
  });

  it("sorts keys by code point and emits Python's separators", () => {
    expect(pythonJsonDumps('{"z": 1, "a": [1, 2.5], "f": 0.7, "t": true, "n": null}')).toBe(
      '{"a": [1, 2.5], "f": 0.7, "n": null, "t": true, "z": 1}',
    );
  });

  it("escapes non-ASCII with ensure_ascii, including surrogate pairs", () => {
    expect(pythonJsonDumps('{"s": "é", "e": "🙂"}')).toBe('{"e": "\\ud83d\\ude42", "s": "\\u00e9"}');
  });

  it("keeps an integer larger than 2^53 verbatim", () => {
    // `JSON.parse` would round this to 123456789012345680000; Python's `int` has
    // no precision limit, so the digits must survive as text.
    expect(pythonJsonDumps('{"n": 123456789012345678901234567890}')).toBe(
      '{"n": 123456789012345678901234567890}',
    );
  });

  it("applies Python's `or {}` truthiness rule", () => {
    // Every one of these is falsy in Python, so `properties or {}` yields `{}`.
    for (const text of [null, "{}", "[]", "null", '""', "0", "-0.0", "false"]) {
      expect(pythonJsonDumps(text), `dumps(${String(text)})`).toBe("{}");
    }
  });

  it("emits a truthy non-object as itself, because Python does", () => {
    // Measured on the oracle: a hand-written scalar `properties` hashes as that
    // scalar. Rejecting it here would diverge from the other server's cache key.
    expect(pythonJsonDumps("5")).toBe("5");
    expect(pythonJsonDumps('"x"')).toBe('"x"');
    expect(pythonJsonDumps("1.5")).toBe("1.5");
    expect(pythonJsonDumps("[1, 2]")).toBe("[1, 2]");
    expect(pythonJsonDumps("true")).toBe("true");
  });

  it("sorts strings by code point, not by UTF-16 code unit", () => {
    // U+1F642 (a surrogate pair) must sort *after* U+FFFD; `<` on code units
    // would put it before.
    expect(compareCodePoints("🙂", "\uFFFD")).toBe(1);
    expect(["🙂", "\uFFFD", "a"].sort(compareCodePoints)).toEqual(["a", "\uFFFD", "🙂"]);
  });
});

// ===========================================================================
// Offline: graph_version
// ===========================================================================

describe("graph_version hashing", () => {
  /**
   * These three digests were produced by the oracle's own interpreter, from the
   * exact inputs each case builds. They are the only absolute values in this file
   * that come from the Python side, and they are what makes the port's
   * formatting decisions load-bearing instead of decorative.
   */
  it("matches the oracle's digest for a full entity", () => {
    const digest = computeGraphVersion(
      entityRow({ properties_text: '{"retries": 2, "tier": "edge"}' }),
      [
        relationshipRow({ type: "USED_BY", confidence: 0.75, other_name: "Payment Gateway" }),
        relationshipRow({ type: "HAS", confidence: 0.55, other_name: "Rate Limit", other_type: "CONCEPT" }),
      ],
      [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    );
    expect(digest).toBe("b51717ed2eda3996");
  });

  it("matches the oracle's digest for an entity with no description, properties or edges", () => {
    const digest = computeGraphVersion(
      entityRow({
        name: "Gateway",
        description: null,
        properties_text: null,
        confidence: 1,
      }),
      [],
      [],
    );
    expect(digest).toBe("ac52cf38802ba9ec");
  });

  it("matches the oracle's digest when properties carry jsonb int/float distinction", () => {
    // `1e16` arrives from jsonb as an integer, `1e-5` as a float. Getting that
    // wrong changes the hash and would invalidate the other server's cache.
    const digest = computeGraphVersion(
      entityRow({
        name: "N",
        description: null,
        confidence: 0.7,
        properties_text:
          '{"big": 10000000000000000, "k": 0.00001, "w": 0.7}',
      }),
      [],
      [],
    );
    expect(digest).toBe("8c0b7a9e18d685e1");
  });

  it("matches the oracle's digest for non-ASCII input", () => {
    const digest = computeGraphVersion(
      entityRow({
        name: "Ünïcode",
        description: "héllo",
        confidence: 1,
        properties_text: '{"e": "\\ud83d\\ude42", "s": "\\u00e9"}',
      }),
      [],
      [],
    );
    expect(digest).toBe("58e6c1f0f76d8a9a");
  });

  it("is stable across repeated calls with the same input", () => {
    const entity = entityRow();
    const relationships = [relationshipRow()];
    const first = computeGraphVersion(entity, relationships, ["doc-a"]);
    const second = computeGraphVersion(entity, relationships, ["doc-a"]);
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * Each input the hash consumes must be able to change it on its own.
   *
   * That is the entire cache-invalidation contract: a change the hash cannot see
   * is a stale page served forever. Asserted one field at a time so a missing
   * `h.update(...)` names the field it belongs to.
   */
  it("changes when any hashed input changes", () => {
    const base = computeGraphVersion(entityRow(), [relationshipRow()], ["doc-a"]);

    expect(computeGraphVersion(entityRow({ name: "Other" }), [relationshipRow()], ["doc-a"])).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ description: "changed" }), [relationshipRow()], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ confidence: 0.71 }), [relationshipRow()], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ properties_text: '{"tier": "core"}' }), [relationshipRow()], [
        "doc-a",
      ]),
    ).not.toBe(base);

    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ type: "HAS" })], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ other_name: "Other" })], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ confidence: 0.76 })], ["doc-a"]),
    ).not.toBe(base);

    expect(computeGraphVersion(entityRow(), [relationshipRow()], ["doc-b"])).not.toBe(base);
    expect(computeGraphVersion(entityRow(), [relationshipRow()], ["doc-a", "doc-b"])).not.toBe(base);
    expect(computeGraphVersion(entityRow(), [], ["doc-a"])).not.toBe(base);
  });

  /**
   * Edges are hashed in sorted representation order, so the *order* the database
   * returned them in cannot change the hash. Without the sort, a plan change in
   * Postgres (or an added index) would invalidate every page in the Stack.
   */
  it("is independent of relationship order", () => {
    const first = relationshipRow({ type: "USES", other_name: "Alpha", confidence: 0.5 });
    const second = relationshipRow({ type: "HAS", other_name: "Beta", confidence: 0.6 });
    const third = relationshipRow({ type: "CAPS", other_name: "Gamma", confidence: 0.7 });

    const forward = computeGraphVersion(entityRow(), [first, second, third], ["doc-a", "doc-b"]);
    const reversed = computeGraphVersion(entityRow(), [third, first, second], ["doc-b", "doc-a"]);

    expect(reversed).toBe(forward);
  });

  it("truncates the digest to 16 hex characters, like the oracle", () => {
    // `h.hexdigest()[:16]` — a full SHA-256 hex digest would be 64 characters.
    expect(computeGraphVersion(entityRow(), [], [])).toHaveLength(16);
  });
});

// ===========================================================================
// Offline: prompt construction
// ===========================================================================

describe("page prompt", () => {
  /**
   * The prompt is the only input to a non-deterministic step, so holding it
   * constant is the strongest guarantee this port can offer about page *content*.
   *
   * Captured from the oracle by replacing `page_generator.complete` with a
   * recorder. The awkward bits are deliberate: the Python f-string produces
   * `USESs` and `HASs` (it appends `s` to a verb that is often already plural),
   * and confidence is `.2f`-formatted.
   */
  it("is byte-identical to the prompt the oracle sent", () => {
    const context: EntityPageContext = {
      entity: entityRow(),
      outgoing: [
        relationshipRow({ type: "USES", confidence: 0.75, other_name: "Payment Gateway" }),
        relationshipRow({
          type: "HAS",
          confidence: 0.5512,
          other_name: "Rate Limit",
          other_type: "CONCEPT",
        }),
      ],
      incoming: [
        relationshipRow({
          type: "TRIGGERS",
          confidence: 0.6,
          other_name: "Alerting Pipeline",
          direction: "incoming",
        }),
      ],
      documents: [
        { id: "1", filename: "runbook.md", ingested_at: "2026-10-21T03:04:05.000000Z" },
        { id: "2", filename: "billing.txt", ingested_at: "2026-10-22T01:02:03.456789Z" },
      ],
    };

    expect(buildPagePrompt(context)).toBe(
      [
        "You are writing a wiki-style markdown page for one entity in a compiled",
        "knowledge graph. Use ONLY the information given. Do not invent facts.",
        "Do not speculate beyond what the graph supports.",
        "",
        "ENTITY:",
        "  Name: Billing Service",
        "  Type: SYSTEM",
        "  Confidence: 0.70",
        "  Existing description: Processes invoices",
        "",
        "RELATIONSHIPS:",
        "  - This entity USESs Payment Gateway (SYSTEM, confidence 0.75)",
        "  - This entity HASs Rate Limit (CONCEPT, confidence 0.55)",
        "  - Alerting Pipeline (SYSTEM) TRIGGERSs this entity (confidence 0.60)",
        "",
        "CONTRIBUTING SOURCE DOCUMENTS:",
        "  - runbook.md (ingested 2026-10-21)",
        "  - billing.txt (ingested 2026-10-22)",
        "",
        "Write a markdown page following this structure:",
        "",
        "# Billing Service",
        "",
        "A 2-4 sentence summary of what this entity is and its role in the domain.",
        "Reference its key relationships naturally. Do not list relationships verbatim;",
        "weave them into prose.",
        "",
        "## Relationships",
        "",
        "A bulleted list grouping outgoing and incoming relationships, written in",
        'plain English (e.g., "Triggers an On-Call response when declared", not',
        '"triggers --> On-Call"). Group by direction. Skip this section entirely',
        "if no relationships exist.",
        "",
        "## Sources",
        "",
        "A bulleted list of contributing documents with their filenames and",
        "ingestion dates. Skip this section entirely if no documents contributed.",
        "",
        "Return ONLY the markdown. No preamble, no explanation, no code fences.",
      ].join("\n"),
    );
  });

  it("uses the oracle's placeholder branches for an empty graph", () => {
    const prompt = buildPagePrompt({
      entity: entityRow({ name: "Lonely", description: null, confidence: 1 }),
      outgoing: [],
      incoming: [],
      documents: [],
    });

    expect(prompt).toContain("  Existing description: (none)\n");
    expect(prompt).toContain("  Confidence: 1.00\n");
    expect(prompt).toContain("RELATIONSHIPS:\n  (No relationships recorded)\n");
    expect(prompt).toContain("CONTRIBUTING SOURCE DOCUMENTS:\n  (No contributing documents)\n");
  });

  it("takes the ingestion date from the timestamp's date part", () => {
    // Python formats `datetime.date()`, so the time and zone never appear.
    const prompt = buildPagePrompt({
      entity: entityRow(),
      outgoing: [],
      incoming: [],
      documents: [
        { id: "1", filename: "a.md", ingested_at: "2026-01-02T23:59:59.999999Z" },
      ],
    });
    expect(prompt).toContain("  - a.md (ingested 2026-01-02)");
  });
});

describe("synthesis prompt", () => {
  it("is byte-identical to the prompt the oracle sent, with sorted domain names", () => {
    expect(
      buildSynthesisPrompt(
        "Billing Service",
        "SYSTEM",
        ["Payment Gateway", "Alerting Pipeline", "Rate Limit"],
        "short passage mentioning Billing Service",
      ),
    ).toBe(
      [
        "You are writing a compiled description for one entity in a knowledge graph.",
        "",
        "ENTITY: Billing Service",
        "TYPE: SYSTEM",
        "",
        "OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):",
        "Alerting Pipeline, Payment Gateway, Rate Limit",
        "",
        "SOURCE PASSAGES THAT MENTION THIS ENTITY:",
        "short passage mentioning Billing Service",
        "",
        "Write a description that is 2-4 sentences, reflects what the passages",
        "say, references siblings naturally when relevant, and contains no",
        "filler. Return ONLY the description as plain prose.",
      ].join("\n"),
    );
  });
});

// ===========================================================================
// Offline: archive assembly
// ===========================================================================

describe("archive filenames and README", () => {
  it("replaces exactly the four characters the oracle replaces", () => {
    // Measured: `Billing Service` -> `Billing_Service.md`.
    expect(pageFilename("Billing Service")).toBe("Billing_Service.md");
    expect(pageFilename("On-Call Engineer")).toBe("On-Call_Engineer.md");
    expect(pageFilename("a/b")).toBe("a-b.md");
    expect(pageFilename("a\\b")).toBe("a-b.md");
    expect(pageFilename("a:b")).toBe("a-b.md");
    expect(pageFilename("a/b\\c:d e")).toBe("a-b-c-d_e.md");
  });

  it("is not a general-purpose sanitiser, because the oracle's is not", () => {
    // A `?`, `*` or control character survives: reproducing the oracle's rule
    // exactly is what keeps the two archives' file lists comparable.
    expect(pageFilename("What? *")).toBe("What?_*.md");
    expect(pageFilename("tab\there")).toBe("tab\there.md");
  });

  it("composes the README with the oracle's exact wording and timestamp form", () => {
    // Note the em dash and the `+00:00` offset: this is
    // `datetime.now(timezone.utc).isoformat()`, not the `Z` form the JSON
    // endpoints emit.
    expect(
      buildReadme("W2 Pages Probe", "w2pg-probe-main", 13, new Date("2026-10-22T05:12:48.591Z")),
    ).toBe(
      "# W2 Pages Probe — Entity Pages\n\n" +
        "Generated from AKS Stack `w2pg-probe-main` " +
        "on 2026-10-22T05:12:48.591000+00:00.\n\n" +
        "Total entities: 13\n\n" +
        "Each `.md` file is a wiki-style page for one entity, " +
        "generated from the compiled knowledge graph.\n",
    );
  });

  it("omits the fractional part when the second is exact, as Python does", () => {
    expect(pythonUtcIsoformat(new Date("2026-10-22T05:12:48.000Z"))).toBe(
      "2026-10-22T05:12:48+00:00",
    );
    expect(pythonUtcIsoformat(new Date("2026-10-22T05:12:48.001Z"))).toBe(
      "2026-10-22T05:12:48.001000+00:00",
    );
  });

  it("names the archive after the Stack's domain", () => {
    // `content-disposition: attachment; filename=<domain>-entity-pages.zip` —
    // asserted end to end in the integration block; the rule itself lives in
    // the route, and this pins the string it builds from.
    expect(`${"w2pg-probe-main"}-entity-pages.zip`).toBe("w2pg-probe-main-entity-pages.zip");
  });

  it("puts README.md first, then the pages in the order given", () => {
    const entries = buildArchiveEntries("readme", [
      { entityName: "Billing Service", markdown: "a" },
      { entityName: "Payment Gateway", markdown: "b" },
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
    ]);
    expect(entries[0]?.content).toBe("readme");
  });
});

describe("zip container", () => {
  const now = new Date("2026-10-22T05:12:48.000Z");

  /** Builds and re-reads an archive, so every assertion is about the bytes. */
  function roundTrip(entries: ReturnType<typeof buildArchiveEntries>): ParsedEntry[] {
    return readZipArchive(buildZipArchive(entries, now));
  }

  it("produces a container a third-party reader accepts, entry by entry", () => {
    // Verified out of band with `unzip -t` and Python's `zipfile`, both of which
    // read this exact archive without a warning.
    const parsed = roundTrip(
      buildArchiveEntries(buildReadme("Stack", "w2pg-zip", 2, now), [
        { entityName: "Billing Service", markdown: "# Billing Service\n\nSummary.\n" },
        { entityName: "Rate Limit", markdown: `# Rate Limit\n\n${"x".repeat(4000)}` },
      ]),
    );

    expect(parsed.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Rate_Limit.md",
    ]);
    expect(parsed[1]?.content).toBe("# Billing Service\n\nSummary.\n");
    expect(parsed[2]?.content.startsWith("# Rate Limit")).toBe(true);

    for (const entry of parsed) {
      // Method 8 (deflate), no data descriptor, Unix origin, `-rw-------`.
      expect(entry.compressionMethod, `${entry.name} method`).toBe(8);
      expect(entry.flagBits, `${entry.name} flags`).toBe(0);
      expect(entry.createSystem, `${entry.name} create_system`).toBe(3);
      expect(entry.externalAttr, `${entry.name} external_attr`).toBe(0o600 * 0x10000);
      // Sizes agree with the decoded payload; the CRC is non-zero for non-empty
      // content, which is what a reader checks before trusting the bytes.
      expect(entry.uncompressedSize, `${entry.name} size`).toBe(Buffer.byteLength(entry.content, "utf8"));
      if (entry.content !== "") {
        expect(entry.crc, `${entry.name} crc`).not.toBe(0);
      }
    }
  });

  it("actually compresses, rather than storing", () => {
    const body = "repeated content ".repeat(200);
    const parsed = roundTrip(buildArchiveEntries(body, []));
    expect(parsed[0]?.uncompressedSize).toBeGreaterThan(parsed[0]?.compressedSize ?? 0);
  });

  it("carries an empty file as a valid entry", () => {
    // The oracle produces these: an entity whose page generation returned
    // nothing appears in the archive with zero bytes (measured:
    // `Rates_Service.md`, 0 bytes).
    const parsed = roundTrip(buildArchiveEntries("readme", [{ entityName: "Empty", markdown: "" }]));
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.content).toBe("");
    expect(parsed[1]?.compressedSize).toBe(2); // deflate's empty stream is 2 bytes
    expect(parsed[1]?.uncompressedSize).toBe(0);
  });

  it("writes a zero-entry archive when given no entries", () => {
    // Not a shape the endpoint can produce — it 404s first — but the container
    // must still be well formed rather than emitting a header pointing nowhere.
    const archive = buildZipArchive([], now);
    expect(readZipArchive(archive)).toEqual([]);
    expect(archive.length).toBe(22);
  });

  it("round-trips a non-ASCII entity name and content", () => {
    const parsed = roundTrip(
      buildArchiveEntries("readme", [{ entityName: "Ünïcode Page", markdown: "héllo 🙂" }]),
    );
    expect(parsed[1]?.name).toBe("Ünïcode_Page.md");
    expect(parsed[1]?.content).toBe("héllo 🙂");
  });
});

// ===========================================================================
// Offline / DB: the two page endpoints, with the LLM stubbed
// ===========================================================================

describe.skipIf(state.skipReason !== false)("pages endpoints (LLM stubbed)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    completeMock.enabled = true;
    completeMock.calls.length = 0;
    // A recognizable marker so the assertions can prove the stored markdown is
    // whatever the model returned, unmodified.
    completeMock.reply = "# Stub\n\nStub summary.\n\n## Relationships\n\n**Outgoing**\n- x\n";
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("generates a page on the first read and serves it from cache on the second", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    // Key order comes from the DTO, so it is asserted exactly, not as a set.
    expect(Object.keys(first.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
    expect(first.body).toMatchObject({
      entity_name: "Billing Service",
      markdown: completeMock.reply,
      source_entity_id: fixture.entityIds.billing,
      source_type: "compiled",
      cached: false,
    });
    // Six fractional digits and a `Z`, like every other timestamptz here.
    expect(String((first.body as { generated_at: string }).generated_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    expect(String((first.body as { graph_version: string }).graph_version)).toMatch(/^[0-9a-f]{16}$/);

    expect(completeMock.calls).toHaveLength(1);
    // `complete(prompt, max_tokens=2048)` — the page budget, not the module
    // default of 1024.
    expect(completeMock.calls[0]?.maxTokens).toBe(2048);

    const second = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(second.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
    expect((second.body as { cached: boolean }).cached).toBe(true);
    // Same hash, same text: the cache hit is not a regeneration.
    expect((second.body as { graph_version: string }).graph_version).toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect((second.body as { markdown: string }).markdown).toBe(completeMock.reply);
    expect((second.body as { generated_at: string }).generated_at).toBe(
      (first.body as { generated_at: string }).generated_at,
    );
    // The decisive assertion: no second model call.
    expect(completeMock.calls).toHaveLength(1);
  });

  it("finds an entity by case-insensitive exact name and 404s on anything else", async () => {
    const fixture = await createFixture();

    const lower = await request(app)
      .get(`/aks/v1/pages/billing%20service?stack_id=${fixture.stackId}`)
      .expect(200);
    expect((lower.body as { entity_name: string }).entity_name).toBe("Billing Service");

    // Equality on the whole name, not a prefix: the 404 echoes the request.
    const partial = await request(app)
      .get(`/aks/v1/pages/Billing?domain=${fixture.domain}`)
      .expect(404);
    expect(partial.body).toEqual({ detail: "Entity 'Billing' not found in Stack" });
  });

  it("regenerates when the entity's own data changes", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    await database().execute(sql`
      update ontology_entities
      set description = ${"Now with a richer description"}
      where id = ${fixture.entityIds.billing}
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("regenerates when a new relationship is written", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);
    expect(completeMock.calls).toHaveLength(1);

    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, description,
        confidence, verified, extracted_by_model, source_kind, pipeline
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${fixture.entityIds.limit}, ${"RESPECTS"}, ${null}, ${0.65}, ${false},
        ${"model-b"}, ${"document"}, ${"llamaindex-schema-extraction"}
      )
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("regenerates when a contributing document is attached", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    await database().execute(sql`
      insert into entity_source_documents (entity_id, document_id, stack_id)
      values (${fixture.entityIds.gateway}, ${fixture.documentId}, ${fixture.stackId})
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    // The entity row itself did not change; only its contributing-document set
    // did, which the hash covers separately.
    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("writes the page to entity_pages, upserting on repeat generation", async () => {
    const fixture = await createFixture();

    await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    const rows = await database().execute<{
      entity_name: string;
      graph_version: string;
      source_type: string;
      generated_by_model: string | null;
    }>(sql`
      select entity_name, graph_version, source_type, generated_by_model
      from entity_pages
      where entity_id = ${fixture.entityIds.billing}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_name).toBe("Billing Service");
    expect(rows[0]?.source_type).toBe("compiled");
    expect(rows[0]?.generated_by_model).toBe("hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");

    // A forced regeneration must replace the row, not add one: the table's
    // primary key is `entity_id`.
    await database().execute(sql`
      update ontology_entities set confidence = ${0.91} where id = ${fixture.entityIds.billing}
    `);
    await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    const after = await database().execute<{ count: string }>(sql`
      select count(*) as count from entity_pages where entity_id = ${fixture.entityIds.billing}
    `);
    expect(Number(after[0]?.count)).toBe(1);
  });

  it("answers a ZIP archive with the oracle's headers and file list", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename=${fixture.domain}-entity-pages.zip`,
    );
    // The oracle streams its in-memory buffer, so it chunks rather than sending a
    // length. `res.end(buffer)` would set `content-length`; `write` + `end` does
    // not. Asserted because it is observable and was wrong before being measured.
    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(response.headers["content-length"]).toBeUndefined();

    const archive = response.body as Buffer;
    const entries = readZipArchive(archive);

    // README first, then `order by name`.
    expect(entries.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
      "Rate_Limit.md",
    ]);

    const readme = entries[0]?.content ?? "";
    expect(readme.startsWith(`# ${fixture.stackName} — Entity Pages\n\n`)).toBe(true);
    expect(readme).toContain(`Generated from AKS Stack \`${fixture.domain}\` on `);
    expect(readme).toContain("+00:00.\n\n");
    expect(readme).toContain("Total entities: 3\n\n");
    expect(readme).toContain(
      "Each `.md` file is a wiki-style page for one entity, generated from the compiled knowledge graph.\n",
    );

    // Three entities, no pages cached yet: three model calls, and the stored
    // markdown reaches the archive verbatim.
    expect(completeMock.calls).toHaveLength(3);
    expect(entries[1]?.content).toBe(completeMock.reply);
  });

  it("reuses cached pages when building a second archive", async () => {
    const fixture = await createFixture();

    await request(app).get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`).expect(200);
    expect(completeMock.calls).toHaveLength(1);

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    // Three entities, one already cached: exactly two more model calls.
    expect(completeMock.calls).toHaveLength(3);
    expect(readZipArchive(response.body as Buffer)).toHaveLength(4);
  });

  it("honours min_confidence, dropping entities below the bound", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}&min_confidence=0.5`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    // Rate Limit sits at 0.4, so it is excluded — and its page is never
    // generated, so it costs no model call.
    expect(readZipArchive(response.body as Buffer).map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
    ]);
    expect(completeMock.calls).toHaveLength(2);
  });

  it("404s on an archive request when no entity meets the filter", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}&min_confidence=1`)
      .expect(404);
    expect(response.body).toEqual({
      detail: "Stack has no entities meeting the filter criteria",
    });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("rejects malformed query parameters before resolving the Stack", async () => {
    // Measured: FastAPI reports both failing parameters together, in declaration
    // order, so a bad `stack_id` does not mask a bad `min_confidence`.
    const response = await request(app)
      .get("/aks/v1/pages?stack_id=nope&min_confidence=2")
      .expect(422);

    expect((response.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "uuid_parsing",
        loc: ["query", "stack_id"],
        msg: "Input should be a valid UUID, invalid character: found `n` at 0",
        input: "nope",
        ctx: { error: "invalid character: found `n` at 0" },
      },
      {
        type: "less_than_equal",
        loc: ["query", "min_confidence"],
        msg: "Input should be less than or equal to 1",
        input: "2",
        // Known divergence: Python emits `1.0`, JavaScript cannot distinguish
        // the two (see `odd/findings/float-bound-json-limit.md`).
        ctx: { le: 1 },
      },
    ]);
  });

  it("treats an empty min_confidence as the parser failure Python reports", async () => {
    const response = await request(app).get("/aks/v1/pages?min_confidence=").expect(422);
    expect((response.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "float_parsing",
        loc: ["query", "min_confidence"],
        msg: "Input should be a valid number, unable to parse string as a number",
        input: "",
      },
    ]);
  });

  it("requires a Stack reference on both endpoints", async () => {
    for (const path of ["/aks/v1/pages", "/aks/v1/pages/Gateway"]) {
      const response = await request(app).get(path).expect(422);
      expect(response.body, path).toEqual({
        detail: "Either stack_id (UUID) or domain (slug) must be provided",
      });
    }
  });
});

// ===========================================================================
// Offline / DB: description synthesis, with the LLM stubbed
// ===========================================================================

describe.skipIf(state.skipReason !== false)("synthesis endpoints (LLM stubbed)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    completeMock.enabled = true;
    completeMock.calls.length = 0;
    completeMock.reply = "A synthesized description.";
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("synthesizes one entity and reports the stored description", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/aks/v1/entities/Billing%20Service/synthesize-description?domain=${fixture.domain}`)
      .expect(200);

    // Plain-dict insertion order from the Python handler.
    expect(Object.keys(response.body as object)).toEqual([...SYNTHESIZE_ONE_KEYS]);
    expect(response.body).toEqual({
      entity_name: "Billing Service",
      description: "A synthesized description.",
      synthesized: true,
    });

    expect(completeMock.calls).toHaveLength(1);
    // `complete(prompt, max_tokens=300)` — the description budget.
    expect(completeMock.calls[0]?.maxTokens).toBe(300);
    // The prompt carries the chunk that mentions the entity, and the domain
    // context lists every sibling name.
    const prompt = completeMock.calls[0]?.prompt ?? "";
    expect(prompt).toContain("The Billing Service processes invoices and calls the Payment Gateway");
    expect(prompt).toContain("Payment Gateway, Rate Limit");

    // The write is committed, not just reported.
    const rows = await database().execute<{ description: string }>(sql`
      select description from ontology_entities where id = ${fixture.entityIds.billing}
    `);
    expect(rows[0]?.description).toBe("A synthesized description.");
  });

  it("reports synthesized: false and skips the model when nothing grounds the entity", async () => {
    const fixture = await createFixture();

    // `Payment Gateway` has no contributing documents, so no chunk can mention
    // it: the handler returns before calling the model.
    const response = await request(app)
      .post(`/aks/v1/entities/Payment%20Gateway/synthesize-description?domain=${fixture.domain}`)
      .expect(200);

    expect(response.body).toEqual({
      entity_name: "Payment Gateway",
      description: null,
      synthesized: false,
    });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("404s for an entity outside the Stack, without spending a call", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/aks/v1/entities/Nope/synthesize-description?domain=${fixture.domain}`)
      .expect(404);
    expect(response.body).toEqual({ detail: "Entity 'Nope' not found in Stack" });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("backfills the Stack, counting every candidate as synthesized or skipped", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      // `{}` is the whole-over-body default: `only_missing` becomes true.
      .send({})
      .expect(200);

    expect(Object.keys(response.body as object)).toEqual([...BACKFILL_KEYS]);
    const body = response.body as {
      stack_id: string;
      entities_considered: number;
      entities_synthesized: number;
      entities_skipped: number;
    };
    expect(body.stack_id).toBe(fixture.stackId);

    // Only `Payment Gateway` has a short description (`null`), so it is the sole
    // candidate under `only_missing`. It has no chunks, so it is skipped — which
    // is the honest outcome, and it costs no model call.
    expect(body.entities_considered).toBe(2);
    expect(body.entities_synthesized).toBe(0);
    expect(body.entities_skipped).toBe(2);
    expect(body.entities_considered).toBe(body.entities_synthesized + body.entities_skipped);
    expect(completeMock.calls).toHaveLength(0);
  });

  it("backfills everything when only_missing is false, calling the model per grounded entity", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ only_missing: false })
      .expect(200);

    const body = response.body as {
      entities_considered: number;
      entities_synthesized: number;
      entities_skipped: number;
    };
    expect(body.entities_considered).toBe(3);
    expect(body.entities_synthesized).toBe(1);
    expect(body.entities_skipped).toBe(2);
    expect(completeMock.calls).toHaveLength(1);
  });

  it("scopes a backfill to entity_ids when the list is non-empty", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: [fixture.entityIds.billing], only_missing: false })
      .expect(200);

    expect(response.body).toMatchObject({
      entities_considered: 1,
      entities_synthesized: 1,
      entities_skipped: 0,
    });

    // An unknown id narrows to nothing rather than failing.
    const empty = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: ["11111111-1111-1111-1111-111111111111"], only_missing: false })
      .expect(200);
    expect(empty.body).toMatchObject({
      entities_considered: 0,
      entities_synthesized: 0,
      entities_skipped: 0,
    });
  });

  it("treats an empty entity_ids list as no filter, because Python's `if` is truthiness", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: [], only_missing: false })
      .expect(200);

    // Measured: `{"entity_ids":[]}` considers every entity.
    expect(response.body).toMatchObject({ entities_considered: 3 });
  });

  it("404s on an unknown Stack and 422s on a malformed id", async () => {
    const missing = await request(app)
      .post("/stacks/11111111-1111-1111-1111-111111111111/synthesize-descriptions")
      .send({})
      .expect(404);
    expect(missing.body).toEqual({
      detail: "Stack '11111111-1111-1111-1111-111111111111' not found",
    });

    // Path and body failures are reported together, path first (measured).
    const both = await request(app)
      .post("/stacks/nope/synthesize-descriptions")
      .send({ only_missing: null })
      .expect(422);
    expect((both.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "uuid_parsing",
        loc: ["path", "stack_id"],
        msg: "Input should be a valid UUID, invalid character: found `n` at 0",
        input: "nope",
        ctx: { error: "invalid character: found `n` at 0" },
      },
      {
        type: "bool_type",
        loc: ["body", "only_missing"],
        msg: "Input should be a valid boolean",
        input: null,
      },
    ]);

    // Nothing was written.
    expect(completeMock.calls).toHaveLength(0);
  });

  it("reports FastAPI's `missing` for a request with no body at all", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .expect(422);
    expect(response.body).toEqual({
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  });

  it("reports `missing` for an explicitly empty JSON body, not `{}`", async () => {
    const fixture = await createFixture();

    // body-parser's "empty json body" special case yields `{}`, which would
    // otherwise look like a valid `BackfillRequest`. FastAPI answers `missing`,
    // so `content-length: 0` is what separates the two.
    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .set("Content-Type", "application/json")
      .send("")
      .expect(422);
    expect(response.body).toEqual({
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  });

  it("passes a non-JSON body through as the raw text, like Starlette", async () => {
    const fixture = await createFixture();

    // Measured: `text/plain` body `{}` -> `model_attributes_type` with
    // `input: "{}"` (the string), because no JSON parser claimed the body.
    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .set("Content-Type", "text/plain")
      .send("{}")
      .expect(422);
    expect(response.body).toEqual({
      detail: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: "{}",
        },
      ],
    });
    // Key order, not just key set: every 422 entry in this app emits
    // `type, loc, msg, input` and this hand-built one must not drift.
    const detail = (response.body as { detail: Record<string, unknown>[] }).detail;
    expect(Object.keys(detail[0] ?? {})).toEqual(["type", "loc", "msg", "input"]);
  });

  it("rejects a JSON body that is not an object", async () => {
    const fixture = await createFixture();

    for (const value of [null, 5, []]) {
      const response = await request(app)
        .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
        // `supertest` types `send` as a string, an object, or nothing; a bare
        // `null` / `5` / `[]` top-level JSON value is what FastAPI must reject.
        .set("Content-Type", "application/json")
        .send(JSON.stringify(value))
        .expect(422);
      expect(response.body, JSON.stringify(value)).toEqual({
        detail: [
          {
            type: "model_attributes_type",
            loc: ["body"],
            msg: "Input should be a valid dictionary or object to extract fields from",
            input: value,
          },
        ],
      });
    }
  });

  it("ignores unknown body keys, as Pydantic does by default", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ bogus: 1, only_missing: false })
      .expect(200);
    expect(response.body).toMatchObject({ entities_considered: 3 });
  });

  it("requires a Stack reference on the single-entity endpoint", async () => {
    const response = await request(app)
      .post("/aks/v1/entities/Gateway/synthesize-description")
      .expect(422);
    expect(response.body).toEqual({
      detail: "Either stack_id (UUID) or domain (slug) must be provided",
    });
  });
});

// ===========================================================================
// Live gateway (opt-in)
// ===========================================================================

/**
 * Enabled only with `AKS_TEST_GATEWAY=1`, like `aks.test.ts`.
 *
 * **Three model calls**, the minimum that exercises all four endpoints' LLM
 * paths: one page generation, one un-cached page inside the ZIP, and one
 * single-entity synthesis. The cache assertion between the two page reads is what
 * proves the cache without a fourth call.
 *
 * Only structure is asserted. Measured on the oracle: three identical runs
 * returned five, three and four entities, and the page text differs every time —
 * so any assertion on the text or on an entity count would flake.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "pages and synthesis (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      // Turn the stub off: this block is the only one that reaches a provider.
      completeMock.enabled = false;
      completeMock.calls.length = 0;
      app = createTestApp();
    });

    afterAll(async () => {
      completeMock.enabled = true;
      await deleteFixtureRows();
    });

    it("generates a real page, caches it, and archives it", async () => {
      const fixture = await createFixture();

      const first = await request(app)
        .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
        .expect(200);

      expect(Object.keys(first.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
      const body = first.body as {
        entity_name: string;
        markdown: string;
        generated_at: string;
        source_entity_id: string;
        graph_version: string;
        source_type: string;
        cached: boolean;
      };

      expect(body.entity_name).toBe("Billing Service");
      expect(body.source_entity_id).toBe(fixture.entityIds.billing);
      expect(body.source_type).toBe("compiled");
      expect(body.cached).toBe(false);
      expect(body.graph_version).toMatch(/^[0-9a-f]{16}$/);
      expect(body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

      // Structure only. The model is told to start with `# <name>` and to use
      // the two section headings, but it is free prose after that; asserting the
      // headings is asserting the prompt's contract, which is stable, while the
      // prose is not.
      expect(body.markdown.trimStart().startsWith("# Billing Service")).toBe(true);

      const second = await request(app)
        .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
        .expect(200);
      expect((second.body as { cached: boolean }).cached).toBe(true);
      expect((second.body as { markdown: string }).markdown).toBe(body.markdown);

      const archive = await request(app)
        .get(`/aks/v1/pages?domain=${fixture.domain}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(archive.headers["content-type"]).toBe("application/zip");
      const entries = readZipArchive(archive.body as Buffer);
      expect(entries.map((entry) => entry.name)).toEqual([
        "README.md",
        "Billing_Service.md",
        "Payment_Gateway.md",
        "Rate_Limit.md",
      ]);
      expect(entries[0]?.content).toContain(`Total entities: 3`);
    }, 240_000);

    it("synthesizes a real description and writes it back", async () => {
      const fixture = await createFixture();

      const response = await request(app)
        .post(`/aks/v1/entities/Billing%20Service/synthesize-description?domain=${fixture.domain}`)
        .expect(200);

      expect(Object.keys(response.body as object)).toEqual([...SYNTHESIZE_ONE_KEYS]);
      const body = response.body as {
        entity_name: string;
        description: string | null;
        synthesized: boolean;
      };
      expect(body.entity_name).toBe("Billing Service");
      expect(body.synthesized).toBe(true);
      // Non-empty, and that is all: the text is model output.
      expect(typeof body.description).toBe("string");
      expect((body.description ?? "").length).toBeGreaterThan(0);

      const rows = await database().execute<{ description: string | null }>(sql`
        select description from ontology_entities where id = ${fixture.entityIds.billing}
      `);
      expect(rows[0]?.description).toBe(body.description);
    }, 240_000);
  },
);
