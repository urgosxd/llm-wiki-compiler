/**
 * @file src/dimensions/kg.ts
 * @description The `kg` dimension: ingest into the Agent Knowledge Standard graph.
 *
 * The knowledge-graph implementation is **not authored here**. It is the
 * vendored reference server under `packages/llmwiki-kg`, consumed in process
 * through its library barrel. This module is the adapter: it sequences the
 * vendored core's steps and maps them onto the dimension contract.
 *
 * ## Why the write is split across `prepare` and `commit`
 *
 * The graph write is the expensive, fallible half of an ingest: it chunks and
 * embeds text, calls an extraction model, and consolidates entities and edges
 * into Postgres. Graph work runs as the **last** step, after the wiki write has
 * landed, so a graph failure never strands a source the wiki never received.
 *
 * `prepare` does chunking, embedding, and extraction without touching the graph
 * tables. `commit` performs the consolidation — the step that makes rows
 * visible. A prepared-but-uncommitted graph has nothing to undo, so `discard`
 * is a no-op and the outbox covers a `commit` that fails partway.
 *
 * ## Credentials and database
 *
 * The vendored core reads provider credentials and `DATABASE_URL` from the
 * process environment through its own `config` module, exactly as when run as a
 * standalone server. This adapter adds no second configuration layer.
 */

import { createHash } from "node:crypto";
import {
  chunkAndEmbed,
  consolidateEntityRows,
  consolidateRelationshipRows,
  registerDocumentRow,
  createClient,
  createDatabase,
  extractGraphFromChunks,
  kgConfig,
  forgetDocumentRows,
  readStackOntology,
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
} from "llmwiki-kg";
import { defaultOntology } from "llmwiki-kg";
import type { Database, ExtractionResult, Ontology } from "llmwiki-kg";

import { loadStoredOntology } from "./ontology-store.js";
import type {
  CommittedWrite,
  CommitScope,
  Dimension,
  DimensionInput,
  PreparedWrite,
} from "../types.js";

/** One triplet rejection, derived from the core's own result shape. */
type KgRejection = NonNullable<ExtractionResult["rejected"]>[number];

/** Seconds to wait for the graph database before giving up. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Chars of a source digest kept in an in-memory chunk label. */
const SOURCE_LABEL_CHARS = 32;

/**
 * Stable per-source label for in-memory chunk metadata.
 *
 * Deliberately independent of the body: editing a source must not change which
 * source its chunks are labelled as. This is metadata only — it never becomes a
 * database key.
 *
 * @param source - Source identity (URL or path).
 * @returns A 32-char hex digest of the source alone.
 */
function sourceLabel(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, SOURCE_LABEL_CHARS);
}

/** Handle carried between `prepare` and `commit` for the graph dimension. */
interface KgHandle {
  /**
   * Document id, assigned by Postgres during `commit`.
   *
   * It is NOT known at prepare time and cannot be derived: `stack_documents.id`
   * defaults to `gen_random_uuid()` and the row does not exist yet. The earlier
   * adapter synthesized a 32-hex id from source+body, which happened to cast to
   * UUID but matched no row, so the `entity_source_documents.document_id`
   * foreign key rejected every consolidation.
   */
  documentId: string;
  /** Source identity and body, kept so `commit` can register the row. */
  readonly registration: { readonly source: string; readonly body: string; readonly title: string };
  readonly chunks: readonly ChunkResult[];
  readonly entities: readonly ExtractedEntity[];
  readonly relationships: readonly ExtractedRelationship[];
  /** Triplets the declared ontology turned away; empty when none was supplied. */
  readonly rejected: readonly KgRejection[];
}

/** How this dimension is bound to one knowledge stack. */
export interface KgDimensionOptions {
  /** Knowledge stack the document belongs to. */
  readonly stackId: string;
  /** Stack name passed to the extraction prompt for context. */
  readonly stackName: string;
  /** Postgres connection string; defaults to the vendored core's own config. */
  readonly databaseUrl?: string;
  /**
   * Detect-only mode: run chunking, embedding, and extraction, then report what
   * *would* be written without opening a database connection. Used by status
   * and by tests that must not require Postgres.
   */
  readonly dryRun?: boolean;
  /**
   * Declared entity and relationship types this Stack's graph may contain.
   *
   * Omitted means the oracle's behaviour: the model sees the default type hints
   * and whatever it emits is accepted, because `strict=False`. Supplied means
   * the declaration is enforced — the types go into the tool schema and every
   * triplet outside them is dropped and reported.
   *
   * An explicit value takes precedence over {@link loadOntology} and stops it
   * from being called at all, which is what lets a caller override the database
   * without editing it.
   */
  readonly ontology?: Ontology;
  /**
   * Reads this Stack's stored declaration, called once per `prepare`.
   *
   * Injected rather than imported so the two consumers can differ: the compiler
   * supplies the Postgres reader, while tests and detect-only runs supply a stub
   * and stay free of a database. Omitted means "no stored declaration", which is
   * the oracle's behaviour — NOT a silent default, because there is nothing to
   * read.
   */
  readonly loadOntology?: (stackId: string, databaseUrl?: string) => Promise<unknown>;
}

/**
 * Resolves the ontology this run must enforce, reading the Stack if needed.
 *
 * ## Why an unreadable declaration fails the run
 *
 * A malformed declaration could be swallowed into `undefined`, and the run would
 * proceed with the oracle's permissive behaviour. That is the one outcome this
 * feature must never produce: an operator who declared a schema and silently got
 * default extraction would believe the graph is constrained when it is not. The
 * error propagates, and `prepare` fails before a single triplet is extracted.
 *
 * ## Why the explicit option short-circuits
 *
 * Reading the database to discard the answer would make an override depend on a
 * reachable database it does not actually need.
 *
 * A Stack with no stored declaration is enforced against the documented default,
 * not left permissive. `readStackOntology` still returns `undefined` for a null
 * column — that is the reader's honest answer to "what is stored" — so the
 * default is applied here, at the boundary that knows a Stack exists.
 *
 * @param options - Stack binding, optional override, optional loader.
 * @returns The ontology to enforce; never `undefined`.
 * @throws {OntologyError} When the stored declaration is present but invalid.
 */
async function resolveOntology(options: KgDimensionOptions): Promise<Ontology> {
  if (options.ontology !== undefined) return options.ontology;
  const load = options.loadOntology ?? loadStoredOntology;
  const stored = await load(options.stackId, options.databaseUrl);
  return readStackOntology(stored) ?? defaultOntology();
}

/**
 * Trailing arguments for the extraction call, omitting the ontology when absent.
 *
 * @param ontology - The ontology to enforce, or `undefined` for none.
 * @returns An empty tuple without an ontology, or the single-element tuple with it.
 */
function ontologyArgs(ontology: Ontology | undefined): [] | [Ontology] {
  return ontology === undefined ? [] : [ontology];
}

/**
 * Renders the rejection count for a commit summary, or nothing when clean.
 *
 * A summary is the only per-document signal a caller sees without querying the
 * graph, so a run that silently dropped a third of its triplets must not read
 * the same as a run that found only a third.
 *
 * @param rejected - Triplets the ontology turned away.
 * @returns A leading-comma fragment, or an empty string when nothing was rejected.
 */
function rejectionNote(rejected: readonly KgRejection[]): string {
  return rejected.length === 0 ? "" : `, ${rejected.length} triplets rejected by ontology`;
}

/**
 * Write the extracted graph into Postgres inside one transaction.
 *
 * The document row is registered FIRST, in the same transaction as the
 * consolidation, for two reasons: `entity_source_documents.document_id` is a
 * foreign key onto `stack_documents`, so the parent must exist before any
 * contribution row; and sharing the transaction means a failed consolidation
 * leaves no orphan document behind.
 *
 * @param options - Stack binding and connection override.
 * @param handle - Prepared chunks and extraction; gains the assigned document id.
 * @param callerTx - Coordinator's transaction to join, when it owns one.
 * @returns Nothing; `handle.documentId` carries the id back to `commit`.
 */
async function writeGraph(
  options: KgDimensionOptions,
  handle: KgHandle,
  callerTx?: Database,
): Promise<void> {
  // JOINING IS THE WHOLE POINT. A commit that received a scope and opened its own
  // connection instead would commit the graph separately from the wiki, and a
  // later failure would leave exactly the half state atomic ingest removes. Both
  // commits succeed, so the break is silent -- this is the one rule the port's
  // `commit` documentation calls out.
  if (callerTx !== undefined) {
    await writeGraphRows(callerTx, options, handle);
    return;
  }
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    await db.transaction(async (tx) => {
      await writeGraphRows(tx as unknown as Database, options, handle);
    });
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}

/**
 * The graph statements themselves, on whichever handle carries the transaction.
 *
 * Split out so the connection decision above and the write below cannot drift: the
 * document row, the entities and the relationships must all land on the SAME
 * handle (v3 rule), or the foreign key from `entity_source_documents` to
 * `stack_documents` sees a parent that does not exist yet on that connection.
 *
 * @param tx - Transaction bound to this dimension's Stack.
 * @param options - Stack binding.
 * @param handle - Prepared chunks and extraction; gains the assigned document id.
 */
async function writeGraphRows(
  tx: Database,
  options: KgDimensionOptions,
  handle: KgHandle,
): Promise<void> {
  handle.documentId = await registerDocumentRow(tx, {
    stackId: options.stackId,
    source: handle.registration.source,
    body: handle.registration.body,
    title: handle.registration.title,
  });
  const nameToId = await consolidateEntityRows(
    tx,
    options.stackId,
    handle.documentId,
    handle.entities,
  );
  await consolidateRelationshipRows(
    tx,
    options.stackId,
    handle.relationships,
    nameToId,
  );
}

/**
 * Delete every document row for a source, letting the foreign keys cascade.
 *
 * WHY `storage_path` AND NOT AN ID: the compiler registers a document with the
 * SOURCE IDENTITY in `storage_path` (a URL or path), because it has no filename to
 * give the graph. That column is therefore the only thing connecting a source
 * string to its rows, and it is what `forget` can match on.
 *
 * WHY A DELETE RATHER THAN A TOMBSTONE: chunk and
 * `entity_source_documents` rows cascade from `stack_documents`, so one delete
 * retires the whole trace. Soft delete would require every one of the six readers
 * of `stack_documents` to learn a new filter, and those readers are measured
 * against the Python oracle, which has no such concept — the fidelity guarantee
 * would stop holding for deleted documents. The crash this would have protected
 * against is already covered: the source file is still on disk, and the outbox
 * retains `document` and `body`, so a re-ingest reconstructs the graph.
 *
 * Deleting by source removes EVERY generation of that source, which is what
 * retirement means: a source whose content changed is a different `source_hash`
 * and therefore a different row, and forgetting the source must retire all of
 * them, not just the newest.
 *
 * @param options - Stack binding and connection override.
 * @param source - Source identity recorded at ingest time.
 */
async function deleteGraphRows(options: KgDimensionOptions, source: string): Promise<void> {
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    await db.transaction(async (tx) => {
      // No row is not an error: forgetting an unknown or already-forgotten source
      // is the desired end state, and a reconciler retry must not fail on it.
      await forgetDocumentRows(tx, options.stackId, source);
    });
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}

/**
 * Build the graph dimension.
 *
 * @param options - Stack binding and an optional database override.
 */
export function createKgDimension(options: KgDimensionOptions): Dimension {
  return {
    name: "kg",

    async prepare(input: DimensionInput): Promise<PreparedWrite> {
      // Chunk labels carry the source identity only. The authoritative document
      // id does not exist yet — Postgres assigns it during `commit` — and chunks
      // stay in memory, so nothing depends on this placeholder matching a row.
      const chunkLabel = sourceLabel(input.source);
      // Resolved BEFORE embedding: a malformed declaration should fail the run
      // before the expensive half spends a provider call, and it must fail rather
      // than degrade to permissive extraction.
      const ontology = await resolveOntology(options);
      const chunks = await chunkAndEmbed(input.body, options.stackId, chunkLabel);
      // The ontology is spread rather than passed as `undefined`, so a run
      // without one calls extraction with exactly the two arguments it always
      // did. Call arity is observable to spies and mocks, and "no ontology
      // changes nothing" has to hold at the call boundary, not just in the
      // result.
      const extraction = await extractGraphFromChunks(chunks, options.stackName, ...ontologyArgs(ontology));
      const handle: KgHandle = {
        documentId: chunkLabel,
        registration: { source: input.source, body: input.body, title: input.title },
        chunks,
        entities: extraction.entities,
        relationships: extraction.relationships,
        rejected: extraction.rejected ?? [],
      };
      return { unchanged: chunks.length === 0, handle };
    },

    async commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite> {
      const handle = prepared.handle as KgHandle;
      if (options.dryRun === true || handle.chunks.length === 0) {
        return {
          idempotencyKey: `kg:${handle.documentId}`,
          summary: `kg:dry-run(${handle.chunks.length} chunks, ${handle.entities.length} entities)${rejectionNote(handle.rejected)}`,
        };
      }
      // `writeGraph` replaces the placeholder with the id Postgres assigned.
      await writeGraph(options, handle, scope?.tx as Database | undefined);
      return {
        // Keyed on the real row id, so the outbox replay targets the same document
        // rather than the label it was prepared under.
        idempotencyKey: `kg:${handle.documentId}`,
        summary: `kg:${handle.chunks.length} chunks, ${handle.entities.length} entities${rejectionNote(handle.rejected)}`,
      };
    },

    async discard(): Promise<void> {
      // `prepare` writes no graph rows, so there is nothing to undo. A `commit`
      // that fails partway is handled by the outbox replay, which re-runs the
      // consolidation under its idempotency key rather than deleting rows.
    },

    async forget(source: string): Promise<void> {
      if (options.dryRun === true) return;
      await deleteGraphRows(options, source);
    },
  };
}
