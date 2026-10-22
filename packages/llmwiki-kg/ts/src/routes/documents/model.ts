/**
 * @file packages/llmwiki-kg/ts/src/routes/documents/model.ts
 * @description The `stack_documents` row shape and its verbatim column list.
 *
 * Split out of `routes/documents.ts` as its own unit because the column list
 * repeats the Python module's `select` in order, and all four endpoints
 * interpolate it.
 */

/** Oracle column list, in oracle order. Mirrors the Python `select` lists. */
export const DOCUMENT_COLUMNS =
  "id, stack_id, filename, size_bytes, content_type, source_hash, truncated, original_length, ingested_at, audit";

/** A `stack_documents` row as selected by {@link DOCUMENT_COLUMNS}. */
export type DocumentRow = {
  id: string;
  stack_id: string;
  filename: string;
  size_bytes: number;
  content_type: string | null;
  source_hash: string;
  truncated: boolean;
  original_length: number | null;
  ingested_at: string;
  audit: Record<string, unknown> | null;
};
