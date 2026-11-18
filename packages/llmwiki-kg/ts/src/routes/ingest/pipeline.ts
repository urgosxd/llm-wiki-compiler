/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts
 * @description Phase ONE of the KG pipeline: `POST /stacks/:stackId/documents/:doc_id/ingest`
 * loads a document, chunks and embeds it, stores the chunk rows, and answers.
 *
 * ## What this phase does NOT do, and why that is the feature
 *
 * The KG pipeline used to be welded into ingestion: one request chunked a document and
 * extracted its graph. The wiki has always been two steps — ingest stores, compile
 * extracts — and this module is the KG half of that shape (S1). So an ingest here:
 *
 * - makes NO extraction call and NO classification call;
 * - writes NO `ontology_entities` and NO `ontology_relationships` row;
 * - does NOT resolve the Stack's type catalog, which no longer has anything to decide
 *   in this phase — the catalog is consulted by {@link compileDocument}, the phase that
 *   classifies against it;
 * - writes NO audit section, which is the one consequence worth spelling out below.
 *
 * Everything extraction-shaped lives in `compile-chunks.ts` and is reached only through
 * the compile route (`compile.ts`). Nothing calls that route automatically: no
 * compile-on-ingest, no scheduler, no watcher (S3).
 *
 * ## Why this phase writes no audit at all
 *
 * `writeIngestAudit` (`audit.ts`) MERGES into `stack_documents.audit`: it keeps keys it
 * does not know about, but it DELETES the three keys a run owns — `extraction`, `open`
 * and `classification` — and re-adds each only when the report it is handed carries it.
 * A phase-one write of `{ ontology }` alone therefore erases the sections a previous
 * compile wrote, whose decisions are still stored. This phase has nothing of its own to
 * report — the ontology section counts what extraction rejected, and extraction is the
 * other phase — so it writes nothing, and a later ingest cannot destroy a compile's
 * record. The `ingest-audit-merge` suite pins both halves of that.
 *
 * ## Nothing long runs inside a transaction (S44)
 *
 * The handler opens exactly TWO short transactions, and the provider stage sits between
 * them:
 *
 * 1. READ — the document row and its text. No provider call, nothing written.
 * 2. provider stage — chunk and embed. NO transaction is open and no connection is held.
 * 3. WRITE — the chunk rows, then the Stack totals the response reports. The 200 is
 *    built INSIDE this boundary and sent after its COMMIT, so a client that acts on a
 *    200 cannot observe pre-commit state.
 *
 * An embedding outage therefore writes nothing at all: the run stops before stage 3 and
 * the document keeps whatever the previous ingest stored.
 *
 * ## The chunk write is unchanged
 *
 * Same upsert ({@link persistChunks}), same columns, same
 * `on conflict (document_id, chunk_index) do update` target. Splitting the pipeline is
 * not a reason to move stored data around, and re-ingesting a document still rewrites
 * its chunks in place rather than duplicating or failing on them.
 */

import type { Request, Response } from "express";

import { chunkAndEmbed } from "../../core/extraction.js";
import type { ChunkResult } from "../../core/extraction-types.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { persistChunks } from "./compile-chunks.js";
import type { TransactionRunner } from "./compile-chunks.js";
import { IngestionResult } from "./models.js";
import type { IngestionResultDto } from "./models.js";
import {
  findDocument,
  parseIngestRequest,
  readDocumentText,
  sendDocumentNotFound,
} from "./request.js";
import type { IngestParams, LoadedText } from "./request.js";
import { sendValidationFailure } from "./response.js";
import { stackTotals } from "./stack-totals.js";

export type { TransactionRunner } from "./compile-chunks.js";

/**
 * The read stage: the document row and the text on disk.
 *
 * Makes no provider call and writes nothing, so it can live in its own short
 * transaction without holding anything across an external request (S44). It sends the
 * 404 and the 500/415 itself and returns `undefined` when a response went out, so the
 * caller just stops.
 *
 * @param tx - The transaction the runner opened.
 * @param params - The validated ingest request.
 * @param res - Response, used for the not-found and unreadable-file answers.
 * @returns The text phase two after this one will extract from, or `undefined`.
 */
async function loadDocumentText(
  tx: Database,
  params: IngestParams,
  res: Response,
): Promise<LoadedText | undefined> {
  const document = await findDocument(tx, params.stackId, params.docId);
  if (document === undefined) {
    sendDocumentNotFound(res, params);
    return undefined;
  }
  return readDocumentText(res, document);
}

/**
 * The write stage: the chunk rows, and the payload the caller is answered with.
 *
 * It runs inside the transaction the runner opened and returns what the 200 will carry,
 * so the answer is sent only after the COMMIT this payload describes.
 *
 * The graph counters are read from storage rather than reported from this run: phase
 * one forms no entity and no relationship, so the totals it reports are the Stack's
 * current ones — unchanged by the ingest, which is exactly what they must say.
 *
 * @param tx - The transaction the runner opened; the tenant is bound here because it is
 *   a fresh connection.
 * @param params - The validated ingest request.
 * @param loaded - What the read stage loaded, for the truncation flag.
 * @param chunks - The chunks this run just produced, embedding included.
 * @returns The validated 200 payload.
 */
async function storeChunksAndReport(
  tx: Database,
  params: IngestParams,
  loaded: LoadedText,
  chunks: readonly ChunkResult[],
): Promise<IngestionResultDto> {
  await bindCallerStack(tx, params.stackId, null);
  await persistChunks(tx, chunks);
  const totals = await stackTotals(tx, params.stackId);
  return IngestionResult.parse({
    document_id: params.docId,
    chunks_created: chunks.length,
    entities_extracted: 0,
    entities_in_stack: totals.entities,
    relationships_extracted: 0,
    relationships_written: 0,
    relationships_in_stack: totals.relationships,
    truncated: loaded.truncated,
    descriptions_synthesized: false,
  });
}

/**
 * `POST /stacks/:stackId/documents/:doc_id/ingest` — phase one.
 *
 * The stages run in the order documented at the top of this module, split across two
 * short transactions by the injected runner so that NO transaction is open while the
 * embedding provider is being called (S44).
 *
 * @param req - The request.
 * @param res - The response.
 * @param run - How this deployment opens a short transaction.
 */
export async function ingestDocument(
  req: Request,
  res: Response,
  run: TransactionRunner,
): Promise<void> {
  const params = parseIngestRequest(req);
  if (!params.ok) {
    sendValidationFailure(res, params.detail);
    return;
  }
  // 1. READ: the document and its text. No provider call, nothing written.
  const loaded = await run((tx) => loadDocumentText(tx, params, res));
  if (loaded === undefined) return;
  // 2. PROVIDER STAGE: chunk and embed. No transaction is open here.
  const chunks = await chunkAndEmbed(loaded.text, params.stackId, params.docId);
  // 3. WRITE: the chunk rows and the payload. The COMMIT lands before the answer.
  const payload = await run((tx) => storeChunksAndReport(tx, params, loaded, chunks));
  res.status(200).json(payload);
}
