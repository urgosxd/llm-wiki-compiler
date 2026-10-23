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
  type ChunkResult,
  type ExtractedEntity,
  type ExtractedRelationship,
} from "llmwiki-kg";
import type {
  CommittedWrite,
  Dimension,
  DimensionInput,
  PreparedWrite,
} from "../types.js";

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
 * @returns Nothing; `handle.documentId` carries the id back to `commit`.
 */
async function writeGraph(
  options: KgDimensionOptions,
  handle: KgHandle,
): Promise<void> {
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    await db.transaction(async (tx) => {
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
    });
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
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
      const chunks = await chunkAndEmbed(input.body, options.stackId, chunkLabel);
      const extraction = await extractGraphFromChunks(chunks, options.stackName);
      const handle: KgHandle = {
        documentId: chunkLabel,
        registration: { source: input.source, body: input.body, title: input.title },
        chunks,
        entities: extraction.entities,
        relationships: extraction.relationships,
      };
      return { unchanged: chunks.length === 0, handle };
    },

    async commit(prepared: PreparedWrite): Promise<CommittedWrite> {
      const handle = prepared.handle as KgHandle;
      if (options.dryRun === true || handle.chunks.length === 0) {
        return {
          idempotencyKey: `kg:${handle.documentId}`,
          summary: `kg:dry-run(${handle.chunks.length} chunks, ${handle.entities.length} entities)`,
        };
      }
      // `writeGraph` replaces the placeholder with the id Postgres assigned.
      await writeGraph(options, handle);
      return {
        // Keyed on the real row id, so the outbox replay targets the same document
        // rather than the label it was prepared under.
        idempotencyKey: `kg:${handle.documentId}`,
        summary: `kg:${handle.chunks.length} chunks, ${handle.entities.length} entities`,
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
