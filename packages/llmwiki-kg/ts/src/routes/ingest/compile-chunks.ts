/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/compile-chunks.ts
 * @description The compile seam: everything that turns a document's CHUNKS into
 * graph rows, extraction included, with the chunks handed in as an argument.
 *
 * ## Why this module exists
 *
 * The KG pipeline is split the way the wiki already is: an ingest STORES a document's
 * chunks, and a compile READS those chunks and runs the LLM pipeline over them.
 * {@link compileChunks} is the seam that makes that split a move rather than a rewrite,
 * because it does not produce its own chunks: the compile route hands it the rows read
 * back out of `document_chunks` (`document_id, stack_id, chunk_index, content`).
 *
 * Phase one (`pipeline.ts`) does not call it at all. Its only work is chunking,
 * embedding and writing `document_chunks`, which it does through {@link persistChunks}
 * — the same upsert, over the same columns, against the same conflict target as before.
 *
 * ## What this module may read from a chunk
 *
 * Only what a stored `document_chunks` row carries: {@link CompileChunk} is
 * `document_id`, `stack_id`, `chunk_index` and `content`, and that is the type the
 * request takes. Extraction reads `content` and `chunkIndex` and nothing else
 * (`core/graph-extraction.ts`), and evidence is located in `chunk.content` with
 * offsets into that string (`candidates.ts`).
 *
 * The fields a chunk carries only because it came from memory — `embedding`,
 * `tokenCount`, `contentHash`, `chunkerStrategy` — are written by exactly one place
 * here: {@link persistChunks}, which phase one calls with the rows `chunkAndEmbed` just
 * produced. This seam never writes a chunk row: the chunks it is handed were READ BACK
 * from `document_chunks` and hold no embedding, token count or hash, so rewriting those
 * columns with placeholders would corrupt stored rows. Persisting chunks lives in this
 * module only because phase one's write is the same upsert, against the same columns and
 * the same conflict target.
 *
 * ## The stages that live here, and the transactions around them
 *
 * 1. provider stage — extraction (`extractGraphFromChunks`) and the optional
 *    description synthesis. NO transaction is open, so no connection is held across
 *    an external call (S44).
 * 2. WRITE — `prepareIngest`: identity resolution, the evidence spans and the
 *    `pending` candidate rows, committed BEFORE the first classifier call.
 * 3. decision stage — the support questions and then the classification questions,
 *    again with nothing open.
 * 4. WRITE — the classification persistence, and whatever the caller's `commitWith`
 *    step adds. It runs in the SAME transaction on purpose: a caller that writes its
 *    own audit blob there keeps it atomic with the decisions that describe it, which
 *    is the shape the compile route has.
 */

import { sql } from "drizzle-orm";

import {
  extractGraphFromChunks,
  synthesizeEntityDescriptions,
} from "../../core/extraction.js";
import { defaultOntology } from "../../core/default_ontology.js";
import { normalizeCatalogName } from "../../core/catalog/names.js";
import type { StackCatalogResolution } from "../../core/catalog/stack-catalog.js";
import type { TypeCatalog } from "../../core/catalog/types.js";
import {
  buildClassificationAudit,
  buildExtractionAudit,
  buildOntologyAudit,
  buildOpenAudit,
  buildUnconfiguredClassificationAudit,
  writeVerdictDisagreements,
} from "./audit.js";
import type { ClassificationAudit, ExtractionAudit, OntologyAudit, OpenAudit } from "./audit.js";
import { buildCandidateSpans, originalPredicate, relationRef } from "./candidates.js";
import type { CandidateSpan } from "./candidates.js";
import { appendClassificationLog } from "./classification-log.js";
import type { ClassificationLogEntry } from "./classification-log.js";
import { CLASSIFIER_VERSION, classifySpans, stateCounts } from "./classify-stage.js";
import type { ClassificationOutcome, ClassificationRuntime } from "./classify-stage.js";
import { persistClassification } from "./persist-classification.js";
import type { ChunkResult, ExtractionResult } from "../../core/extraction-types.js";
import type { ExtractionContract, ExtractionOptions, ExtractionOutcome } from "../../core/graph-extraction.js";
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
  RelationshipWriteOutcome,
} from "../../core/document-consolidation.js";
import type { Database } from "../../db.js";
import { loadKnownIdentities, toVectorLiteral } from "./request.js";
import type { DocumentRow, IngestParams } from "./request.js";

/**
 * Presents stored chunks as the `ChunkResult` shape the core extractor declares.
 *
 * The core functions take `ChunkResult` because ingest is their original caller and
 * really holds every column, but they READ only `content` and `chunkIndex`
 * (`core/graph-extraction.ts`, `core/description-synthesis.ts`, and the evidence
 * locator in `candidates.ts`). A compile holds exactly those two columns, so the type
 * is widened here — once, in one place — instead of fabricating an embedding, a token
 * count or a hash to satisfy a signature.
 *
 * The invariant this narrowing rests on: nothing downstream may read a column a stored
 * chunk does not have. If the core ever starts reading one, it has to narrow its own
 * parameter type first, which is exactly the check this cast defers to.
 *
 * @param chunks - The document's chunks, in order.
 * @returns The same chunks, typed for the core extractor.
 */
function extractionChunks(chunks: readonly CompileChunk[]): readonly ChunkResult[] {
  return chunks as readonly ChunkResult[];
}

/**
 * Runs one unit of work inside one short transaction.
 *
 * Injected instead of a connection on purpose: the stages decide WHERE the
 * boundaries are, and the router decides how a transaction is opened. That is what
 * lets the same code run under the pool's runner (bounded transactions) and under a
 * request-scoped wrapper (one), with no second copy of the stage order.
 */
export type TransactionRunner = <T>(work: (tx: Database) => Promise<T>) => Promise<T>;

/** The state the candidate rows record, before any classifier has been asked anything. */
const PENDING_STATE = "pending";

/**
 * The fields of a chunk one run actually reads.
 *
 * Exactly the columns a `document_chunks` row carries that this seam consumes:
 * extraction walks `content` per `chunkIndex`, and evidence is located as offsets into
 * `content`. Nothing here is an embedding, a token count or a hash, which is what lets
 * the compile phase feed stored rows without fabricating columns it never loaded.
 */
export interface CompileChunk {
  readonly documentId: string;
  readonly stackId: string;
  readonly chunkIndex: number;
  readonly content: string;
}

/**
 * What a run needs to know about the document it is compiling, before any provider
 * call is made.
 *
 * Deliberately WITHOUT the document body. A compile never reads the file: its input is
 * the chunks the ingest phase stored, so a body here would be a field one caller could
 * fill and the other could only fake. The three facts that do travel are the `stacks`
 * columns extraction and synthesis read (inside {@link DocumentRow}), the resolved
 * catalog the classifier is asked against, and whether the read stage truncated the
 * text — a read-stage fact ingest reports and compile never observes.
 */
export interface CompileInput {
  readonly document: DocumentRow;
  /** The Stack's resolved vocabulary: catalog, version and which column it came from. */
  readonly catalog: StackCatalogResolution;
  /** Whether the text ingest read from disk was truncated. Compile never observes it. */
  readonly truncated: boolean;
}

/** What the provider stage produced, plus the audit sections built from it. */
export interface ProcessedIngest {
  readonly chunks: readonly CompileChunk[];
  readonly extraction: ExtractionResult;
  readonly shouldSynthesize: boolean;
  readonly ontologyAudit: OntologyAudit;
  /** Absent when the extraction degraded nothing. */
  readonly extractionAudit?: ExtractionAudit;
  /** Absent when the run kept nothing outside the catalog and capped nothing. */
  readonly openAudit?: OpenAudit;
}

/** Everything the candidate write hands to the classifier, and what the audit needs. */
export interface PreparedIngest {
  readonly params: IngestParams;
  readonly processed: ProcessedIngest;
  /** One span per candidate: the evidence stage's output. */
  readonly spans: readonly CandidateSpan[];
  /** The catalog version the decisions will be made under. */
  readonly catalogVersion: string;
  /** The catalog itself, so the decision stage is asked against what the Stack declares. */
  readonly catalog: TypeCatalog;
  /** Folded entity name → entity row id, from consolidation. */
  readonly entityIds: ReadonlyMap<string, string>;
  /** How many relationship rows the candidate write attempted. */
  readonly writtenRelationships: number;
  readonly truncated: boolean;
}

/**
 * Everything one compile run is given.
 *
 * The chunks arrive as an argument — that is the whole point of the seam — and the
 * rest is the context a run needs to persist, classify and report. There is no
 * `writeChunkRows` flag: this seam compiles chunks that are ALREADY stored and never
 * writes one, because the rows it receives carry no embedding, token count or hash to
 * write. Phase one owns the chunk write ({@link persistChunks}).
 */
export interface CompileChunksRequest<TCommitted> {
  /** The document's chunks, in order, read back from `document_chunks`. */
  readonly chunks: readonly CompileChunk[];
  /** What the read stage resolved: the document row, the catalog and the truncation fact. */
  readonly input: CompileInput;
  /** The validated request, which carries the stack, the document and the options. */
  readonly params: IngestParams;
  /** How this deployment opens a short transaction. */
  readonly run: TransactionRunner;
  /** The decision runtime, or absent when classification is unconfigured. */
  readonly classification?: ClassificationRuntime;
  /**
   * The caller's own last step, run INSIDE the transaction that persists the
   * classification.
   *
   * It exists so a caller can keep its audit write atomic with the decisions that
   * describe it — the compile route writes its audit blob and builds its payload
   * there.
   */
  readonly commitWith: (
    tx: Database,
    prepared: PreparedIngest,
    classification: ClassificationAudit,
  ) => Promise<TCommitted>;
}

/** What one compile run produced, including whatever the caller's last step returned. */
export interface CompiledChunks<TCommitted> {
  /** The candidate write's output, which is what a response is assembled from. */
  readonly prepared: PreparedIngest;
  /** The audit section for this run, in whichever of its two shapes applies. */
  readonly classification: ClassificationAudit;
  /** What `commitWith` returned. */
  readonly committed: TCommitted;
}

/**
 * Turns one document's CHUNKS into graph rows: extract, persist, classify, persist.
 *
 * This is the phase-two seam. It takes the chunks it processes instead of producing
 * them, so a compile needs no original document body: the compile route reads the
 * stored rows and hands them over, and nothing here ever chunks anything.
 *
 * It performs, in this order, with the transaction boundaries written down in the
 * module header: `extractGraphFromChunks`, the optional `synthesizeEntityDescriptions`,
 * the candidate persistence (identity resolution, evidence spans, `pending` entities and
 * relationships with their consolidation), classification when a runtime is configured,
 * and the classification persistence.
 *
 * @param request - The chunks, the resolved context, the request, the runner and the
 *   caller's last step.
 * @returns The prepared run, its audit section, and what `commitWith` returned.
 */
export async function compileChunks<TCommitted>(
  request: CompileChunksRequest<TCommitted>,
): Promise<CompiledChunks<TCommitted>> {
  const { chunks, input, params, run, classification, commitWith } = request;
  // Provider stage: extraction, and the synthesis when it is asked for. No
  // transaction is open here, and none is opened until the extraction succeeded.
  const processed = await extractAndSynthesize(params, chunks, input.document);
  // Candidate write, committed BEFORE the first classifier call. The chunks are already
  // stored, so this writes graph rows and nothing else.
  const prepared = await run((tx) => prepareIngest(tx, { params, input }, processed));
  // Decision stage: the support questions, then the classification questions.
  const outcome =
    classification === undefined ? undefined : await classifyDocument(prepared, classification);
  const report = classificationReport(outcome, classification, prepared);
  const committed = await run(async (tx) => {
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
    return commitWith(tx, prepared, report);
  });
  return { prepared, classification: report, committed };
}

/**
 * The provider stage: extraction over the chunks, and the optional synthesis.
 *
 * Every call in this function is external — the extraction completion and the
 * description synthesis — so it takes NO database handle at all, which is what makes
 * it impossible to run inside a transaction by accident (S44). The chunking and
 * embedding that produce the chunks happen before this, for the same reason.
 *
 * A per-call `synthesize_descriptions` override wins over the Stack's own column.
 *
 * @param params - The validated request.
 * @param chunks - The chunks to extract from.
 * @param document - The row whose Stack name, ontology and synthesis default apply.
 * @returns The extraction, its audit sections, and the chunks it read.
 */
async function extractAndSynthesize(
  params: IngestParams,
  chunks: readonly CompileChunk[],
  document: DocumentRow,
): Promise<ProcessedIngest> {
  const extracted = await extractGraphFromChunks(
    extractionChunks(chunks),
    document.stack_name,
    ontologyArgument(document.stack_ontology),
    extractionOptions(params),
  );
  // Admission is applied HERE, on what the extraction produced, rather than in the
  // extractor: the contract is a property of this request, and this is the seam that
  // turns an extraction into this document's rows.
  const extraction = admittedExtraction(extracted, params.ontologyContract);
  const shouldSynthesize = params.synthesizeDescriptions ?? document.stack_synthesize_default;
  if (shouldSynthesize) {
    await synthesizeEntityDescriptions(extraction, extractionChunks(chunks));
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

/**
 * What the requested admission contract lets into the graph.
 *
 * ## STRICT WINS, and it is the only value that removes anything
 *
 * `?ontology_contract=strict` is an explicit opt-in to a CLOSED graph, so a caller who
 * asked for it must not receive rows the ontology refused as a side effect of a feature
 * it never invoked — the closed contract is the contract. It is the only value that
 * removes a row: `open` refuses nothing, and `persist` keeps what it refuses.
 *
 * So under `strict` every refused row is removed before anything is written, while the
 * extraction's own `rejected` report is kept untouched: the document's `audit.ontology`
 * still counts what the ontology turned away, because counting a refusal and writing a
 * row for it are two different questions (S6).
 *
 * `open` — the default — removes nothing, and refuses nothing for the declaration's sake:
 * the catalog ORIENTS an open run, so the same input reaches the graph as an admitted row
 * with its `audit.open` mismatch recorded beside it, never as a refused one. The `rejected`
 * class this filter reads is produced by the enforcing side of `rejectTriplet`, which the
 * endpoint reaches only through `strict` or `persist`.
 *
 * `persist` — the third value — removes nothing either, deliberately: it takes the verdict
 * `strict` takes and then KEEPS the triplet, so both classes reach the graph each carrying
 * its class, reason and refused type. The filter below is a negative guard keyed on
 * `strict` alone, and `persist` falls through it untouched for exactly that reason.
 *
 * The verdict itself is NOT re-decided here, under any of the three: `rejectTriplet` and
 * the four checks that produce these classes are untouched (S9). This function only
 * removes what they already refused, and only when the caller asked for that.
 *
 * @param extraction - What the provider stage produced, every row carrying its class.
 * @param contract - The admission contract this request selected.
 * @returns The same extraction on `open`; on `strict`, one without any refused row.
 */
function admittedExtraction(
  extraction: ExtractionOutcome,
  contract: ExtractionContract,
): ExtractionOutcome {
  // A negative guard keyed on ONE value, not a switch: `persist` deliberately falls
  // through here. It keeps the rows the ontology refused so both classes are stored
  // with their class, reason and refused type — the behaviour its name describes.
  if (contract !== "strict") return extraction;
  return {
    ...extraction,
    entities: extraction.entities.filter((entity) => entity.ontologyVerdict !== "rejected"),
    relationships: extraction.relationships.filter(
      (relationship) => relationship.ontologyVerdict !== "rejected",
    ),
  };
}

/**
 * The admission contract one run asks the extractor for.
 *
 * The DEFAULT is `open`, which is what S1 and S7 require: a candidate the catalog
 * does not name is kept with the type and predicate the model proposed. The `strict`
 * contract — the previous pipeline's behaviour, where the declaration was an
 * admission filter — is still available and is selected explicitly per request
 * through the ingest endpoint's `ontology_contract` query parameter, as is `persist`,
 * which enforces the declaration and stores both classes with their reason. The choice
 * is made here, at admission time, which is the only place it can change what enters
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
 * and the difference is only what the model is told: a proposal outside it is kept
 * and reported in the document's `audit`, never dropped.
 *
 * @param stored - The Stack's `ontology` column, or null/undefined when unset.
 * @returns Exactly one validated ontology: the declared one, or the default.
 * @throws {OntologyError} When the stored value is present but not a valid declaration.
 */
function ontologyArgument(stored: unknown): Ontology {
  if (stored === null || stored === undefined) return defaultOntology();
  return validateOntology(stored);
}

/**
 * Identity resolution: one key per extracted mention.
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
 * Writes the candidate rows the extraction produces, BEFORE anything classifies them.
 *
 * They are written as `pending`, which is the schema's "the classifier has not
 * answered yet". That order is what makes the transaction boundary honest — the rows
 * are committed before the classifier is called — and what makes an interrupted run
 * recoverable instead of invisible.
 *
 * ## The refused-but-kept verdicts are recorded HERE, and not by the audit report
 *
 * `ACCEPTED_WINS_SET` keeps a stored acceptance when a recompile refuses the same
 * identity, and clears the reason with it, so the row cannot carry the disagreement (S9).
 * The two consolidation passes report it — `disagreements`, keyed by row id — and it is
 * written in THIS transaction, beside the rows it describes, so the record cannot outlive
 * them and does not depend on a classifier running. It is written on every run, because
 * the writer removes a previous run's key: a record that survived a run which agreed
 * everywhere would be a claim about a graph that no longer exists.
 *
 * @param tx - The transaction the candidate write runs in.
 * @param params - The ingest request.
 * @param extraction - The folded extraction result.
 * @param identityKeys - The identity stage's output, keyed by folded entity name.
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
  const relationships = consolidationRelationships(extraction);
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
  await writeVerdictDisagreements(tx, params.docId, disagreementCounts(entityIds, outcome));
  return { entityIds, writtenRelationships: outcome.written };
}

/** The entity pass's return value, with the counts only its writes could answer riding on it. */
type EntityWriteMap = ReadonlyMap<string, string> & { readonly disagreements?: number };

/**
 * The per-table disagreement counts one candidate write reported, shaped for the audit.
 *
 * A projection rather than two inline expressions, because the two counts come from two
 * different return values and the fallback is the same decision in both cases: a caller
 * that only constructs a partial value need not state the member, while every value these
 * two functions return does.
 *
 * @param entityIds - What the entity pass returned, carrying its disagreement count.
 * @param outcome - What the relationship pass returned, carrying its own.
 * @returns The record `writeVerdictDisagreements` stores, keyed by table.
 */
function disagreementCounts(
  entityIds: EntityWriteMap,
  outcome: RelationshipWriteOutcome,
): { readonly entity: number; readonly relationship: number } {
  return { entity: entityIds.disagreements ?? 0, relationship: outcome.disagreements ?? 0 };
}

/**
 * The relationship rows the candidate write consolidates, still `pending`.
 *
 * The predicate is the verb the model read, not the folded label identity uses:
 * `type` keeps the fold for the projection column, and this column keeps the
 * original wording so "deja sin efecto" survives ingestion verbatim (S2, S30,
 * S31).
 *
 * @param extraction - The folded extraction result.
 * @returns One consolidation row per extracted relationship.
 */
function consolidationRelationships(
  extraction: ExtractionResult,
): ConsolidationRelationship[] {
  return extraction.relationships.map((relationship) => ({
    ...relationship,
    predicate: originalPredicate(relationship),
    classificationState: PENDING_STATE,
  }));
}

/** What the candidate write is given, besides the transaction and the extraction. */
interface PrepareRequest {
  /** The validated request. */
  readonly params: IngestParams;
  /** What the read stage resolved. */
  readonly input: CompileInput;
}

/**
 * The evidence stage plus the `pending` rows, in one short write transaction.
 *
 * No chunk row is written here, and none is written anywhere else in this seam: the
 * chunks were stored by phase one and this run holds only `content` and `chunkIndex` for
 * them. The candidate rows are written as `pending`, committed, and only then is a
 * classifier asked anything.
 *
 * @param tx - The transaction the runner opened.
 * @param request - The validated request and what the read stage resolved.
 * @param processed - What the provider stage produced.
 * @returns Everything the classification stages need.
 */
async function prepareIngest(
  tx: Database,
  request: PrepareRequest,
  processed: ProcessedIngest,
): Promise<PreparedIngest> {
  const { params, input } = request;
  const identityKeys = resolveIdentityKeys(
    processed.extraction,
    await loadKnownIdentities(tx, params.stackId),
  );
  // Evidence is verified against the chunks this transaction just wrote, so the
  // offsets are into the stored text rather than into a pre-trim split.
  const spans = buildCandidateSpans({
    documentId: params.docId,
    extraction: processed.extraction,
    chunks: extractionChunks(processed.chunks),
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
    truncated: input.truncated,
  };
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
 * Module-private: phase one's chunk write goes through {@link persistChunks}, and nothing
 * outside this module writes a chunk row.
 *
 * pgvector's accepted text form is `[1,2,3]`. It must be passed as a string and
 * cast explicitly: handing postgres-js the JavaScript array makes it expand into a
 * 768-placeholder row constructor, which Postgres rejects as a type error rather
 * than coercing to `vector`.
 */
async function upsertChunk(tx: Database, chunk: ChunkResult): Promise<void> {
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

/**
 * The decision stage over one prepared document, outside any transaction.
 *
 * @param prepared - What the candidate write produced.
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
