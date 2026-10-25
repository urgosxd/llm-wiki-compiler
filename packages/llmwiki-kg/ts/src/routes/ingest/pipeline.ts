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
import { defaultOntology } from "../../core/default_ontology.js";
import type { ChunkResult, ExtractionResult } from "../../core/extraction-types.js";
import { validateOntology } from "../../core/ontology.js";
import type { Ontology, RejectedTriplet } from "../../core/ontology.js";
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


/**
 * Trailing arguments for the extraction call, given a Stack's stored ontology.
 *
 * Spreading an empty array keeps the call at its original arity, which is the
 * point: with no ontology the parser must behave exactly as the oracle does.
 * Passing `undefined` explicitly would work for the current signature but a
 * future defaulted or overloaded parameter would silently pick up a value that a
 * two-argument call never passed.
 *
 * A null column resolves to {@link defaultOntology} rather than to "no
 * enforcement". `null` used to mean the oracle's permissive behaviour, and that
 * was reversed deliberately: the vocabulary was never absent, it was only
 * unenforced, so the type column accepted `COMPANY` and `FIRM` as different
 * things forever. An unconfigured Stack is now enforced against a documented
 * default, and a rejection it did not ask for is reported in the document's
 * `audit` blob — visible, not silent.
 *
 * A Stack that wants no constraint cannot express that by omitting the field.
 * It declares a wide ontology instead, which is a decision the caller makes
 * explicitly rather than one the schema makes by default.
 *
 * @param stored - The Stack's `ontology` column, or null/undefined when unset.
 * @returns Exactly one validated ontology: the declared one, or the default.
 * @throws {OntologyError} When the stored value is present but not a valid declaration.
 */
function ontologyArgument(stored: unknown): [Ontology] {
  if (stored === null || stored === undefined) return [defaultOntology()];
  return [validateOntology(stored)];
}

/**
 * What the ontology did to this document, in the shape stored in `audit`.
 *
 * ## Why this is recorded at all
 *
 * `IngestionResult` is nine fixed keys, byte-identical to the oracle, so the
 * rejection report cannot travel on the wire. Without a record, a document that
 * yielded three entities because the model drifted out of the declared types is
 * indistinguishable from one that only had three entities in it — which makes a
 * tight ontology look like a thin extraction, and vice versa.
 *
 * ## What `enforced` means now that every run is enforced
 *
 * It used to distinguish "no declaration, so nothing could be rejected" from "a
 * declaration rejected nothing" — two facts with the same count. With a default
 * ontology in force, `enforced` is always `true`, and the field that carries
 * meaning is `declared`: whether the caller wrote this Stack's vocabulary or
 * inherited the default. A document whose types were dropped by a default the
 * caller never chose must be distinguishable from one dropped by a declaration
 * they did choose, because only the second is a bug in their own config.
 */
export interface OntologyAudit {
  readonly enforced: boolean;
  /** Whether the Stack's own declaration was used, rather than the default. */
  readonly declared: boolean;
  readonly rejected: number;
  /** Distinct reason codes, sorted, so the blob is comparable across runs. */
  readonly reason_codes: readonly string[];
  /**
   * The first few dropped triplets by name, in the order the model emitted them.
   *
   * Capped at {@link MAX_AUDIT_SAMPLES}; `rejected` is the true total, so a
   * document with more rejections than samples reads as truncated rather than
   * as complete.
   */
  readonly samples: readonly RejectionSample[];
}

/** One dropped triplet as it appears in the audit blob. */
export interface RejectionSample {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly reason: string;
  /** The type that caused the drop: an entity type or the relation type. */
  readonly offending_type: string;
}

/**
 * How many dropped triplets are reported by name.
 *
 * Five is enough to show the shape of a failure — usually one or two distinct
 * causes repeated — without letting a pathological document write thousands of
 * rows into a `jsonb` column that is read on every `GET /documents/:id`.
 */
const MAX_AUDIT_SAMPLES = 5;

/** Characters kept from a model-supplied name before it is elided. */
const MAX_SAMPLE_NAME_LENGTH = 120;

/** What steps 5 and 6 produced, plus the synthesis decision. */
export interface ProcessedIngest {
  readonly chunks: readonly ChunkResult[];
  readonly extraction: ExtractionResult;
  readonly shouldSynthesize: boolean;
  readonly ontologyAudit: OntologyAudit;
}

/**
 * Summarises what the ontology rejected, for the document's audit record.
 *
 * Reason codes are deduplicated and sorted: the useful question is *which kinds*
 * of violation occurred, and a stable order means two documents with the same
 * problem produce the same blob.
 *
 * `samples` answers the question `rejected: 2` cannot: *which* triplets went
 * missing. A count tells an operator that a document was thin; only names tell
 * them whether the cause was a type they forgot to declare or a model that
 * invented a relationship. It is bounded because `audit` is a `jsonb` column and
 * `MAX_TRIPLETS_PER_CHUNK` is 20, so a many-chunk document can reject hundreds —
 * an unbounded list would turn one long PDF into a large column value for every
 * document it touches.
 *
 * @param declared - Whether the Stack's own declaration was in force.
 * @param rejected - The triplets the ontology turned away.
 * @returns The audit blob's `ontology` object.
 */
function ontologyAudit(
  declared: boolean,
  rejected: readonly RejectedTriplet[],
): OntologyAudit {
  const codes = [...new Set(rejected.map((entry) => entry.reason))].sort();
  return {
    enforced: true,
    declared,
    rejected: rejected.length,
    reason_codes: codes,
    samples: rejected.slice(0, MAX_AUDIT_SAMPLES).map(toRejectionSample),
  };
}

/**
 * One dropped triplet, flattened for the audit blob.
 *
 * Names are trimmed to {@link MAX_SAMPLE_NAME_LENGTH} because entity names come
 * from the model and can be a whole sentence; the reason travels with the sample
 * so a reader does not have to cross-reference `reason_codes` to know why this
 * particular one was dropped.
 */
function toRejectionSample(entry: RejectedTriplet): RejectionSample {
  return {
    subject: truncateName(entry.subject),
    relation: truncateName(entry.relation),
    object: truncateName(entry.object),
    reason: entry.reason,
    offending_type: truncateName(entry.offendingType),
  };
}

/** Shortens a model-supplied name to the audit's budget, marking the cut. */
function truncateName(name: string): string {
  return name.length <= MAX_SAMPLE_NAME_LENGTH
    ? name
    : `${name.slice(0, MAX_SAMPLE_NAME_LENGTH)}…`;
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
  document: {
    readonly stack_name: string;
    readonly stack_synthesize_default: boolean;
    readonly stack_ontology?: unknown;
  },
): Promise<ProcessedIngest> {
  const chunks = await persistChunks(tx, params, text);
  const ontologyArgs = ontologyArgument(document.stack_ontology);
  const extraction = await extractGraphFromChunks(
    chunks,
    document.stack_name,
    ...ontologyArgs,
  );
  const shouldSynthesize =
    params.synthesizeDescriptions ?? document.stack_synthesize_default;
  if (shouldSynthesize) {
    await synthesizeEntityDescriptions(extraction, chunks);
  }
  // The default ontology means extraction always has one, so `rejected` is always
  // populated and the remaining distinction is whether the caller declared it.
  const declared = document.stack_ontology !== null && document.stack_ontology !== undefined;
  const audit = ontologyAudit(declared, extraction.rejected ?? []);
  return { chunks, extraction, shouldSynthesize, ontologyAudit: audit };
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
  const { chunks, extraction, shouldSynthesize, ontologyAudit: audit } = processed;

  // Step 7: consolidate. Entities first — the relationship pass needs the map.
  const written = await consolidateExtraction(tx, params, extraction);

  // Step 7b: record what the ontology did, in the same transaction as the write
  // it describes. A separate transaction could land the graph rows and lose the
  // audit, leaving an ingested document nobody can explain.
  await recordOntologyAudit(tx, params.docId, audit);

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

/**
 * Writes the ontology audit onto the document row.
 *
 * `audit` is the column `db/schema.sql` reserved for exactly this — "structured
 * audit results here later without a schema change" — and nothing wrote it
 * before, so `GET /documents/:id` reported `null` for every ingested document.
 *
 * `jsonb_set` with `create_missing = true` merges into whatever is already
 * there rather than replacing the column, because later audit producers should be
 * able to add their own keys without erasing this one. Stringified before binding
 * and cast once, the same way `routes/stacks.ts` binds its ontology: handing
 * drizzle a bare object produces a parameter Postgres refuses.
 *
 * @param tx - The ingest transaction.
 * @param docId - Document the audit describes.
 * @param audit - What the ontology rejected.
 */
async function recordOntologyAudit(
  tx: Database,
  docId: string,
  audit: OntologyAudit,
): Promise<void> {
  await tx.execute(sql`
    update stack_documents
    set audit = jsonb_set(
      coalesce(audit, '{}'::jsonb), '{ontology}', ${JSON.stringify(audit)}::jsonb, true
    )
    where id = ${docId}
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
