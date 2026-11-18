/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts
 * @description The ingest handler: the read stage, the compile seam, and the response
 * stage, in the order the algorithm requires, with the transaction boundaries written
 * down.
 *
 * ## Where each stage lives
 *
 * The eight stages of the algorithm are documented on the modules that own them:
 *
 * 1. extract candidates, 2. verify evidence, 3. resolve identities, 4. classify
 * entities, 5. classify relations, 6. validate structure, 7. consolidate and persist
 * — all of these live in `compile-chunks.ts`, behind {@link compileChunks}. They are
 * the part of this pipeline that reads CHUNKS and writes graph rows, which is why
 * they are a function of the chunks rather than of the document: a compile phase can
 * later feed it chunks read back from `document_chunks` instead of chunks just
 * embedded from the body.
 * 8. update projections — the audit blob and the Stack totals, written here by
 * {@link finishIngest}; the AKS export and the pages read the same rows, so there is
 * no second copy to invalidate.
 *
 * This module owns what is specific to INGEST: reading the document off disk, deciding
 * where the transactions fall, and answering.
 *
 * ## Nothing long runs inside a transaction (S44)
 *
 * The order above is not cosmetic: it is the reason the handler takes a
 * {@link TransactionRunner} instead of a connection. The handler opens THREE short
 * transactions across the two modules, and every external call happens between them:
 *
 * 1. READ — the document row, its text and the Stack's catalog. No provider call.
 * 2. provider stage — chunk and embed here, then extract and optionally synthesize
 *    descriptions inside `compileChunks`. NO transaction is open and no connection is
 *    held.
 * 3. WRITE — the chunk rows, identity resolution, the spans and the `pending`
 *    candidate rows, committed BEFORE the first classifier call.
 * 4. an external decision stage — the support questions and then the classification
 *    questions, again with nothing open.
 * 5. WRITE — evidence, decisions, history and the audit; the 200 follows the COMMIT.
 *
 * An extraction outage therefore no longer rolls the chunk rows back, because they
 * are not written until it succeeded: the run stops before stage 3 and the document
 * keeps whatever the previous ingest wrote. That is a deliberate change — a failed
 * extraction is more honestly "this run produced nothing" than "the transaction
 * aborted" — and it is what S44 asks for: no database transaction open across a long
 * external call.
 *
 * ## The one shape that still nests, and why it is allowed to
 *
 * A caller that injects only a request-scoped `wrap` (never with classification
 * enabled — that combination is refused by the router) sees all three runner calls
 * execute inside its single transaction. That is the legacy non-classifying suite
 * shape and its behaviour is unchanged; the stages still run in order, and the only
 * difference is where the COMMIT lands.
 *
 * ## Unconfigured classification is a supported outcome
 *
 * When no classifier is configured, the decision stage is skipped, every candidate
 * keeps the operational state `pending` that the candidate write recorded, no
 * classification log row is written, and the request still answers 200. A provider
 * failure is not converted into an abstention either: the decision layer turns it
 * into `pending`/`failed` and the candidate survives (S25).
 *
 * ## No mandatory human step was added (S4)
 *
 * `source.verified` is never written here. Backfeed keeps setting
 * `verified = true`, `source_kind = 'backfeed'` and `pipeline = 'human-review'`
 * exactly as before, because that path is untouched by this pipeline.
 */

import type { Request, Response } from "express";

import { chunkAndEmbed } from "../../core/extraction.js";
import { loadStackCatalog } from "../../core/catalog/stack-catalog.js";
import type { StackCatalogResolution } from "../../core/catalog/stack-catalog.js";
import { writeIngestAudit } from "./audit.js";
import type { ClassificationAudit } from "./audit.js";
import { compileChunks } from "./compile-chunks.js";
import type {
  CompileChunk,
  CompileInput,
  PreparedIngest,
  TransactionRunner,
} from "./compile-chunks.js";
import type { ClassificationRuntime } from "./classify-stage.js";
import type { ExtractionResult } from "../../core/extraction-types.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { IngestionResult } from "./models.js";
import type { IngestionResultDto } from "./models.js";
import {
  findDocument,
  parseIngestRequest,
  readDocumentText,
  sendDocumentNotFound,
} from "./request.js";
import type { DocumentRow, IngestParams, LoadedText } from "./request.js";
import { sendValidationFailure } from "./response.js";
import { stackTotals } from "./stack-totals.js";

export type { TransactionRunner } from "./compile-chunks.js";

/**
 * What ingest's read stage loaded: the document row, its text, and the vocabulary.
 *
 * The text lives HERE and not on the seam's {@link CompileInput}, because reading the
 * body is what only ingest does. {@link toCompileInput} hands the seam the three facts
 * a run needs and nothing else.
 */
interface IngestRead {
  readonly document: DocumentRow;
  readonly loaded: LoadedText;
  /** The Stack's resolved vocabulary: catalog, version and which column it came from. */
  readonly catalog: StackCatalogResolution;
}

/**
 * Narrows the read stage's result to what the compile seam consumes.
 *
 * The body stays behind: a compile reads stored chunks and never the document, so the
 * seam's input type has no field a compile could fill and no field it could invent.
 * `truncated` is a read-stage fact and travels because the ingest response reports it.
 *
 * @param read - What {@link loadIngestInput} loaded.
 * @returns The seam's input.
 */
function toCompileInput(read: IngestRead): CompileInput {
  return {
    document: read.document,
    catalog: read.catalog,
    truncated: read.loaded.truncated,
  };
}

/**
 * The read stage: the document, its text, and the Stack's vocabulary.
 *
 * Makes no provider call and writes nothing, so it can live in its own short
 * transaction without holding anything across an external request (S44).
 *
 * @param tx - The transaction the runner opened.
 * @param params - The validated ingest request.
 * @param res - Response, used for the 404 and 415 answers.
 * @returns What the provider stage needs, or `undefined` when a response was sent.
 */
async function loadIngestInput(
  tx: Database,
  params: IngestParams,
  res: Response,
): Promise<IngestRead | undefined> {
  const document = await findDocument(tx, params.stackId, params.docId);
  if (document === undefined) {
    sendDocumentNotFound(res, params);
    return undefined;
  }
  const loaded = await readDocumentText(res, document);
  if (loaded === undefined) return undefined;
  // Resolved BEFORE the extraction call, so a broken catalog costs no provider
  // request at all instead of paying for one and then failing.
  const catalog = await loadStackCatalog(tx, params.stackId);
  return { document, loaded, catalog };
}

/**
 * Stage 8: writes the audit blob and returns the payload the caller answers with.
 *
 * It runs inside the same transaction as the classification persistence, which is
 * why {@link compileChunks} takes it as a `commitWith` step: the audit cannot be
 * committed without the decisions it describes, nor they without it.
 *
 * @param tx - The transaction the classification persistence opened.
 * @param prepared - What the stages before it produced.
 * @param classification - The section for this run, or the unconfigured one.
 */
async function finishIngest(
  tx: Database,
  prepared: PreparedIngest,
  classification: ClassificationAudit,
): Promise<IngestionResultDto> {
  const { params, processed } = prepared;
  // A fresh transaction, so the tenant binding has to be made again.
  await bindCallerStack(tx, params.stackId, null);
  await writeIngestAudit(tx, params.docId, {
    ontology: processed.ontologyAudit,
    ...(processed.extractionAudit === undefined ? {} : { extraction: processed.extractionAudit }),
    ...(processed.openAudit === undefined ? {} : { open: processed.openAudit }),
    classification,
  });
  const payload = await buildIngestionResult(tx, {
    params,
    chunks: processed.chunks,
    extraction: processed.extraction,
    written: prepared.writtenRelationships,
    truncated: prepared.truncated,
    descriptionsSynthesized: processed.shouldSynthesize,
  });
  return IngestionResult.parse(payload);
}

/**
 * `POST /stacks/:stackId/documents/:doc_id/ingest`.
 *
 * The stages run in the order documented at the top of this module, split across
 * three short transactions by the injected runner so that NO transaction is open
 * while a provider is being called — neither the extraction model nor the classifier
 * (S44).
 *
 * @param req - The request.
 * @param res - The response.
 * @param run - How this deployment opens a short transaction.
 * @param classification - The decision runtime, or `undefined` when unconfigured.
 */
export async function ingestDocument(
  req: Request,
  res: Response,
  run: TransactionRunner,
  classification?: ClassificationRuntime,
): Promise<void> {
  const params = parseIngestRequest(req);
  if (!params.ok) {
    sendValidationFailure(res, params.detail);
    return;
  }
  // 1. READ: the document, its text and the Stack's catalog. No provider call.
  const input = await run((tx) => loadIngestInput(tx, params, res));
  if (input === undefined) return;
  // 2. PROVIDER STAGE: chunk and embed. No transaction is open here.
  const chunks = await chunkAndEmbed(input.loaded.text, params.stackId, params.docId);
  // 3-5. Extract, persist the candidates, classify, persist the decisions and the
  //      audit. The provider calls inside run with no transaction open, and the
  //      audit shares its transaction with the decisions it describes.
  const compiled = await compileChunks({
    chunks,
    input: toCompileInput(input),
    params,
    run,
    // Ingest has just produced the chunks, embedding included, so it is the phase that
    // writes the chunk rows. A compile states the opposite, explicitly.
    writeChunkRows: true,
    ...(classification === undefined ? {} : { classification }),
    commitWith: (tx, prepared, report) => finishIngest(tx, prepared, report),
  });
  // The COMMIT above has landed, so no client can see pre-commit state after it.
  res.status(200).json(compiled.committed);
}

/** Everything the response payload is assembled from. */
export interface IngestionFacts {
  readonly params: IngestParams;
  /** Only the count is read: `chunks_created` is how many chunks this run stored. */
  readonly chunks: readonly CompileChunk[];
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
  const totals = await stackTotals(tx, facts.params.stackId);
  return {
    document_id: facts.params.docId,
    chunks_created: facts.chunks.length,
    entities_extracted: facts.extraction.entities.length,
    entities_in_stack: totals.entities,
    relationships_extracted: facts.extraction.relationships.length,
    relationships_written: facts.written,
    relationships_in_stack: totals.relationships,
    truncated: facts.truncated,
    descriptions_synthesized: facts.descriptionsSynthesized,
  };
}
