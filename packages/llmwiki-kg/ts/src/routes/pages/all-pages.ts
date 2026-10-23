/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/all-pages.ts
 * @description `GET /aks/v1/pages` — the whole Stack as a ZIP.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import { getOrGeneratePage } from "../../core/page_generator.js";
import { resolveStack } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { apiError, toFastApiValidationError } from "../../errors.js";
import { buildArchiveEntries, buildReadme } from "./archive.js";
import { ALL_PAGES_QUERY_KEYS, AllPagesQuery, readQuery, sendApiError, sendValidationError } from "./query.js";
import { buildZipArchive } from "./zip.js";

// GET /aks/v1/pages
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the archive endpoint reads it. */
export type PageTargetRow = { readonly id: string; readonly name: string };

/** Entities eligible for the archive, fixed in `order by name`. */
async function readPageTargets(
  tx: Database,
  stackId: string,
  minConfidence: number,
): Promise<PageTargetRow[]> {
  return tx.execute<PageTargetRow>(sql`
    select id, name from ontology_entities
    where stack_id = ${stackId} and confidence >= ${minConfidence}
    order by name
  `);
}

/**
 * One page per entity, skipping any whose generation yields nothing.
 *
 * Python's `if not page: continue` means the archive is short a file rather than
 * failing the whole download.
 */
async function generatePages(
  tx: Database,
  entityRows: readonly PageTargetRow[],
): Promise<{ entityName: string; markdown: string }[]> {
  const pages: { entityName: string; markdown: string }[] = [];
  for (const entityRow of entityRows) {
    const page = await getOrGeneratePage(tx, entityRow.id);
    if (page === null) {
      continue;
    }
    pages.push({ entityName: page.entity_name, markdown: page.markdown });
  }
  return pages;
}

/**
 * Sends the archive with the oracle's headers.
 *
 * The body is a single `res.write` followed by `res.end()`, not `res.end(buffer)`
 * or `res.send(buffer)`, because those two make Express set `Content-Length`
 * while the oracle answers `transfer-encoding: chunked`. Measured:
 *
 * | Python | `res.end(buf)` | `res.write(buf); res.end()` |
 * |---|---|---|
 * | `transfer-encoding: chunked` | `content-length: 1116` | `transfer-encoding: chunked` |
 *
 * The oracle passes a `StreamingResponse` over an in-memory `BytesIO`, so it
 * never knows the length it is about to send. Writing then ending reproduces
 * that exactly; it costs nothing, because the whole buffer is already built.
 */
function sendArchive(res: Response, archive: Buffer, domain: string): void {
  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=${domain}-entity-pages.zip`);
  res.write(archive);
  res.end();
}

/**
 * `GET /aks/v1/pages` — every page in the Stack as a ZIP of markdown files.
 *
 * `order by name` is what fixes the archive's entry order, so it is part of the
 * contract rather than an incidental detail. An entity whose page cannot be
 * generated is **skipped**: Python's `if not page: continue` means the archive is
 * short a file rather than failing the whole download.
 *
 * A Stack with no entities above `min_confidence` answers `404` with
 * `"Stack has no entities meeting the filter criteria"` — an empty archive is
 * never returned.
 *
 * Response headers are the oracle's, measured: `content-type: application/zip`
 * and `content-disposition: attachment; filename=<domain>-entity-pages.zip`.
 *
 * The body is a single `res.write` followed by `res.end()`, not `res.end(buffer)`
 * or `res.send(buffer)`, because those two make Express set `Content-Length`
 * while the oracle answers `transfer-encoding: chunked`. Measured:
 *
 * | Python | `res.end(buf)` | `res.write(buf); res.end()` |
 * |---|---|---|
 * | `transfer-encoding: chunked` | `content-length: 1116` | `transfer-encoding: chunked` |
 *
 * The oracle passes a `StreamingResponse` over an in-memory `BytesIO`, so it
 * never knows the length it is about to send. Writing then ending reproduces
 * that exactly; it costs nothing, because the whole buffer is already built.
 */
export async function getAllPages(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ALL_PAGES_QUERY_KEYS);
  const query = AllPagesQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const { min_confidence: minConfidence } = query.data;

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const entityRows = await readPageTargets(tx, stack.stack.id, minConfidence);
  if (entityRows.length === 0) {
    sendApiError(res, apiError(404, "Stack has no entities meeting the filter criteria"));
    return;
  }

  // One clock read for the whole archive: the README's timestamp and every
  // entry's DOS timestamp describe the same generation event.
  const now = new Date();
  const pages = await generatePages(tx, entityRows);

  const readme = buildReadme(stack.stack.name, stack.stack.domain, entityRows.length, now);
  const archive = buildZipArchive(buildArchiveEntries(readme, pages), now);
  sendArchive(res, archive, stack.stack.domain);
}
