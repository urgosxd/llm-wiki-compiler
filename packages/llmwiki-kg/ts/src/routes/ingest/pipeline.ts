/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts
 * @description The ingest pipeline: chunks, extraction, consolidation, response.
 *
 * Split out of `routes/ingest.ts` as its own unit because it is the only place
 * that writes chunks and the ontology, and the order of its steps is the contract
 * (chunks before extraction, extraction before consolidation, totals after).
 *
 * `ingestDocument` is a literal transcription of the Python handler, step for
 * step. Each step is a named helper below it so the sequence stays readable.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  chunkAndEmbed,
  extractGraphFromChunks,
  synthesizeEntityDescriptions,
} from "../../core/extraction.js";
import type { ChunkResult, ExtractionResult } from "../../core/extraction-types.js";
import {
  consolidateEntityRows,
  consolidateRelationshipRows,
} from "../../core/document-consolidation.js";
import type { Database } from "../../db.js";
import { IngestionResult } from "./models.js";
import type { IngestionResultDto } from "./models.js";
import {
  findDocument,
  parseIngestRequest,
  readDocumentText,
  sendDocumentNotFound,
  toVectorLiteral,
} from "./request.js";
import type { IngestParams } from "./request.js";
import { sendValidationFailure } from "./response.js";


/** What steps 5 and 6 produced, plus the synthesis decision. */
export interface ProcessedIngest {
  readonly chunks: readonly ChunkResult[];
  readonly extraction: ExtractionResult;
  readonly shouldSynthesize: boolean;
}

/**
 * Steps 5 and 6: chunk and embed, persist, extract, and optionally synthesize.
 *
 * A per-call `synthesize_descriptions` override wins over the Stack's own column.
 */
export async function chunkAndExtract(
  tx: Database,
  params: IngestParams,
  text: string,
  document: { readonly stack_name: string; readonly stack_synthesize_default: boolean },
): Promise<ProcessedIngest> {
  const chunks = await persistChunks(tx, params, text);
  const extraction = await extractGraphFromChunks(chunks, document.stack_name);
  const shouldSynthesize =
    params.synthesizeDescriptions ?? document.stack_synthesize_default;
  if (shouldSynthesize) {
    await synthesizeEntityDescriptions(extraction, chunks);
  }
  return { chunks, extraction, shouldSynthesize };
}

/**
 * `POST /stacks/:stack_id/documents/:doc_id/ingest`.
 *
 * Pipeline order mirrors the Python handler exactly; see the module comment for
 * the measured request order and the status codes.
 */
export async function ingestDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  // Step 1: both path parameters and the query flag, reported together.
  const params = parseIngestRequest(req);
  if (!params.ok) {
    sendValidationFailure(res, params.detail);
    return;
  }

  // Step 2: the document must exist AND belong to this Stack.
  const document = await findDocument(tx, params.stackId, params.docId);
  if (document === undefined) {
    sendDocumentNotFound(res, params);
    return;
  }

  // Step 3 and 4: read, decode, and truncate for extraction only.
  const loaded = await readDocumentText(res, document);
  if (loaded === undefined) {
    return;
  }

  // Steps 5 and 6: chunk, embed, persist, extract, optionally synthesize.
  const processed = await chunkAndExtract(tx, params, loaded.text, document);
  const { chunks, extraction, shouldSynthesize } = processed;

  // Step 7: consolidate. Entities first — the relationship pass needs the map.
  const written = await consolidateExtraction(tx, params, extraction);

  // Step 8: totals for the Stack, after consolidation so they include this run.
  const payload = await buildIngestionResult(tx, {
    params,
    chunks,
    extraction,
    written,
    truncated: loaded.truncated,
    descriptionsSynthesized: shouldSynthesize,
  });
  res.status(200).json(IngestionResult.parse(payload));
}

/**
 * Chunks and embeds the text, then upserts every chunk.
 *
 * `on conflict (document_id, chunk_index) do update` makes a re-ingest rewrite a
 * chunk in place instead of failing the unique index.
 */
export async function persistChunks(
  tx: Database,
  params: IngestParams,
  text: string,
): Promise<readonly ChunkResult[]> {
  const chunks = await chunkAndEmbed(text, params.stackId, params.docId);
  for (const chunk of chunks) {
    await upsertChunk(tx, chunk);
  }
  return chunks;
}

/**
 * Writes one chunk.
 *
 * pgvector's accepted text form is `[1,2,3]`. It must be passed as a string and
 * cast explicitly: handing postgres-js the JavaScript array makes it expand into
 * a 768-placeholder row constructor, which Postgres rejects as a type error
 * rather than coercing to `vector`.
 */
export async function upsertChunk(tx: Database, chunk: ChunkResult): Promise<void> {
  await tx.execute(sql`
    insert into document_chunks (
      document_id, stack_id, chunk_index, content,
      content_hash, token_count, embedding, chunker_strategy
    )
    values (
      ${chunk.documentId}, ${chunk.stackId}, ${chunk.chunkIndex},
      ${chunk.content}, ${chunk.contentHash}, ${chunk.tokenCount},
      ${toVectorLiteral(chunk.embedding)}::vector, ${chunk.chunkerStrategy}
    )
    on conflict (document_id, chunk_index) do update set
      content = excluded.content,
      content_hash = excluded.content_hash,
      token_count = excluded.token_count,
      embedding = excluded.embedding
  `);
}

/** Consolidates the extraction into the ontology, returning rows written. */
export async function consolidateExtraction(
  tx: Database,
  params: IngestParams,
  extraction: ExtractionResult,
): Promise<number> {
  // Entities first — the relationship pass needs the map.
  const nameToId = await consolidateEntityRows(
    tx,
    params.stackId,
    params.docId,
    extraction.entities,
  );
  return consolidateRelationshipRows(
    tx,
    params.stackId,
    extraction.relationships,
    nameToId,
  );
}

/** Everything the response payload is assembled from. */
export interface IngestionFacts {
  readonly params: IngestParams;
  readonly chunks: readonly ChunkResult[];
  readonly extraction: ExtractionResult;
  readonly written: number;
  readonly truncated: boolean;
  readonly descriptionsSynthesized: boolean;
}

/**
 * Assembles the 200 payload.
 *
 * The Stack totals are counted *after* consolidation so they include this run,
 * and `IngestionResult` fixes the key order when the caller parses it.
 */
export async function buildIngestionResult(
  tx: Database,
  facts: IngestionFacts,
): Promise<IngestionResultDto> {
  const stackId = facts.params.stackId;
  const entityTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_entities where stack_id = ${stackId}
  `);
  const relationshipTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_relationships where stack_id = ${stackId}
  `);

  return {
    document_id: facts.params.docId,
    chunks_created: facts.chunks.length,
    entities_extracted: facts.extraction.entities.length,
    entities_in_stack: entityTotals[0]?.n ?? 0,
    relationships_extracted: facts.extraction.relationships.length,
    relationships_written: facts.written,
    relationships_in_stack: relationshipTotals[0]?.n ?? 0,
    truncated: facts.truncated,
    descriptions_synthesized: facts.descriptionsSynthesized,
  };
}
