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
import {
  consolidateEntityRows,
  consolidateRelationshipRows,
} from "../core/document-consolidation.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
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
