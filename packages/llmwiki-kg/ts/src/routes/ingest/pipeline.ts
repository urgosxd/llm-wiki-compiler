/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/pipeline.ts
 * @description The ingest pipeline: the eight stages, in the order the algorithm
 * requires, with the transaction boundaries written down.
 *
 * ## The stages, and where the transaction boundaries fall
 *
 * 1. extract candidates          — `chunkAndExtract`: chunk, embed and extract under
 *                                  the OPEN contract, with NO transaction open
 * 2. verify evidence             — `buildCandidateSpans`: the quote is located in the
 *                                  stored chunk and recorded with verifiable offsets
 * 3. resolve identities          — `resolveIdentityKeys`: known keys in, one key per
 *                                  mention out
 * 4. classify entities           — stages 2b and 4-6 run together in `classifySpans`
 * 5. classify relations
 * 6. validate structure and      — `validateDecisions`: state and canonical type must
 *    semantic compatibility        agree before anything is written
 * 7. consolidate and persist     — `persistClassification`: evidence rows, the
 *                                  decision columns, the classification log
 * 8. update projections          — the audit blob and the Stack totals; the AKS
 *                                  export and the pages read the same rows, so there
 *                                  is no second copy to invalidate
 *
 * ## Nothing long runs inside a transaction (S44)
 *
 * The order above is not cosmetic: it is the reason the handler takes a
 * {@link TransactionRunner} instead of a connection. The handler now opens THREE
 * short transactions, and every external call happens between them:
 *
 * 1. READ — the document row, its text and the Stack's catalog. No provider call.
 * 2. provider stage — chunk and embed, extract, optionally synthesize descriptions.
 *    NO transaction is open and no connection is held.
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
 * When no classifier is configured, stages 4-6 are skipped, every candidate keeps
 * the operational state `pending` that stage 1 wrote, no classification log row is
 * written, and the request still answers 200. A provider failure is not converted
 * into an abstention either: the decision layer turns it into `pending`/`failed`
 * and the candidate survives (S25).
 *
 * ## No mandatory human step was added (S4)
 *
 * `source.verified` is never written here. Backfeed keeps setting
 * `verified = true`, `source_kind = 'backfeed'` and `pipeline = 'human-review'`
 * exactly as before, because that path is untouched by this pipeline.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  chunkAndEmbed,
  extractGraphFromChunks,
  synthesizeEntityDescriptions,
} from "../../core/extraction.js";
import { defaultOntology } from "../../core/default_ontology.js";
import { loadStackCatalog } from "../../core/catalog/stack-catalog.js";
import type { StackCatalogResolution } from "../../core/catalog/stack-catalog.js";
import { normalizeCatalogName } from "../../core/catalog/names.js";
import type { TypeCatalog } from "../../core/catalog/types.js";
import {
  buildClassificationAudit,
  buildExtractionAudit,
  buildOntologyAudit,
  buildOpenAudit,
  buildUnconfiguredClassificationAudit,
  writeIngestAudit,
} from "./audit.js";
import type { ClassificationAudit, ExtractionAudit, OntologyAudit, OpenAudit } from "./audit.js";
import { buildCandidateSpans, originalPredicate, relationRef } from "./candidates.js";
import type { CandidateSpan } from "./candidates.js";
import { appendClassificationLog } from "./classification-log.js";
import type { ClassificationLogEntry } from "./classification-log.js";
import {
  CLASSIFIER_VERSION,
  classifySpans,
  stateCounts,
} from "./classify-stage.js";
import type { ClassificationOutcome, ClassificationRuntime } from "./classify-stage.js";
import { persistClassification } from "./persist-classification.js";
import type { ChunkResult, ExtractionResult } from "../../core/extraction-types.js";
import type { ExtractionOptions } from "../../core/graph-extraction.js";
import { deriveIdentityKey } from "../../core/identity/key.js";
import { reportedBaseUrl } from "../../core/jev/redact.js";
import { resolveIdentities } from "../../core/identity/resolve.js";
import type { KnownIdentity } from "../../core/identity/types.js";
import { validateOntology } from "../../core/ontology.js";
import type { Ontology } from "../../core/ontology.js";
import {
  consolidateEntityRows,
  consolidateRelationshipRowsDetailed,
} from "../../core/document-consolidation.js";
import type {
  ConsolidationEntity,
  ConsolidationRelationship,
  RelationCollision,
} from "../../core/document-consolidation.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { IngestionResult } from "./models.js";
import type { IngestionResultDto } from "./models.js";
import {
  findDocument,
  loadKnownIdentities,
  parseIngestRequest,
  readDocumentText,
  sendDocumentNotFound,
  toVectorLiteral,
} from "./request.js";
import type { DocumentRow, IngestParams, LoadedText } from "./request.js";
import { sendValidationFailure } from "./response.js";

/**
 * Runs one unit of work inside one short transaction.
 *
 * Injected instead of a connection on purpose: the pipeline decides WHERE the
 * boundaries are, and the router decides how a transaction is opened. That is what
 * lets the same handler run under the pool's runner (three bounded transactions)
 * and under a request-scoped wrapper (one), with no second copy of the stage order.
 */
export type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>;

/** The state stage 1 records, before any classifier has been asked anything. */
const PENDING_STATE = "pending";

/**
 * The admission contract one run asks the extractor for.
 *
 * The DEFAULT is `open`, which is what S1 and S7 require: a candidate the catalog
 * does not name is kept with the type and predicate the model proposed. The `strict`
 * contract — the previous pipeline's behaviour, where the declaration was an
 * admission filter — is still available and is selected explicitly per request
 * through the ingest endpoint's `ontology_contract` query parameter. The choice is
 * made here, at admission time, which is the only place it can change what enters
 * the graph.
 *
 * @param params - The validated ingest request.
 * @returns The extraction options for this run.
 */
function extractionOptions(params: IngestParams): ExtractionOptions {
  return Object.freeze({ contract: params.ontologyContract });
}

/**
 * The Stack's ontology, used as ORIENTATION for the extraction prompt.
 *
 * A null column resolves to the documented default rather than to "no vocabulary",
 * and the difference is now only what the model is told: a proposal outside it is
 * kept and reported in the document's `audit`, never dropped.
 *
 * @param stored - The Stack's `ontology` column, or null/undefined when unset.
 * @returns Exactly one validated ontology: the declared one, or the default.
 * @throws {OntologyError} When the stored value is present but not a valid declaration.
 */
function ontologyArgument(stored: unknown): Ontology {
  if (stored === null || stored === undefined) return defaultOntology();
  return validateOntology(stored);
}

/** What steps 5 and 6 produced, plus the synthesis decision. */
export interface ProcessedIngest {
  readonly chunks: readonly ChunkResult[];
  readonly extraction: ExtractionResult;
  readonly shouldSynthesize: boolean;
  readonly ontologyAudit: OntologyAudit;
  /** Absent when the extraction degraded nothing. */
  readonly extractionAudit?: ExtractionAudit;
  /** Absent when the run kept nothing outside the catalog and capped nothing. */
  readonly openAudit?: OpenAudit;
}

/**
 * Steps 5 and 6: chunk and embed, persist, extract, and optionally synthesize.
 *
 * A per-call `synthesize_descriptions` override wins over the Stack's own column.
 */
export async function chunkAndExtract(
  params: IngestParams,
  text: string,
  document: {
    readonly stack_name: string;
    readonly stack_synthesize_default: boolean;
    readonly stack_ontology?: unknown;
  },
): Promise<ProcessedIngest> {
  // Every call in this function is external — embeddings, the extraction
  // completion, and the description synthesis. It therefore takes NO database
  // handle at all, which is what makes it impossible to run inside a transaction by
  // accident (S44).
  const chunks = await chunkAndEmbed(text, params.stackId, params.docId);
  const ontology = ontologyArgument(document.stack_ontology);
  const extraction = await extractGraphFromChunks(
    chunks,
    document.stack_name,
    ontology,
    extractionOptions(params),
  );
  const shouldSynthesize =
    params.synthesizeDescriptions ?? document.stack_synthesize_default;
  if (shouldSynthesize) {
    await synthesizeEntityDescriptions(extraction, chunks);
  }
  const declared = document.stack_ontology !== null && document.stack_ontology !== undefined;
  const extractionAudit = buildExtractionAudit(extraction);
  const openAudit = buildOpenAudit(extraction);
  return {
    chunks,
    extraction,
    shouldSynthesize,
    ontologyAudit: buildOntologyAudit(declared, extraction.rejected ?? []),
    ...(extractionAudit === undefined ? {} : { extractionAudit }),
    ...(openAudit === undefined ? {} : { openAudit }),
  };
}

/** Everything stages 1-3 hand to the classifier, and what stage 7 needs. */
export interface PreparedIngest {
  readonly params: IngestParams;
  readonly processed: ProcessedIngest;
  /** One span per candidate: stage 2's output. */
  readonly spans: readonly CandidateSpan[];
  /** The catalog version the decisions will be made under. */
  readonly catalogVersion: string;
  /** The catalog itself, so stages 4-6 are asked against what the Stack declares. */
  readonly catalog: TypeCatalog;
  /** Folded entity name → entity row id, from stage 1's consolidation. */
  readonly entityIds: ReadonlyMap<string, string>;
  /** How many relationship rows stage 1 attempted to write. */
  readonly writtenRelationships: number;
  readonly truncated: boolean;
}

/** What the read stage loads before a single provider call is made. */
export interface IngestInput {
  readonly document: DocumentRow;
  readonly loaded: LoadedText;
  /** The Stack's resolved vocabulary: catalog, version and which column it came from. */
  readonly catalog: StackCatalogResolution;
}

/**
 * Stage 3: one identity key per extracted mention.
 *
 * A `matched` resolution echoes the EXISTING row's key, so a re-ingest updates that
 * row instead of opening a sibling (S28, S43). An `undecided` mention — a name the
 * Stack holds under more than one key — falls back to its own bare name key rather
 * than to a guess: the pipeline has no mention-context evidence to disambiguate
 * with, and inventing an anchor would fork an identity out of nothing.
 *
 * @param extraction - The folded extraction result.
 * @param known - Every identity the Stack already holds.
 * @returns Folded entity name → the key its row must carry.
 */
function resolveIdentityKeys(
  extraction: ExtractionResult,
  known: readonly KnownIdentity[],
): Map<string, string> {
  const mentions = extraction.entities.map((entity, index) => ({
    ref: `mention:${String(index)}`,
    name: entity.name,
  }));
  const resolutions = resolveIdentities(mentions, { known });
  const keys = new Map<string, string>();
  extraction.entities.forEach((entity, index) => {
    const resolution = resolutions[index];
    keys.set(
      normalizeCatalogName(entity.name),
      resolution === undefined || resolution.status === "undecided"
        ? deriveIdentityKey({ name: entity.name })
        : resolution.identityKey,
    );
  });
  return keys;
}

/**
 * The history entries for the assertions one document could not keep apart.
 *
 * A collision is a decision about which fact the graph keeps — the first predicate,
 * never the last writer's — so it belongs in the same append-only table as every
 * other classification decision instead of disappearing into a count that did not
 * change (S43). `new_state` is `pending` because that is the honest state of the
 * absorbed assertion: the classifier was never asked about it, and no row holds its
 * answer. The `reason` names the predicate that survived, so the two assertions stay
 * distinguishable to a reader.
 *
 * @param documentId - The document that carried the absorbed assertion.
 * @param collisions - What consolidation reported.
 * @returns One entry per absorbed assertion.
 */
function collisionEntries(
  documentId: string,
  collisions: readonly RelationCollision[],
): readonly ClassificationLogEntry[] {
  return collisions.map((collision) => ({
    candidateKind: "relationship" as const,
    candidateRef: relationRef(documentId, collision.fromName, collision.predicate, collision.toName),
    previousState: null,
    newState: PENDING_STATE,
    previousCanonicalType: null,
    newCanonicalType: null,
    readout: null,
    catalogVersion: null,
    classifierVersion: null,
    reason: `relation_collision:${collision.storedPredicate}`,
  }));
}

/**
 * Writes the candidate rows stage 1 produces, BEFORE anything classifies them.
 *
 * They are written as `pending`, which is the schema's "the classifier has not
 * answered yet". That order is what makes the transaction boundary honest — the
 * rows are committed before the classifier is called — and what makes an
 * interrupted run recoverable instead of invisible.
 *
 * @param tx - The transaction stages 1-3 run in.
 * @param params - The ingest request.
 * @param extraction - The folded extraction result.
 * @param identityKeys - Stage 3's output, keyed by folded entity name.
 * @param catalogVersion - The vocabulary this run extracts and will classify under.
 * @returns Folded entity name → entity row id, and the relationship count.
 */
async function persistCandidates(
  tx: Database,
  params: IngestParams,
  extraction: ExtractionResult,
  identityKeys: ReadonlyMap<string, string>,
  catalogVersion: string,
): Promise<{ entityIds: Map<string, string>; writtenRelationships: number }> {
  const entities: ConsolidationEntity[] = extraction.entities.map((entity) => {
    const identityKey = identityKeys.get(normalizeCatalogName(entity.name));
    return {
      ...entity,
      ...(identityKey === undefined ? {} : { identityKey }),
      proposedType: entity.type,
      classificationState: PENDING_STATE,
    };
  });
  const entityIds = await consolidateEntityRows(tx, params.stackId, params.docId, entities);
  const relationships: ConsolidationRelationship[] = extraction.relationships.map((relationship) => ({
    ...relationship,
    // The verb the model read, not the folded label identity uses: `type` keeps the
    // fold for the projection column, and this column keeps the original wording so
    // "deja sin efecto" survives ingestion verbatim (S2, S30, S31).
    predicate: originalPredicate(relationship),
    classificationState: PENDING_STATE,
  }));
  const outcome = await consolidateRelationshipRowsDetailed(
    tx,
    params.stackId,
    relationships,
    entityIds,
  );
  // A folded `type` can absorb a second assertion; the survivor keeps the FIRST
  // predicate, and the loss is recorded instead of being left to a count that did
  // not change. Written in the same transaction as the rows, so the record cannot
  // outlive what it describes.
  await appendClassificationLog(
    tx,
    {
      stackId: params.stackId,
      catalogVersion,
      classifierVersion: CLASSIFIER_VERSION,
      jevModel: "",
    },
    collisionEntries(params.docId, outcome.collisions),
  );
  return { entityIds, writtenRelationships: outcome.written };
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
): Promise<IngestInput | undefined> {
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
 * Stages 2 and 3 plus the `pending` rows, in one short write transaction.
 *
 * The chunks are written HERE rather than beside the extraction that produced them,
 * because that extraction ran with no transaction open: writing them afterwards is
 * what keeps the provider call out of the transaction (S44). The candidate rows are
 * written as `pending`, committed, and only then is a classifier asked anything.
 *
 * @param tx - The transaction the runner opened.
 * @param params - The validated ingest request.
 * @param input - What the read stage loaded.
 * @param processed - What the provider stage produced.
 * @returns Everything the classification stages need.
 */
async function prepareIngest(
  tx: Database,
  params: IngestParams,
  input: IngestInput,
  processed: ProcessedIngest,
): Promise<PreparedIngest> {
  await persistChunks(tx, processed.chunks);
  const identityKeys = resolveIdentityKeys(
    processed.extraction,
    await loadKnownIdentities(tx, params.stackId),
  );
  // Evidence is verified against the chunks this transaction just wrote, so the
  // offsets are into the stored text rather than into a pre-trim split.
  const spans = buildCandidateSpans({
    documentId: params.docId,
    extraction: processed.extraction,
    chunks: processed.chunks,
    identityKeys,
    catalogVersion: input.catalog.version,
  });
  const { entityIds, writtenRelationships } = await persistCandidates(
    tx,
    params,
    processed.extraction,
    identityKeys,
    input.catalog.version,
  );
  return {
    params,
    processed,
    spans,
    catalogVersion: input.catalog.version,
    catalog: input.catalog.catalog,
    entityIds,
    writtenRelationships,
    truncated: input.loaded.truncated,
  };
}

/**
 * Stage 8: writes the audit blob and returns the payload the caller answers with.
 *
 * @param tx - The second short transaction.
 * @param prepared - What stages 1-3 produced.
 * @param classification - The section for this run, or `undefined` when none ran.
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
 * The eight stages run in the order documented at the top of this module, split
 * across three short transactions by the injected runner so that NO transaction is
 * open while a provider is being called — neither the extraction model nor the
 * classifier (S44).
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
  // 2. PROVIDER STAGE: chunk, embed and extract. No transaction is open here.
  const processed = await chunkAndExtract(params, input.loaded.text, input.document);
  // 3. WRITE: the chunks and the `pending` candidate rows, committed BEFORE any
  //    classifier call so an interrupted run is recoverable instead of invisible.
  const prepared = await run((tx) => prepareIngest(tx, params, input, processed));
  // 4. DECISION STAGE: the support questions, then classification. Nothing is open.
  const outcome = classification === undefined ? undefined : await classifyDocument(prepared, classification);
  // 5. WRITE: evidence, decisions, history and audit, committed before the answer.
  const result = await run(async (tx) => {
    await persistClassification(
      tx,
      {
        stackId: params.stackId,
        catalogVersion: prepared.catalogVersion,
        classifierVersion: CLASSIFIER_VERSION,
        jevModel: classification?.config.model ?? "",
      },
      prepared.entityIds,
      prepared.spans,
      outcome,
    );
    return finishIngest(tx, prepared, classificationReport(outcome, classification, prepared));
  });
  // The COMMIT above has landed, so no client can see pre-commit state after it.
  res.status(200).json(result);
}

/**
 * Stages 4-6 over one prepared document, outside any transaction.
 *
 * @param prepared - What stages 1-3 produced.
 * @param runtime - The decision client and its configuration.
 * @returns The validated decisions.
 */
async function classifyDocument(
  prepared: PreparedIngest,
  runtime: ClassificationRuntime,
): Promise<ClassificationOutcome> {
  return classifySpans({
    spans: prepared.spans,
    catalog: prepared.catalog,
    runtime,
  });
}

/**
 * The audit section for this run, in whichever of its two shapes applies.
 *
 * It is never absent: a deployment with no credential must be able to learn, from the
 * document it just ingested, that nothing was classified and what that costs a
 * `?type=` filter. The unconfigured shape carries that consequence, plus a structured
 * warning whenever the run actually left candidates undecided.
 *
 * @param outcome - What the decision stage produced, or `undefined` when skipped.
 * @param classification - The runtime, or `undefined` when unconfigured.
 * @param prepared - The run, for the candidate count the warning names.
 * @returns The validated section.
 */
function classificationReport(
  outcome: ClassificationOutcome | undefined,
  classification: ClassificationRuntime | undefined,
  prepared: PreparedIngest,
): ClassificationAudit {
  if (outcome === undefined || classification === undefined) {
    return buildUnconfiguredClassificationAudit({ candidateCount: prepared.spans.length });
  }
  return buildClassificationAudit({
    states: stateCounts(outcome),
    model: classification.config.model,
    baseUrl: reportedBaseUrl(classification.redactedBaseUrl, classification.config.baseUrl),
    catalogVersion: outcome.catalogVersion,
    classifierVersion: CLASSIFIER_VERSION,
  });
}

/**
 * Writes every chunk of one document.
 *
 * Split from the chunking itself on purpose: a chunk's text and its embedding come
 * from provider calls, so producing them may not happen inside the transaction that
 * writes them (S44).
 *
 * `on conflict (document_id, chunk_index) do update` makes a re-ingest rewrite a
 * chunk in place instead of failing the unique index.
 */
export async function persistChunks(
  tx: Database,
  chunks: readonly ChunkResult[],
): Promise<void> {
  for (const chunk of chunks) {
    await upsertChunk(tx, chunk);
  }
}

/**
 * Writes one chunk.
 *
 * pgvector's accepted text form is `[1,2,3]`. It must be passed as a string and
 * cast explicitly: handing postgres-js the JavaScript array makes it expand into a
 * 768-placeholder row constructor, which Postgres rejects as a type error rather
 * than coercing to `vector`.
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
