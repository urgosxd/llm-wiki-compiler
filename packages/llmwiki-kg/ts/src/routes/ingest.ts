import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { MAX_EXTRACTION_CHARS } from "../core/files.js";
import {
  chunkAndEmbed,
  extractGraphFromChunks,
  synthesizeEntityDescriptions,
} from "../core/extraction.js";
import type { ExtractedEntity, ExtractedRelationship } from "../core/extraction.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import { config } from "../config.js";
import { apiError, pydanticBoolean, pydanticUuid, toFastApiValidationError } from "../errors.js";
import type { ApiError, ValidationFailure } from "../errors.js";

/**
 * Ingestion endpoint — the TypeScript port of `app/routers/ingest.py`.
 *
 * One endpoint:
 *
 *   POST /stacks/{stack_id}/documents/{doc_id}/ingest -> 200 with a summary
 *
 * ## The status code is 200, not 201
 *
 * The Python handler declares no `status_code`, so FastAPI defaults a POST to
 * `200`. The task brief quoted a 201 for this endpoint; the live oracle answers
 * **200**, measured three times (successful ingest, re-ingest, and the
 * truncation case). The port follows the oracle.
 *
 * ## Request order is contractual, and was measured
 *
 * 1. **Validation** — both path UUIDs and the optional `synthesize_descriptions`
 *    query flag, reported together in one 422, path entries first in declaration
 *    order (`stack_id`, `doc_id`) then the query entry. Measured:
 *    `POST /stacks/nope/documents/nope2/ingest?synthesize_descriptions=maybe`
 *    returns exactly three entries in that order.
 * 2. **Document lookup** — `404` with `Document <doc_id> not found in Stack
 *    <stack_id>`. Note both ids: an unknown stack and an unknown document are
 *    the *same* 404, because the lookup joins the two tables.
 * 3. **File read** — `500 "Document file is missing on disk"` when the row
 *    exists but the bytes are gone, `415` when the bytes are not UTF-8.
 * 4. **Truncation** at {@link MAX_EXTRACTION_CHARS}; the file on disk is never
 *    modified.
 * 5. **Chunk + embed**, then persist.
 * 6. **Extract**, then optionally **synthesize**.
 * 7. **Consolidate** entities, then relationships.
 * 8. **Tally** and answer.
 *
 * ## Consolidation is reimplemented here, not reused — and the reason matters
 *
 * The task brief says `consolidation.ts` is already ported and should be reused.
 * Reading it shows it ports only the **backfeed** half of
 * `app/core/consolidation.py`: it exports `consolidateBackfeedProposal` and
 * nothing else. The document-extraction half — `consolidate_entities` and
 * `consolidate_relationships`, which this endpoint calls — is **absent**, and
 * its signatures would not fit anyway: it takes extracted entities rather than
 * backfeed proposal DTOs, returns a name→id map that the relationship call
 * consumes, and writes different markers (`source_kind='document'`,
 * `pipeline='llamaindex-schema-extraction'`, `extracted_by_model` populated,
 * confidence bumped by 0.05 instead of 0.1).
 *
 * Since editing `consolidation.ts` is outside this slice's allowed surfaces, the
 * two document-path functions are implemented in this file, reproducing
 * `app/core/consolidation.py` exactly. The mismatch is reported in the handoff
 * so the module can absorb them later. Nothing about the backfeed behaviour is
 * duplicated: {@link consolidateEntityRows} and {@link consolidateRelationshipRows}
 * are a separate code path with different SQL, different constants and different
 * return shapes.
 */

/**
 * `IngestionResult` — the response body, in Pydantic's declaration order.
 *
 * Declared here rather than in `dto.ts` because `dto.ts` is outside this slice's
 * edit surface. Field order is the response's JSON key order, and it matches the
 * oracle byte for byte.
 */
const IngestionResult = z.object({
  document_id: pydanticUuid(),
  chunks_created: z.number().int(),
  entities_extracted: z.number().int(),
  entities_in_stack: z.number().int(),
  relationships_extracted: z.number().int(),
  relationships_written: z.number().int(),
  relationships_in_stack: z.number().int(),
  truncated: z.boolean(),
  descriptions_synthesized: z.boolean(),
});

/** The response payload, derived from {@link IngestionResult} so they cannot drift. */
type IngestionResultDto = z.infer<typeof IngestionResult>;

/** Path-parameter validator for `:stack_id`, keyed by the FastAPI parameter name. */
const StackIdParams = z.object({ stack_id: pydanticUuid() });

/** Path-parameter validator for `:doc_id`. */
const DocIdParams = z.object({ doc_id: pydanticUuid() });

/**
 * Query-parameter validator for `synthesize_descriptions`.
 *
 * `Optional[bool] = Query(None)`: absent is `undefined`, and any present value
 * must be a boolean Pydantic can parse. Measured: `""` and `"maybe"` both answer
 * `bool_parsing`; `"true"`/`"false"` pass. A repeated parameter takes the
 * **last** value, which is what Express's query parser hands over as an array,
 * and what Starlette's `getlist(...)[-1]`-equivalent behaviour yields — measured
 * with `?synthesize_descriptions=true&synthesize_descriptions=false` and the
 * reverse order.
 */
const IngestQuery = z.object({
  synthesize_descriptions: pydanticBoolean().optional(),
});

/** A validated path parameter, or the FastAPI 422 to send instead. */
type ParamParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Validates `:stack_id` the way FastAPI's `UUID` path parameter does. */
function parseStackId(raw: unknown): ParamParse {
  const parsed = StackIdParams.safeParse({ stack_id: raw });
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "path", { stack_id: raw }) };
  }
  return { ok: true, value: parsed.data.stack_id };
}

/** Validates `:doc_id` the way FastAPI's `UUID` path parameter does. */
function parseDocId(raw: unknown): ParamParse {
  const parsed = DocIdParams.safeParse({ doc_id: raw });
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "path", { doc_id: raw }) };
  }
  return { ok: true, value: parsed.data.doc_id };
}

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/**
 * Reads the raw query string value for `synthesize_descriptions`.
 *
 * Express's default query parser turns a repeated key into an array. Pydantic
 * takes the last occurrence, so that is what is returned; everything else is
 * passed through unchanged so the DTO reports the value Pydantic would have
 * seen (`""` stays `""`, not `undefined`).
 */
function queryValue(req: Request, key: string): unknown {
  const raw = req.query[key];
  if (Array.isArray(raw)) {
    return raw.at(-1);
  }
  return raw;
}

/**
 * A `stack_documents` row joined with its Stack, as this endpoint reads it.
 *
 * Deliberately not `readonly`: drizzle's `execute<T>` constrains `T` to
 * `Record<string, unknown>`.
 */
type DocumentRow = {
  id: string;
  stack_id: string;
  storage_path: string;
  stack_name: string;
  stack_synthesize_default: boolean;
};

/** A stored `ontology_entities` row this module reads back. */
type EntityLookupRow = {
  id: string;
  confidence: number;
  description: string | null;
};

/** Confidence bump applied when a re-extraction corroborates an existing entity. */
const ENTITY_CONFIDENCE_BUMP = 0.05;

/** `source_kind` written for every document-derived row. */
const DOCUMENT_SOURCE_KIND = "document";

/** `pipeline` written for every document-derived row. */
const DOCUMENT_PIPELINE = "llamaindex-schema-extraction";

/**
 * `consolidate_entities` — insert or update entities, return the name→id map.
 *
 * Reproduced from `app/core/consolidation.py`, including three details that are
 * observable in the database:
 *
 * 1. **Confidence arithmetic is a double, rounded by `real` on write.** Python
 *    computes `min(1.0, existing + 0.05)` in double precision and psycopg2 sends
 *    it as text; Postgres rounds to the nearest `real`. Reproducing the same
 *    double math keeps stored values identical — `0.7 + 0.05` becomes
 *    `0.75` here exactly as it does there.
 * 2. **A NULL description is rewritten as the empty string.** Python reads
 *    `existing_desc = row["description"] or ""` and writes that back, so an
 *    entity whose description was NULL ends up with `''` after a second ingest.
 *    Measured on the oracle.
 * 3. **The description is replaced only when strictly longer.** `if
 *    ent.description and len(ent.description) > len(existing_desc)`.
 *
 * `extracted_by_model` is populated from `config.EXTRACTION_MODEL` on insert and
 * is **not** touched on update, matching the Python `update` statement.
 *
 * @returns lowercased entity name → entity id, consumed by
 *   {@link consolidateRelationshipRows}.
 */
async function consolidateEntityRows(
  tx: Database,
  stackId: string,
  documentId: string,
  extracted: readonly ExtractedEntity[],
): Promise<Map<string, string>> {
  const nameToId = new Map<string, string>();

  for (const entity of extracted) {
    const rows = await tx.execute<EntityLookupRow>(sql`
      select id, confidence, description
      from ontology_entities
      where stack_id = ${stackId} and lower(name) = lower(${entity.name})
    `);
    const existing = rows[0];
    const key = entity.name.toLowerCase();

    if (existing !== undefined) {
      const existingConfidence = Number(existing.confidence);
      const existingDescription = existing.description ?? "";
      const nextConfidence = Math.min(1.0, existingConfidence + ENTITY_CONFIDENCE_BUMP);
      const nextDescription =
        entity.description !== "" && entity.description.length > existingDescription.length
          ? entity.description
          : existingDescription;

      await tx.execute(sql`
        update ontology_entities
        set confidence = ${nextConfidence},
            description = ${nextDescription},
            last_seen_at = now(),
            updated_at = now()
        where id = ${existing.id}
      `);
      nameToId.set(key, existing.id);
    } else {
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into ontology_entities (
          stack_id, name, type, description, confidence,
          extracted_by_model, source_kind, pipeline
        )
        values (
          ${stackId}, ${entity.name}, ${entity.type}, ${entity.description},
          ${entity.confidence}, ${config.EXTRACTION_MODEL},
          ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE}
        )
        returning id
      `);
      const created = inserted[0];
      if (created === undefined) {
        throw new Error("insert into ontology_entities returned no row");
      }
      nameToId.set(key, created.id);
    }

    // `on conflict (entity_id, document_id) do nothing` — a re-ingest does not
    // duplicate the contribution, which is why `entity_source_documents` keeps
    // exactly one row per entity/document pair.
    const entityId = nameToId.get(key);
    if (entityId === undefined) {
      throw new Error("entity id missing immediately after consolidation");
    }
    await tx.execute(sql`
      insert into entity_source_documents (entity_id, document_id, stack_id)
      values (${entityId}, ${documentId}, ${stackId})
      on conflict (entity_id, document_id) do nothing
    `);
  }

  return nameToId;
}

/**
 * `consolidate_relationships` — upsert edges, return how many were written.
 *
 * Reproduced from `app/core/consolidation.py`. Three behaviours worth naming:
 *
 * - **Unresolvable endpoints are skipped, not invented.** `from_id` and `to_id`
 *   come only from the map built above, so an edge naming an entity the
 *   extractor never emitted is dropped silently. The Python comment says this
 *   is rare; it is also why `relationships_extracted` can exceed
 *   `relationships_written`.
 * - **The UPSERT takes `greatest()` of the confidences** and rewrites the
 *   description only when the incoming confidence is strictly higher. Because
 *   document extraction always emits 0.7, a re-ingest leaves an existing edge's
 *   description and confidence untouched and still counts as written.
 * - **`written` counts attempts, not changed rows.** An update of an unchanged
 *   edge counts exactly like a fresh insert. This is why the measured re-ingest
 *   shows `relationships_written: 1` while `relationships_in_stack` grows to 2:
 *   the write happened, and the row count grew because the *other* relationship
 *   from the second run was a new edge.
 */
async function consolidateRelationshipRows(
  tx: Database,
  stackId: string,
  extracted: readonly ExtractedRelationship[],
  nameToId: ReadonlyMap<string, string>,
): Promise<number> {
  let written = 0;

  for (const relationship of extracted) {
    const fromId = nameToId.get(relationship.fromEntityName.toLowerCase());
    const toId = nameToId.get(relationship.toEntityName.toLowerCase());
    if (fromId === undefined || toId === undefined) {
      continue;
    }

    await tx.execute(sql`
      insert into ontology_relationships (
        stack_id, from_entity_id, to_entity_id, type,
        description, confidence, extracted_by_model, source_kind, pipeline
      )
      values (
        ${stackId}, ${fromId}, ${toId}, ${relationship.type},
        ${relationship.description}, ${relationship.confidence},
        ${config.EXTRACTION_MODEL}, ${DOCUMENT_SOURCE_KIND}, ${DOCUMENT_PIPELINE}
      )
      on conflict (stack_id, from_entity_id, to_entity_id, type)
      do update set
        confidence = greatest(
          ontology_relationships.confidence,
          excluded.confidence
        ),
        description = case
          when excluded.confidence > ontology_relationships.confidence
          then excluded.description
          else ontology_relationships.description
        end
    `);
    written += 1;
  }

  return written;
}

/**
 * Renders an embedding as pgvector's text literal: `[0.1,-0.2,...]`.
 *
 * pgvector has no binary/text input type postgres-js recognizes for the `vector`
 * OID, so the value travels as a plain string and is cast in SQL. `String(number)`
 * is the shortest round-trip form JavaScript produces, so no precision is lost
 * relative to the doubles the provider returned.
 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((component) => String(component)).join(",")}]`;
}

/** True when `error` is ENOENT, without widening the catch to everything. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

/**
 * True when `error` is Node's `ERR_ENCODING_INVALID_ENCODED_DATA`.
 *
 * `Buffer.toString("utf8")` does not throw on invalid bytes — it substitutes
 * U+FFFD. Python's `raw.decode("utf-8")` raises `UnicodeDecodeError`, and the
 * oracle answers 415 for binary content. `TextDecoder` with `fatal: true` is the
 * equivalent that actually fails, so the decode below uses it.
 */
function isDecodeError(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * `POST /stacks/:stack_id/documents/:doc_id/ingest`.
 *
 * Pipeline order mirrors the Python handler exactly; see the module comment for
 * the measured request order and the status codes.
 */
async function ingestDocument(
  req: Request,
  res: Response,
  tx: Database,
): Promise<void> {
  // Step 1: both path parameters and the query flag, reported together. Order is
  // `stack_id`, `doc_id`, then the query entry — measured on the oracle.
  const stackId = parseStackId(req.params["stack_id"]);
  const docId = parseDocId(req.params["doc_id"]);
  const query = IngestQuery.safeParse({
    synthesize_descriptions: queryValue(req, "synthesize_descriptions"),
  });

  if (!stackId.ok || !docId.ok || !query.success) {
    sendValidationFailure(res, [
      ...(stackId.ok ? [] : stackId.failure.body.detail),
      ...(docId.ok ? [] : docId.failure.body.detail),
      ...(query.success
        ? []
        : toFastApiValidationError(query.error, "query", {
            synthesize_descriptions: queryValue(req, "synthesize_descriptions"),
          }).body.detail),
    ]);
    return;
  }

  // Step 2: the document must exist AND belong to this Stack. One joined query,
  // so an unknown Stack and an unknown document are the same 404 carrying both
  // ids — measured wording.
  const documents = await tx.execute<DocumentRow>(sql`
    select sd.id, sd.stack_id, sd.storage_path,
           s.name as stack_name,
           s.synthesize_descriptions as stack_synthesize_default
    from stack_documents sd
    join stacks s on s.id = sd.stack_id
    where sd.id = ${docId.value} and sd.stack_id = ${stackId.value}
  `);
  const document = documents[0];
  if (document === undefined) {
    sendApiError(
      res,
      apiError(404, `Document ${docId.value} not found in Stack ${stackId.value}`),
    );
    return;
  }

  // Step 3: read the bytes and decode as UTF-8.
  let text: string;
  try {
    const raw = await readFile(resolve(process.cwd(), document.storage_path));
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    if (isMissingFile(error)) {
      sendApiError(res, apiError(500, "Document file is missing on disk"));
      return;
    }
    if (isDecodeError(error)) {
      sendApiError(
        res,
        apiError(
          415,
          "Document is not UTF-8 text. Binary format support " +
            "(PDF, DOCX) is planned for a later release.",
        ),
      );
      return;
    }
    throw error;
  }

  // Step 4: truncate for extraction only. `truncated` reports whether the text
  // exceeded the limit; the on-disk file keeps every byte.
  const wasTruncated = text.length > MAX_EXTRACTION_CHARS;
  if (wasTruncated) {
    text = text.slice(0, MAX_EXTRACTION_CHARS);
  }

  // Step 5: chunk and embed, then persist with ON CONFLICT DO UPDATE so a
  // re-ingest rewrites a chunk in place instead of failing the unique index.
  const chunks = await chunkAndEmbed(text, stackId.value, docId.value);
  for (const chunk of chunks) {
    // pgvector's accepted text form is `[1,2,3]`. It must be passed as a string
    // and cast explicitly: handing postgres-js the JavaScript array makes it
    // expand into a 768-placeholder row constructor, which Postgres rejects as a
    // type error rather than coercing to `vector`.
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

  // Step 6: extract, then optionally synthesize.
  const extraction = await extractGraphFromChunks(chunks, document.stack_name);

  // Per-call override wins; otherwise the Stack's own setting decides.
  const shouldSynthesize =
    query.data.synthesize_descriptions ?? document.stack_synthesize_default;
  if (shouldSynthesize) {
    await synthesizeEntityDescriptions(extraction, chunks);
  }

  // Step 7: consolidate. Entities first — the relationship pass needs the map.
  const nameToId = await consolidateEntityRows(
    tx,
    stackId.value,
    docId.value,
    extraction.entities,
  );
  const relationshipsWritten = await consolidateRelationshipRows(
    tx,
    stackId.value,
    extraction.relationships,
    nameToId,
  );

  // Step 8: totals for the Stack, after consolidation so they include this run.
  const entityTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_entities where stack_id = ${stackId.value}
  `);
  const relationshipTotals = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ontology_relationships where stack_id = ${stackId.value}
  `);

  const payload: IngestionResultDto = {
    document_id: docId.value,
    chunks_created: chunks.length,
    entities_extracted: extraction.entities.length,
    entities_in_stack: entityTotals[0]?.n ?? 0,
    relationships_extracted: extraction.relationships.length,
    relationships_written: relationshipsWritten,
    relationships_in_stack: relationshipTotals[0]?.n ?? 0,
    truncated: wasTruncated,
    descriptions_synthesized: shouldSynthesize,
  };

  // `IngestionResult` fixes the key order; parsing pins it to the oracle's.
  res.status(200).json(IngestionResult.parse(payload));
}

/** Sends a combined `RequestValidationError` body: `{"detail": [...]}`. */
function sendValidationFailure(
  res: Response,
  detail: ValidationFailure["body"]["detail"],
): void {
  res.status(422).json({ detail });
}

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface IngestRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: IngestRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the ingestion router.
 *
 * Declares its full path and is mounted at the application root, mirroring the
 * Python router (`APIRouter(tags=["ingestion"], ...)` with an absolute path and
 * no prefix). Auth is mounted here, as `dependencies=[Depends(require_api_key)]`
 * is in Python.
 */
export function createIngestRouter(
  deps: IngestRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.post("/stacks/:stack_id/documents/:doc_id/ingest", deps.wrap(ingestDocument));

  return router;
}
