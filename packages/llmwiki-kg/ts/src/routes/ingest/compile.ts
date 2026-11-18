/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile.ts
 * @description `POST /stacks/:stackId/documents/:doc_id/compile` — phase two of the KG
 * pipeline: read a document's STORED chunks and run the LLM pipeline over them.
 *
 * ## What this route is for
 *
 * The KG pipeline used to be welded into ingestion: one request chunked a document and
 * extracted its graph. The wiki has always been two steps — `ingest` stores, `compile`
 * extracts — and this route gives the KG dimension the same shape (S1), so extraction can
 * be run when someone wants it rather than every time a document is stored (S2, S3).
 *
 * Nothing calls this route automatically: no compile-on-write, no scheduler, no
 * background watcher, and no lint that would decide a document needs one. An ingest
 * without a compile is the NORMAL state, not an error state (S3, S10).
 *
 * ## What it reads, and what it deliberately does not
 *
 * The body of the document is irrelevant to phase two. Extraction reads `content` and
 * `chunkIndex` from each chunk and nothing else (`core/graph-extraction.ts`), and the
 * ingest phase already persisted those columns in `document_chunks` under
 * `on conflict (document_id, chunk_index) do update` (`compile-chunks.ts`,
 * {@link persistChunks}), which is what phase one writes.
 * This route therefore:
 *
 * 1. loads the `stack_documents` row (`findDocument`) — no file read, no body;
 * 2. reads `document_id, stack_id, chunk_index, content` from `document_chunks`, ordered
 *    by `chunk_index`, and NOT the embedding: a compile has nothing to embed and must
 *    not fabricate a vector it never computed;
 * 3. resolves the Stack's catalog exactly as ingest does, before any provider call, so a
 *    broken catalog costs no request;
 * 4. hands those chunks to {@link compileChunks}, so the identical extraction, candidate,
 *    classification and consolidation code runs; the one step only ingest owns — writing
 *    the chunk rows — is not part of that seam at all, because these chunks are already
 *    stored and this route holds no embedding to write.
 *
 * ## The transaction shape
 *
 * One READ transaction, then the provider stage with nothing open, then the seam's own
 * two write transactions. That is why a bounded {@link TransactionRunner} is REQUIRED
 * here rather than optional: this route always makes provider calls, so there is no safe
 * shape in which it could run inside the request transaction (S44). An absent runner is
 * refused with {@link IngestWiringError}, never degraded quietly.
 *
 * ## The refusals (S5)
 *
 * Every refusal answers before the provider stage and writes nothing:
 *
 * - an unknown Stack, and a document that is not in it — the ingest route's own 404
 *   wording, since `findDocument` joins the two and cannot tell them apart;
 * - a document that exists but has no stored chunks — `409`, naming the precondition and
 *   both causes it cannot separate, since a document ingested from empty or
 *   whitespace-only text and a document never ingested are byte-identical in storage.
 *   `404` would conflate "has no chunks" with "not stored", which S10 forbids; and a 200
 *   with zero counts would be indistinguishable from a document that simply had nothing
 *   in it.
 *
 * ## Compiling twice is safe (S4)
 *
 * The seam is repeatable: consolidation inserts a contribution with
 * `on conflict (entity_id, document_id) do nothing`, so a second run over unchanged text
 * changes no graph value. The proof lives in its own test rather than in this comment.
 */

import { sql } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { loadStackCatalog } from "../../core/catalog/stack-catalog.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { apiError } from "../../errors.js";
import { writeIngestAudit } from "./audit.js";
import type { ClassificationAudit } from "./audit.js";
import { classificationRuntime } from "./classify-stage.js";
import type { ClassificationRuntime } from "./classify-stage.js";
import { compileChunks } from "./compile-chunks.js";
import type {
  CompileChunk,
  CompileInput,
  PreparedIngest,
  TransactionRunner,
} from "./compile-chunks.js";
import { CompileResult } from "./models.js";
import type { CompileResultDto } from "./models.js";
import {
  findDocument,
  parseIngestRequest,
  sendApiError,
  sendDocumentNotFound,
} from "./request.js";
import type { IngestParams } from "./request.js";
import { sendValidationFailure } from "./response.js";
import { stackTotals } from "./stack-totals.js";
import { IngestWiringError } from "./wiring.js";

/** The status a document with no stored chunks is refused with. */
const NO_STORED_CHUNKS_STATUS = 409;

/**
 * The refusal a document with no stored chunks earns, spelled once so a caller (and a
 * test) reads the same sentence.
 *
 * ## Why it names TWO causes and asserts neither
 *
 * Storage cannot tell the two apart. A document that was ingested but produced no chunk
 * row looks exactly like one that was never ingested: `chunkAndEmbed` returns no chunks
 * for empty or whitespace-only text, so phase one persists nothing, and nothing else
 * records that an ingest ran. The refusal therefore states the precondition it really
 * has — no stored chunks — and names both causes, instead of claiming "never ingested"
 * about a document that WAS ingested, which S10 forbids.
 *
 * It also says why the route cannot proceed: a compile reads stored chunks and cannot
 * invent them. Either half alone leaves an operator guessing whether the document is
 * missing, the ingest failed, or the compile is broken.
 *
 * @param stackId - The Stack named in the path.
 * @param documentId - The document named in the path.
 * @returns The operator-facing sentence.
 */
export function noStoredChunksDetail(stackId: string, documentId: string): string {
  return (
    `Document ${documentId} has no stored chunks in Stack ${stackId}. Either it has not ` +
    `been ingested yet, or its ingested content produced no chunks — an empty or ` +
    `whitespace-only document persists no chunk rows. Compile reads the chunks the ingest ` +
    `route persists and cannot invent them.`
  );
}

/** The refusal a deployment with no bounded runner gets, naming this route's own defect. */
export const COMPILE_MISSING_RUNNER_MESSAGE =
  "compile requires a bounded transaction runner: pass `run: " +
  "createTransactionRunner(database)` over your pool. A compile always calls a provider, " +
  "so it cannot run inside the request transaction (S44).";

/** Everything the read stage resolved for one compile. */
interface CompileRead {
  /** What the seam needs about the document, and nothing about its body. */
  readonly input: CompileInput;
  /** The stored chunks, in `chunk_index` order. Never empty: an empty read is refused. */
  readonly chunks: readonly CompileChunk[];
}

/** Injectable collaborators, so a deployment and a test bind their own. */
export interface CompileRouterDependencies {
  /** How each step opens its short transaction; absent means the wiring is refused. */
  readonly run?: TransactionRunner;
  /** The decision runtime factory; absent falls back to the environment. */
  readonly decisions?: () => ClassificationRuntime | undefined;
}

/**
 * Reads one document's stored chunks, in order.
 *
 * Only the four columns phase two actually consumes are selected. `embedding`,
 * `content_hash`, `token_count` and `chunker_strategy` stay in the table: a compile has
 * nothing to embed, and reading those columns would invite a later reader to depend on a
 * value this route never validated.
 *
 * @param tx - The read transaction; the tenant is bound from the path's `:stackId`.
 * @param params - The validated request, which names the Stack and the document.
 * @returns The chunks, ordered by `chunk_index`; empty when the document was never ingested.
 */
async function readStoredChunks(
  tx: Database,
  params: IngestParams,
): Promise<readonly CompileChunk[]> {
  await bindCallerStack(tx, params.stackId, null);
  const rows = await tx.execute<{
    document_id: string;
    stack_id: string;
    chunk_index: number;
    content: string;
  }>(sql`
    select document_id, stack_id, chunk_index, content
    from document_chunks
    where document_id = ${params.docId} and stack_id = ${params.stackId}
    order by chunk_index
  `);
  return rows.map((row) => ({
    documentId: row.document_id,
    stackId: row.stack_id,
    chunkIndex: row.chunk_index,
    content: row.content,
  }));
}

/**
 * The read stage: the document row, its stored chunks and the Stack's vocabulary.
 *
 * Sends the refusal itself and returns `undefined` when the request cannot be compiled,
 * so the caller just stops — the same shape ingest's read stage has. The catalog is
 * resolved LAST, after the refusals, because resolving it is the only step here that can
 * be affected by a broken Stack declaration and there is no reason to fail on it for a
 * request that is already refused.
 *
 * @param tx - The read transaction the runner opened.
 * @param params - The validated request.
 * @param res - Response, used for the 404 and the 409.
 * @returns What phase two needs, or `undefined` when a response was already sent.
 */
async function loadCompileRead(
  tx: Database,
  params: IngestParams,
  res: Response,
): Promise<CompileRead | undefined> {
  const document = await findDocument(tx, params.stackId, params.docId);
  if (document === undefined) {
    sendDocumentNotFound(res, params);
    return undefined;
  }
  const chunks = await readStoredChunks(tx, params);
  if (chunks.length === 0) {
    sendApiError(
      res,
      apiError(NO_STORED_CHUNKS_STATUS, noStoredChunksDetail(params.stackId, params.docId)),
    );
    return undefined;
  }
  const catalog = await loadStackCatalog(tx, params.stackId);
  return {
    // `truncated` is a read-stage fact this route never observes: no body is loaded, and
    // `CompileResult` does not report it.
    input: { document, catalog, truncated: false },
    chunks,
  };
}

/**
 * The compile's last step: the audit blob and the response payload.
 *
 * It runs inside the transaction that persists the classification, which is why
 * {@link compileChunks} takes it as a `commitWith` step: the audit cannot be committed
 * without the decisions it describes. The blob is the SAME one ingest writes, so a
 * document's `audit` reports the last run that touched it, whichever phase that was.
 *
 * @param tx - The transaction the classification persistence opened.
 * @param prepared - What the stages before it produced.
 * @param classification - The section for this run, or the unconfigured one.
 * @returns The validated 200 payload.
 */
async function finishCompile(
  tx: Database,
  prepared: PreparedIngest,
  classification: ClassificationAudit,
): Promise<CompileResultDto> {
  const { params, processed } = prepared;
  // A fresh transaction, so the tenant binding has to be made again.
  await bindCallerStack(tx, params.stackId, null);
  await writeIngestAudit(tx, params.docId, {
    ontology: processed.ontologyAudit,
    ...(processed.extractionAudit === undefined ? {} : { extraction: processed.extractionAudit }),
    ...(processed.openAudit === undefined ? {} : { open: processed.openAudit }),
    classification,
  });
  const totals = await stackTotals(tx, params.stackId);
  return CompileResult.parse({
    document_id: params.docId,
    chunks_read: processed.chunks.length,
    entities_extracted: processed.extraction.entities.length,
    entities_in_stack: totals.entities,
    relationships_extracted: processed.extraction.relationships.length,
    relationships_written: prepared.writtenRelationships,
    relationships_in_stack: totals.relationships,
    descriptions_synthesized: processed.shouldSynthesize,
  });
}

/**
 * `POST /stacks/:stackId/documents/:doc_id/compile`.
 *
 * The stages run in the order documented at the top of this module, split across
 * transactions by the injected runner so that NO transaction is open while the
 * extraction model — or the classifier — is being called (S44).
 *
 * @param req - The request.
 * @param res - The response.
 * @param run - How this deployment opens a short transaction.
 * @param classification - The decision runtime, or `undefined` when unconfigured.
 */
async function compileDocument(
  req: Request,
  res: Response,
  run: TransactionRunner,
  classification?: ClassificationRuntime,
): Promise<void> {
  // The same validator as ingest: the same two path parameters, and the same per-request
  // `synthesize_descriptions` / `ontology_contract` overrides, reported in the same 422.
  const params = parseIngestRequest(req);
  if (!params.ok) {
    sendValidationFailure(res, params.detail);
    return;
  }
  const read = await run((tx) => loadCompileRead(tx, params, res));
  if (read === undefined) return;
  const compiled = await compileChunks({
    chunks: read.chunks,
    input: read.input,
    params,
    run,
    // The chunks are already stored, so this seam writes none of them: it reads them,
    // extracts, classifies and consolidates, which is the whole of phase two.
    ...(classification === undefined ? {} : { classification }),
    commitWith: (tx, prepared, report) => finishCompile(tx, prepared, report),
  });
  // The COMMIT above has landed, so no client can see pre-commit state after it.
  res.status(200).json(compiled.committed);
}

/**
 * Builds the handler, refusing a wiring that could hold a transaction across a provider.
 *
 * Unlike the ingest route, whose refusal names the embeddings phase one makes, there is
 * no second shape to fall back to here: a compile ALWAYS extracts and classifies, so an
 * absent runner is a wiring defect and is answered as one, with a message that names the
 * fix rather than a transaction left open for the whole handler.
 *
 * @param deps - Injected collaborators.
 * @returns The Express handler for the compile route.
 */
export function createCompileHandler(deps: CompileRouterDependencies): RequestHandler {
  const runner = deps.run;
  const decisions = deps.decisions;
  return (req: Request, res: Response, next: NextFunction) => {
    if (runner === undefined) {
      next(new IngestWiringError(COMPILE_MISSING_RUNNER_MESSAGE));
      return;
    }
    const runtime = (decisions ?? classificationRuntime)();
    void compileDocument(req, res, runner, runtime).catch((error: unknown) => {
      // A handler that already sent a response cannot be re-reported.
      if (!res.headersSent) next(error);
    });
  };
}
