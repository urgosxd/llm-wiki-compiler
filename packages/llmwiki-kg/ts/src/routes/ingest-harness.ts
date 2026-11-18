/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-harness.ts
 * @description Shared pool setup, fixtures and app builder for the split `routes/ingest-*` test files.
 *
 * The `vi.hoisted` provider configuration stays in each test file: it must run
 * before `../config.js` is imported, which a helper module cannot guarantee.
 *
 * ## Why "no database" throws here
 *
 * Every `describe.skipIf` in this file reads `state.skipReason`, so an unreachable database used to
 * produce a fully SKIPPED, fully GREEN file. The probe below now throws through
 * `../testing/no-database.js` (`rootDir: "src"` puts the root fixture above this package, TS6059),
 * which closes the single opt-out and the pinned image in one shared place.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import express from "express";
import type { Express } from "express";
import type { Sql } from "postgres";
import { vi } from "vitest";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import {
  createClient,
  createDatabase,
  createRequestTransactionWrapper,
  createTransactionRunner,
} from "../db.js";
import type { Database } from "../db.js";
import { noDatabase } from "../testing/no-database.js";
import { perRunDatabase } from "../testing/per-run-database.js";
import { createIngestRouter } from "./ingest.js";
import type { IngestRouterDependencies } from "./ingest.js";
import { withFixtureTenant } from "./fixture-tenant.js";

/**
 * The SERVER this process's own database is provisioned on.
 *
 * `AKS_TEST_DATABASE_URL` (or the resolver's `LLMWIKI_TEST_DATABASE_URL`, which CI
 * sets) names only the server now; the database itself is created per test process by
 * `../testing/per-run-database.js`, so two concurrent suites cannot see or delete each
 * other's rows.
 */
export const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** This process's own database, or the error that stopped it from being created. */
const SUITE = await perRunDatabase(TEST_SERVER_URL).catch((error: unknown) =>
  error instanceof Error ? error : new Error(String(error)),
);

/** The connection string this suite uses: this process's own database. */
export const TEST_DATABASE_URL = SUITE instanceof Error ? TEST_SERVER_URL : SUITE.url;

export const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Domain prefix every fixture Stack in the `ingest-*` suites carries.
 *
 * Each split test file sets its own suffix through {@link useDomainPrefix}. The
 * files run in parallel against one database and cleanup deletes by prefix, so a
 * shared prefix would let one file delete another's fixtures mid-test.
 */
let domainPrefix = "w2ex-ingest-";

/** Point the fixtures and the cleanup at this file's own domain namespace. */
export function useDomainPrefix(suffix: string): void {
  domainPrefix = `w2ex-ingest-${suffix}-`;
}

export const UNKNOWN_UUID = "11111111-1111-1111-1111-111111111111";

export const RESPONSE_KEYS = [
  "document_id",
  "chunks_created",
  "entities_extracted",
  "entities_in_stack",
  "relationships_extracted",
  "relationships_written",
  "relationships_in_stack",
  "truncated",
  "descriptions_synthesized",
] as const;

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

export const state: {
  client?: Sql;
  database?: Database;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  if (SUITE instanceof Error) {
    // Loud, never a silent pass and never a shared-database fallback.
    state.skipReason = noDatabase(
      "The ingest route suites need a Postgres database and none could be obtained.",
      `database unreachable at ${TEST_SERVER_URL}: could not create a per-run database (${SUITE.message})`,
    );
  } else {
    const candidate = createClient(SUITE.url, CONNECT_TIMEOUT_SECONDS);
    try {
      await candidate`select 1`;
      state.client = candidate;
      state.database = createDatabase(candidate);
      state.skipReason = false;
    } catch (error) {
      state.skipReason = noDatabase(
        "The ingest route suites need a Postgres database and none could be obtained.",
        `database unreachable at ${SUITE.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await candidate.end({ timeout: 1 }).catch(() => undefined);
    }
  }
}

if (state.skipReason !== false) {
  console.warn(`[ingest.test] skipping integration tests — ${state.skipReason}`);
}

export function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

export const writtenFiles = new Set<string>();

/**
 * Every Stack this file's fixtures created, so cleanup and counting can target each
 * one by id.
 *
 * ## Why a registry instead of the domain prefix
 *
 * Cleanup used to delete by `domain like '<prefix>%'`. Under RLS that cursor has no
 * single tenant and cannot be bound: measured as the unprivileged role, a prefix
 * delete bound to one domain removes that domain's row and silently leaves its
 * siblings, so it reports success while cleaning only part of what it selected.
 *
 * Tracking ids makes every statement single-tenant. `stacks` is deleted by id with
 * the tenant bound, and the seven child tables go with it through
 * `on delete cascade` — verified to fire under RLS — so no child delete is needed.
 */
const fixtureStacks = new Set<string>();

/** Registers a Stack for cleanup. Called by {@link createStack}. */
export function trackFixtureStack(stackId: string): void {
  fixtureStacks.add(stackId);
}

export async function deleteFixtureRows(): Promise<void> {
  for (const stackId of fixtureStacks) {
    await database().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
      await tx.execute(sql`delete from stacks where id = ${stackId}`);
    });
  }
  fixtureStacks.clear();
}

export async function countFixtureRows(): Promise<number> {
  // Counted one bound Stack at a time rather than with one prefix query. A single
  // query across several Stacks has no single tenant to bind, so it cannot see them
  // under RLS; looping keeps the summed semantics identical while every statement
  // stays single-tenant. Callers see the same number as before.
  let total = 0;
  for (const stackId of fixtureStacks) {
    total += await database().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
      const rows = await tx.execute<{ total: number }>(sql`
        select
          (select count(*) from document_chunks where stack_id = ${stackId})
          + (select count(*) from ontology_entities where stack_id = ${stackId})
          as total
      `);
      // The sum of two `count(*)` values is `numeric`, which postgres-js delivers as
      // a string; `Number` is the narrowing.
      const counted = rows[0]?.total;
      return counted === undefined ? -1 : Number(counted);
    });
  }
  return total;
}

/** What one Stack holds, so a refusal can be proved to have written nothing. */
export interface StackSnapshot {
  readonly chunks: number;
  readonly entities: number;
  readonly relationships: number;
  readonly evidence: number;
  readonly log: number;
  readonly documents: readonly { readonly id: string; readonly audit: unknown }[];
}

/**
 * Every tenant-scoped table whose stored content one compile can write.
 *
 * `entity_source_documents` is here because a SUCCESSFUL compile writes it — one row per
 * entity/document pair — while it was the one table a counts-only snapshot left out, so
 * the table most in need of a before/after proof had none.
 */
const FINGERPRINT_TABLES = [
  "document_chunks",
  "ontology_entities",
  "ontology_relationships",
  "kg_evidence",
  "kg_classification_log",
  "entity_source_documents",
] as const;

/** A fingerprinted table's name. */
type FingerprintTable = (typeof FINGERPRINT_TABLES)[number];

/** Every table the fingerprint reads, plus the document row whose `audit` it digests. */
type Fingerprinted = FingerprintTable | "stack_documents";

/** One table's stored state: how many rows, and a digest of every value in them. */
interface TableState {
  readonly rows: number;
  readonly digest: string;
}

/** Per-table content digests, keyed by the table they cover so a failure names it. */
export type StackDigests = Record<Fingerprinted, string>;

/**
 * What one Stack holds at CONTENT level, so "wrote nothing" is provable.
 *
 * The counts alone are not a proof. An `UPDATE` moves no count: bumping a `confidence`,
 * rewriting a chunk's `content`, or moving a `last_seen_at`/`updated_at` leaves every
 * `count(*)` and every document's `audit` blob exactly as they were, so a counts-only
 * snapshot passes over a write that really happened. `digests` closes that: one digest
 * per table over its ordered rows' full text, so a change in ANY column of ANY row fails.
 *
 * @see stackFingerprint
 */
export interface StackFingerprint extends StackSnapshot {
  /** Rows in `entity_source_documents`, which {@link StackSnapshot} does not count. */
  readonly sourceDocuments: number;
  readonly digests: StackDigests;
}

/**
 * The per-table count-and-digest query: one `union all` branch per fingerprinted table.
 *
 * Each branch digests `t::text` — the whole row, every column — over rows ordered by that
 * same text, so the digest is a pure function of the stored values and is stable across
 * runs. `stack_documents` digests `id` with its `audit` blob rather than the whole row:
 * the document's file metadata is written by upload, and the blob is the part a compile
 * rewrites.
 */
function statesSql(stackId: string) {
  return sql`
    select 'document_chunks' as table_name, count(*)::int as row_count,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as digest
      from document_chunks t where t.stack_id = ${stackId}
    union all
    select 'ontology_entities', count(*)::int,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
      from ontology_entities t where t.stack_id = ${stackId}
    union all
    select 'ontology_relationships', count(*)::int,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
      from ontology_relationships t where t.stack_id = ${stackId}
    union all
    select 'kg_evidence', count(*)::int,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
      from kg_evidence t where t.stack_id = ${stackId}
    union all
    select 'kg_classification_log', count(*)::int,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
      from kg_classification_log t where t.stack_id = ${stackId}
    union all
    select 'entity_source_documents', count(*)::int,
           coalesce(md5(string_agg(t::text, '|' order by t::text)), '')
      from entity_source_documents t where t.stack_id = ${stackId}
    union all
    select 'stack_documents', count(*)::int,
           coalesce(md5(string_agg(sd.id::text || ':' || coalesce(sd.audit::text, 'null'), '|' order by sd.id)), '')
      from stack_documents sd where sd.stack_id = ${stackId}
  `;
}

/**
 * Reads every fingerprinted table's row count and content digest in ONE round trip.
 *
 * A missing row is a failed read, not a zero — that is why the states are checked against
 * the declared table list instead of being defaulted.
 */
async function readTableStates(tx: Database, stackId: string): Promise<Record<Fingerprinted, TableState>> {
  const rows = await tx.execute<{ table_name: Fingerprinted; row_count: number; digest: string }>(
    statesSql(stackId),
  );
  const states = {} as Record<Fingerprinted, TableState>;
  for (const row of rows) {
    states[row.table_name] = { rows: row.row_count, digest: row.digest };
  }
  const missing = [...FINGERPRINT_TABLES, "stack_documents" as const].filter(
    (table) => states[table] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(`the stack fingerprint read returned no row for ${missing.join(", ")}`);
  }
  return states;
}

/**
 * Every row one Stack holds: per-table row counts, a digest of their content, and each
 * document's audit blob.
 *
 * This is the snapshot every refusal case asserts with `toEqual`, so "no entity, no
 * relationship, no chunk mutation, no audit row, no ledger write" are compared rather
 * than argued — and an `UPDATE` nobody asked for fails it.
 */
export async function stackFingerprint(stackId: string): Promise<StackFingerprint> {
  return withFixtureTenant(database(), { stackId }, async (tx) => {
    const states = await readTableStates(tx, stackId);
    const documents = await tx.execute<{ id: string; audit: unknown }>(sql`
      select id, audit from stack_documents where stack_id = ${stackId} order by id
    `);
    return {
      chunks: states.document_chunks.rows,
      entities: states.ontology_entities.rows,
      relationships: states.ontology_relationships.rows,
      evidence: states.kg_evidence.rows,
      log: states.kg_classification_log.rows,
      sourceDocuments: states.entity_source_documents.rows,
      digests: {
        document_chunks: states.document_chunks.digest,
        ontology_entities: states.ontology_entities.digest,
        ontology_relationships: states.ontology_relationships.digest,
        kg_evidence: states.kg_evidence.digest,
        kg_classification_log: states.kg_classification_log.digest,
        entity_source_documents: states.entity_source_documents.digest,
        stack_documents: states.stack_documents.digest,
      },
      documents,
    };
  });
}

/**
 * The counts-only projection of {@link stackFingerprint}, kept for the one suite that
 * pins its literal shape (`compile-route.test.ts`) and for the ingest suites that only
 * need counts.
 *
 * Derived from the fingerprint rather than read again, so the SQL above is the single
 * definition of what "this Stack's stored state" means.
 */
export async function stackSnapshot(stackId: string): Promise<StackSnapshot> {
  const { chunks, entities, relationships, evidence, log, documents } =
    await stackFingerprint(stackId);
  return { chunks, entities, relationships, evidence, log, documents };
}

export function createTestApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    // Open mode: auth is a separate, already-verified surface.
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
    // The compile route always calls a provider, so it refuses a deployment with no
    // bounded runner rather than holding the request transaction across the call.
    run: createTransactionRunner(database()),
  };

  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error && err.message !== "" ? err.message : "Internal Server Error";
    res.status(500).type("text/plain").send(message);
  });
  return app;
}

export async function createStack(overrides: { synthesize?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const domain = `${domainPrefix}${suffix}`;
  // A fixture that inserts a Stack directly has to bind its domain first, for the
  // same reason `POST /stacks` does: the `stacks` write policy validates against
  // `app.stack_domain`. Without it this fails under RLS with
  // "new row violates row-level security policy for table stacks".
  //
  // The binding must share a TRANSACTION with the insert. `set_config(..., true)`
  // is transaction-local, so on a pooled client two bare `execute` calls can land
  // on different connections and the setting is already gone.
  await database().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_domain', ${domain}, true)`);
    await tx.execute(sql`
      insert into stacks (id, name, domain, synthesize_descriptions)
      values (${id}, ${`w2ex ${suffix}`}, ${domain}, ${overrides.synthesize ?? false})
    `);
  });
  trackFixtureStack(id);
  return id;
}

export async function createDocument(
  stackId: string,
  content: string | Uint8Array,
  filename = "fixture.txt",
): Promise<string> {
  const documentId = randomUUID();
  const relative = `uploads/${stackId}/${documentId}.txt`;
  const absolute = resolve(process.cwd(), relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  writtenFiles.add(relative);

  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
  // `stack_documents` has no domain escape hatch: its write policy requires
  // `stack_id` to equal the bound tenant. As in `createStack` above, the binding
  // and the insert share a transaction because `set_config(..., true)` is
  // transaction-local and the pool may hand each statement a different connection.
  await database().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into stack_documents (
        id, stack_id, filename, storage_path, size_bytes, source_hash
      )
      values (${documentId}, ${stackId}, ${filename}, ${relative}, ${bytes}, ${randomUUID()})
    `);
  });
  return documentId;
}

export function ingestUrl(stackId: string, documentId: string, query = ""): string {
  return `/stacks/${stackId}/documents/${documentId}/ingest${query}`;
}

/**
 * The compile route of one document: the SECOND phase, which reads a document's stored
 * chunks and runs the LLM pipeline over them.
 *
 * A test that asserts on graph rows calls both, in this order — ingest stores a
 * document's chunks, compile turns them into entities, relationships, evidence and
 * decisions. Spelled here rather than as a literal in every suite so the one route path
 * has one home.
 *
 * @param stackId - The Stack that owns the document.
 * @param documentId - The document to compile.
 * @param query - The same per-request overrides ingest accepts.
 * @returns The route path, ready for a supertest `post`.
 */
export function compileUrl(stackId: string, documentId: string, query = ""): string {
  return `/stacks/${stackId}/documents/${documentId}/compile${query}`;
}

/** The skip decision, re-exported so each split file can gate on it. */
export const skipReason = state.skipReason;
