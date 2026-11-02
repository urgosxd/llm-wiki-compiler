/**
 * JSON export format writer.
 *
 * Produces a structured JSON document containing all wiki pages and their
 * metadata. The schema is intentionally simple and human-readable so it can
 * be consumed directly by scripts, agents, or downstream pipelines without
 * additional transformation.
 *
 * Schema:
 *   { schemaVersion, exportedAt, pageCount, projectId?, pages: ExportPage[] }
 *
 * W4 provenance lives PER PAGE (`ExportPage.modelId` / `promptVersion` plus
 * `contentHash` / `sourceHashes`), stamped into each page at compile time.
 * It is deliberately not summarized at the envelope level: a single
 * export-time model id would misattribute pages compiled under a different
 * model, which is exactly the lineage bug this avoids.
 *
 * `schemaVersion` lets downstream consumers (e.g. the rule importer) pin to a known
 * contract. Increment when a breaking field change lands; additive fields
 * do not require a bump.
 *
 * `projectId` is the optional bridge identifier. When present it pins the
 * on-disk export to a stable identity that downstream consumers (the
 * Atomic Memory adapter especially) use to derive deterministic external
 * IDs. Validation happens at the CLI/programmatic boundary, not here —
 * by the time we serialize, the value has been checked.
 */

import { validateProjectId } from "./project-id.js";
import type { ExportPage } from "./types.js";

/**
 * Monotonically-incremented envelope version.
 * Bump when a breaking field change lands; additive additions do not require a bump.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/**
 * One read-surface health warning carried at the top of the JSON export.
 * Mirrors the neutral `{ code, message }` shape the other read surfaces use.
 */
export interface JsonExportWarning {
  code: string;
  message: string;
}

/** Top-level shape of the JSON export file. */
export interface JsonExportDocument {
  /**
   * Contract version for downstream consumers. Start at 1; increment only on
   * breaking envelope changes so consumers can pin a supported range.
   */
  schemaVersion: number;
  exportedAt: string;
  pageCount: number;
  /** Optional bridge identifier. See `src/export/project-id.ts` for the validation rule. */
  projectId?: string;
  pages: ExportPage[];
  /**
   * Read-surface health warnings. ABSENT (key omitted) for a healthy project so
   * the default export envelope is byte-identical (parity-safe); present ONLY
   * when the compile journal is `pending` (`incomplete-compile`) or `unavailable`
   * (`journal-unavailable`), so a downstream consumer never imports partial
   * post-crash or tampered content as if it were a complete, clean export.
   */
  warnings?: JsonExportWarning[];
}

/**
 * PUBLIC options for the JSON export, exposing ONLY the legitimate caller knob.
 *
 * Deliberately omits `profile`: the profile block is computed and injected by
 * the export PIPELINE after it resolves the active profile, never accepted from
 * caller input — otherwise a default-project caller could FORGE a `profile`
 * block into the document. Callers (SDK `Wiki.exportJson`, the CLI export
 * command) accept this type, not the internal {@link BuildJsonExportOptions}.
 */
export interface ExportJsonOptions {
  /**
   * Optional project identifier. Validated against the bridge contract
   * regex; throws if invalid so a malformed value never reaches disk.
   */
  projectId?: string;
}

/**
 * INTERNAL build options for {@link buildJsonExportDocument}.
 *
 * Extends the public {@link ExportJsonOptions} with the pipeline-only `profile`
 * block. The `profile` field is injected by the export pipeline (which holds
 * `root` and computes the active profile); it is ABSENT for the built-in
 * default so the default envelope gains no `profile` key. Never expose this
 * type at a caller boundary — see {@link ExportJsonOptions}.
 */
export interface BuildJsonExportOptions extends ExportJsonOptions {
  /**
   * Pre-computed read-surface health warnings, injected by the pipeline (which
   * holds `root` and probes the journal). ABSENT for a healthy project so the
   * default envelope gains no `warnings` key. This is
   * pipeline-only — never accepted at the public caller boundary so a
   * default-project caller cannot FORGE a `warnings` block.
   */
  warnings?: JsonExportWarning[];
}

/**
 * Build the JSON export document object from a list of export pages.
 * @param pages - Sorted array of export pages.
 * @param options - Optional bridge envelope fields (e.g. `projectId`).
 * @returns The structured JsonExportDocument object (not serialized).
 */
export function buildJsonExportDocument(
  pages: ExportPage[],
  options: BuildJsonExportOptions = {},
): JsonExportDocument {
  const doc: JsonExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
  };
  if (options.projectId !== undefined) {
    doc.projectId = validateProjectId(options.projectId);
  }
  if (options.warnings !== undefined && options.warnings.length > 0) {
    doc.warnings = options.warnings;
  }
  return doc;
}

/**
 * Build the JSON export document from a list of export pages.
 * @param pages - Sorted array of export pages.
 * @param options - Optional bridge envelope fields (e.g. `projectId`).
 * @returns Pretty-printed JSON string.
 */
export function buildJsonExport(
  pages: ExportPage[],
  options: BuildJsonExportOptions = {},
): string {
  return JSON.stringify(buildJsonExportDocument(pages, options), null, 2);
}
