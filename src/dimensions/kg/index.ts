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
  createClient,
  createDatabase,
  extractGraphFromChunks,
  kgConfig,
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

/** Handle carried between `prepare` and `commit` for the graph dimension. */
interface KgHandle {
  readonly documentId: string;
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

/** Length of the hex digest used inside the graph idempotency key. */
const KEY_DIGEST_CHARS = 32;

/**
 * Stable document id for a source, derived from its identity and content.
 *
 * The upstream server takes a UUID from its caller; the compiler has none to
 * give. A content-derived id is what makes a re-ingest idempotent: identical
 * content maps to the same document row instead of a duplicate.
 */
function deriveDocumentId(input: DimensionInput): string {
  return createHash("sha256")
    .update(input.source)
    .update("\u0000")
    .update(input.body)
    .digest("hex")
    .slice(0, KEY_DIGEST_CHARS);
}

/** Write the extracted graph into Postgres inside one transaction. */
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
 * Build the graph dimension.
 *
 * @param options - Stack binding and an optional database override.
 */
export function createKgDimension(options: KgDimensionOptions): Dimension {
  return {
    name: "kg",

    async prepare(input: DimensionInput): Promise<PreparedWrite> {
      const documentId = deriveDocumentId(input);
      const chunks = await chunkAndEmbed(input.body, options.stackId, documentId);
      const extraction = await extractGraphFromChunks(chunks, options.stackName);
      const handle: KgHandle = {
        documentId,
        chunks,
        entities: extraction.entities,
        relationships: extraction.relationships,
      };
      return { unchanged: chunks.length === 0, handle };
    },

    async commit(prepared: PreparedWrite): Promise<CommittedWrite> {
      const handle = prepared.handle as KgHandle;
      const idempotencyKey = `kg:${handle.documentId}`;
      if (options.dryRun === true || handle.chunks.length === 0) {
        return {
          idempotencyKey,
          summary: `kg:dry-run(${handle.chunks.length} chunks, ${handle.entities.length} entities)`,
        };
      }
      await writeGraph(options, handle);
      return {
        idempotencyKey,
        summary: `kg:${handle.chunks.length} chunks, ${handle.entities.length} entities`,
      };
    },

    async discard(): Promise<void> {
      // `prepare` writes no graph rows, so there is nothing to undo. A `commit`
      // that fails partway is handled by the outbox replay, which re-runs the
      // consolidation under its idempotency key rather than deleting rows.
    },
  };
}
