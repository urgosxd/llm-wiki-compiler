/**
 * @file src/dimensions/wiki/curated-links-row-store.ts
 * @description The curated-link STORE, backed by `wiki.curated_links` rows (S3, D3).
 *
 * ## Why this exists, and what it is NOT
 *
 * A curated link used to live only in `.llmwiki/curated-links.json` -- a file on the host
 * that compiled. A Stack whose pages live in rows therefore had no durable record of its
 * curated links anywhere, and two hosts serving one Stack did not share them at all.
 * `wiki.curated_links` closes that: one row per record, keyed by the same stable key the
 * file store mints from (source, target, anchor), carrying the anchor plus its prose
 * sides so it can be re-validated against a body nobody has written yet.
 *
 * This module is a BACKEND, not a second implementation. The overlay that re-anchors a
 * record onto a regenerated body is `src/compiler/curated-links-overlay.ts` and runs
 * unchanged on both backends; the bounds and the deduplication rule are
 * `addCuratedLinks` in `src/compiler/curated-links.ts` and are called here rather than
 * restated. What differs is only where the rows live.
 *
 * ## Why the record is stored field for field
 *
 * `CuratedLinkRecord` is the contract the file store already keeps, so every column has a
 * twin and `anchor_before`/`anchor_after` keep the prose that justified the link: without
 * them a drop report could name the page but not the sentence, which is what an operator
 * needs to decide whether the link should be re-proposed.
 *
 * ## Tenancy
 *
 * Every statement runs inside `withTenant`, which binds `app.stack_id` for the
 * transaction. The table has RLS forced, so a statement that forgot the bind would see no
 * rows rather than another Stack's -- but binding here is what makes the reads and writes
 * of one run address one Stack, and it matches every other row store in this layer.
 */

import { sql } from "drizzle-orm";
import type { Database } from "@repo/kg";
import {
  addCuratedLinks,
  CURATED_LINK_STORE_VERSION,
  type CuratedLinkCounts,
  type CuratedLinkProvenance,
  type CuratedLinkRecord,
  type CuratedLinkStorePort,
} from "../../compiler/curated-links.js";
import { withTenant } from "./page-store.js";

/** One `wiki.curated_links` row, as Postgres returns it. */
interface CuratedLinkRow extends Record<string, unknown> {
  readonly stable_key: string;
  readonly source_page_id: string;
  readonly target_page_id: string;
  readonly anchor_text: string;
  readonly anchor_before: string;
  readonly anchor_after: string;
  readonly provenance: string;
  readonly created_at: Date | string;
}

/** The columns one record occupies, in the order every statement here names them. */
const LINK_COLUMNS = sql`
  stable_key, source_page_id, target_page_id, anchor_text, anchor_before,
  anchor_after, provenance, created_at
`;

/**
 * One stored row as a record, in the shape the file store hands the same consumers.
 *
 * `created_at` arrives as a `Date` because the column is `timestamptz`; it is rendered
 * back to the ISO string the record carries on both backends, so a reader cannot tell
 * which store answered.
 *
 * @param row - The row as Postgres returned it.
 * @returns The record.
 */
function recordOf(row: CuratedLinkRow): CuratedLinkRecord {
  return {
    stableKey: row.stable_key,
    sourcePageId: row.source_page_id,
    targetPageId: row.target_page_id,
    anchor: { text: row.anchor_text, before: row.anchor_before, after: row.anchor_after },
    provenance: row.provenance as CuratedLinkProvenance,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Every curated record of one Stack, in the store's canonical order.
 *
 * The order is applied by SQL (source page, target page, key) instead of by `sortLinks`
 * so the read agrees with the table's own indexes. It is a function of the SET, so two
 * runs holding the same links answer identically.
 *
 * @param tx - Handle bound to one Stack.
 * @param stackId - The Stack whose records to read.
 * @returns The records, empty when the Stack has none.
 */
async function readRecords(tx: Database, stackId: string): Promise<CuratedLinkRecord[]> {
  const rows = await tx.execute<CuratedLinkRow>(sql`
    select ${LINK_COLUMNS}
    from wiki.curated_links
    where stack_id = ${stackId}
    order by source_page_id asc, target_page_id asc, stable_key asc
  `);
  return rows.map(recordOf);
}

/**
 * Every trusted curated record of one Stack.
 *
 * The twin of `loadCuratedLinks`: an empty list for a Stack that never curated a link,
 * and never a failure for the caller. The overlay is an improvement to a page, never a
 * precondition for publishing one.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose records to read.
 * @returns The records, or an empty list.
 */
async function loadCuratedLinksFromRows(
  db: Database,
  stackId: string,
): Promise<readonly CuratedLinkRecord[]> {
  return await withTenant(db, stackId, async (tx) => await readRecords(tx, stackId));
}

/**
 * Store the records one review run produced, holding both named bounds.
 *
 * The bounds, the deduplication by stable key and the tally are `addCuratedLinks`'s, so
 * this backend cannot enforce a laxer budget than the file one. Only the records that
 * call reports as NEW are inserted; the conflict clause makes a re-review of the same
 * mention a no-op instead of an error, which keeps a repeated run from failing on the
 * primary key.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns these records.
 * @param incoming - Records in the order the review accepted them.
 * @param tally - Counters to fill with what was stored and what a bound refused.
 */
async function recordCuratedLinksInRows(
  db: Database,
  stackId: string,
  incoming: readonly CuratedLinkRecord[],
  tally: CuratedLinkCounts,
): Promise<void> {
  if (incoming.length === 0) return;
  await withTenant(db, stackId, async (tx) => {
    const stored = await readRecords(tx, stackId);
    const known = new Set(stored.map((record) => record.stableKey));
    const next = addCuratedLinks(
      { version: CURATED_LINK_STORE_VERSION, links: stored },
      incoming,
      tally,
    );
    for (const record of next.links) {
      if (known.has(record.stableKey)) continue;
      await tx.execute(sql`
        insert into wiki.curated_links
          (stack_id, stable_key, source_page_id, target_page_id, anchor_text,
           anchor_before, anchor_after, provenance, created_at)
        values (
          ${stackId},
          ${record.stableKey},
          ${record.sourcePageId},
          ${record.targetPageId},
          ${record.anchor.text},
          ${record.anchor.before},
          ${record.anchor.after},
          ${record.provenance},
          ${record.createdAt}
        )
        on conflict (stack_id, stable_key) do nothing
      `);
    }
  });
}

/**
 * Remove the records the overlay refused to re-anchor.
 *
 * A dead record that stayed behind would be re-dropped and re-reported on every later
 * run, so forgetting it is part of the round trip rather than a cleanup.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns these records.
 * @param stableKeys - Keys of the dropped records.
 * @returns How many rows were removed.
 */
async function dropCuratedLinksFromRows(
  db: Database,
  stackId: string,
  stableKeys: readonly string[],
): Promise<number> {
  if (stableKeys.length === 0) return 0;
  return await withTenant(db, stackId, async (tx) => {
    const removed = await tx.execute<{ stable_key: string }>(sql`
      delete from wiki.curated_links
      where stack_id = ${stackId}
        and stable_key in (${sql.join(stableKeys.map((key) => sql`${key}`), sql`, `)})
      returning stable_key
    `);
    return removed.length;
  });
}

/**
 * The Stack's rows, as the port every curated-link consumer takes.
 *
 * The seam's answer for a project whose pages live in rows: the compile path resolves it
 * from the SAME Stack variable that decides the page seams, so a run cannot read its
 * records from the file while writing its pages to rows.
 *
 * @param db - Database handle of the run.
 * @param stackId - The Stack to read and write.
 * @returns The row-backed port.
 */
export function createRowCuratedLinkStore(
  db: Database,
  stackId: string,
): CuratedLinkStorePort {
  return {
    load: async () => await loadCuratedLinksFromRows(db, stackId),
    record: async (incoming, tally) => await recordCuratedLinksInRows(db, stackId, incoming, tally),
    drop: async (stableKeys) => await dropCuratedLinksFromRows(db, stackId, stableKeys),
  };
}
