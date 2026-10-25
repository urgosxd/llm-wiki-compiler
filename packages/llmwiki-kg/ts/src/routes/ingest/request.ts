/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/request.ts
 * @description Validating an ingest request and reading the document it names.
 *
 * Split out of `routes/ingest.ts` as its own unit because the measured 422 order
 * (both path parameters, then the query flag) and the two file-decoding failures
 * (500 for a missing file, 415 for non-UTF-8) are one self-contained concern.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { MAX_EXTRACTION_CHARS } from "../../core/files.js";
import { bindCallerStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import type { ApiError, ValidationFailure } from "../../errors.js";
import { DocIdParams, IngestQuery, StackIdParams } from "./models.js";


/** A validated path parameter, or the FastAPI 422 to send instead. */
export type ParamParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** Validates `:stack_id` the way FastAPI's `UUID` path parameter does. */
export function parseStackId(raw: unknown): ParamParse {
  const parsed = StackIdParams.safeParse({ stack_id: raw });
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "path", { stack_id: raw }) };
  }
  return { ok: true, value: parsed.data.stack_id };
}

/** Validates `:doc_id` the way FastAPI's `UUID` path parameter does. */
export function parseDocId(raw: unknown): ParamParse {
  const parsed = DocIdParams.safeParse({ doc_id: raw });
  if (!parsed.success) {
    return { ok: false, failure: toFastApiValidationError(parsed.error, "path", { doc_id: raw }) };
  }
  return { ok: true, value: parsed.data.doc_id };
}

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
export function sendApiError(res: Response, error: ApiError): void {
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
export function queryValue(req: Request, key: string): unknown {
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
export type DocumentRow = {
  id: string;
  stack_id: string;
  storage_path: string;
  stack_name: string;
  stack_synthesize_default: boolean;
  /**
   * The Stack's declared ontology, or null.
   *
   * Null is the oracle's behaviour — advertise the default type hints and accept
   * whatever the model emits — so it must reach extraction as *absent*, never as
   * an empty ontology that would reject every triplet.
   */
  stack_ontology: unknown;
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
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((component) => String(component)).join(",")}]`;
}

/** True when `error` is ENOENT, without widening the catch to everything. */
export function isMissingFile(error: unknown): boolean {
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
export function isDecodeError(error: unknown): boolean {
  return error instanceof TypeError;
}

/** A validated ingest request: both ids plus the optional override. */
export interface IngestParams {
  readonly ok: true;
  readonly stackId: string;
  readonly docId: string;
  readonly synthesizeDescriptions: boolean | null;
}

/** Why the request was refused, as the entries FastAPI would report. */
export interface IngestRefusal {
  readonly ok: false;
  readonly detail: ValidationFailure["body"]["detail"];
}

/**
 * Validates both path parameters and the query flag, reported together.
 *
 * Order is `stack_id`, `doc_id`, then the query entry — measured on the oracle.
 */
export function parseIngestRequest(req: Request): IngestParams | IngestRefusal {
  const stackId = parseStackId(req.params["stack_id"]);
  const docId = parseDocId(req.params["doc_id"]);
  const rawQuery = { synthesize_descriptions: queryValue(req, "synthesize_descriptions") };
  const query = IngestQuery.safeParse(rawQuery);

  if (stackId.ok && docId.ok && query.success) {
    return {
      ok: true,
      stackId: stackId.value,
      docId: docId.value,
      synthesizeDescriptions: query.data.synthesize_descriptions ?? null,
    };
  }

  return {
    ok: false,
    detail: [
      ...(stackId.ok ? [] : stackId.failure.body.detail),
      ...(docId.ok ? [] : docId.failure.body.detail),
      ...(query.success
        ? []
        : toFastApiValidationError(query.error, "query", rawQuery).body.detail),
    ],
  };
}

/** The measured 404 wording, which names both ids. */
export function sendDocumentNotFound(res: Response, params: IngestParams): void {
  sendApiError(
    res,
    apiError(404, `Document ${params.docId} not found in Stack ${params.stackId}`),
  );
}

/**
 * The document and its Stack, in one joined query.
 *
 * An unknown Stack and an unknown document are therefore the same 404 carrying
 * both ids — the measured wording.
 *
 * The tenant is bound from the path's `:stack_id` before the query runs. Both
 * tables are tenant-scoped, so under RLS an unbound join matches nothing and every
 * ingest would answer 404. `:stack_id` is the caller's own claim and is already the
 * filter in the WHERE clause, so binding it grants nothing that the query wasn't
 * already asking for — it only lets the policies see the rows the filter selects.
 */
export async function findDocument(
  tx: Database,
  stackId: string,
  docId: string,
): Promise<DocumentRow | undefined> {
  await bindCallerStack(tx, stackId, null);
  const rows = await tx.execute<DocumentRow>(sql`
    select sd.id, sd.stack_id, sd.storage_path,
           s.name as stack_name,
           s.synthesize_descriptions as stack_synthesize_default,
           s.ontology as stack_ontology
    from stack_documents sd
    join stacks s on s.id = sd.stack_id
    where sd.id = ${docId} and sd.stack_id = ${stackId}
  `);
  return rows[0];
}

/** The text read from disk, already truncated for extraction. */
export interface LoadedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Reads and decodes the stored file, truncating for extraction only.
 *
 * `truncated` reports whether the text exceeded the limit; the on-disk file keeps
 * every byte. Sends the 500/415 itself and returns `undefined` when it cannot
 * produce text, so the caller just stops.
 */
export async function readDocumentText(
  res: Response,
  document: DocumentRow,
): Promise<LoadedText | undefined> {
  let text: string;
  try {
    const raw = await readFile(resolve(process.cwd(), document.storage_path));
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    if (isMissingFile(error)) {
      sendApiError(res, apiError(500, "Document file is missing on disk"));
      return undefined;
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
      return undefined;
    }
    throw error;
  }

  if (text.length > MAX_EXTRACTION_CHARS) {
    return { text: text.slice(0, MAX_EXTRACTION_CHARS), truncated: true };
  }
  return { text, truncated: false };
}
