/**
 * @file src/dimensions/wiki/marker-store.ts
 * @description The three small per-project markers, as rows.
 *
 * ## Why they share one module
 *
 * Pending embedding refreshes, the lint cache and the rule extractor state have
 * nothing in common except their reason for being files: everything else was. Keeping
 * them in one module means a reader sees all three small stores at once, and a change
 * to the tenant-filter rule happens in one place rather than three.
 *
 * ## The one interesting decision
 *
 * `.llmwiki/pending-embeddings.json` and `.llmwiki/quarantined-embeddings.json` were
 * TWO files with ONE shape: `{pageId, attempts}[]`. They differed only in what the
 * list means — retried versus aged out. A `state` column carries that distinction
 * without duplicating the schema, the readers and the caps, so this module exposes a
 * single pair of read/write functions with a state argument.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { toArrayLiteral } from "./sql-array.js";

/** Where a marker entry stands. `pending` is retried; `quarantined` is only reported. */
export type MarkerState = "pending" | "quarantined";

/** One embedding-refresh entry: a page id and how many attempts failed on it. */
export interface RefreshMarkerEntry {
  /** Qualified page id, e.g. `concepts/alpha`. */
  readonly pageId: string;
  /** Failed refresh attempts so far. */
  readonly attempts: number;
}

/** One row of the marker table as Postgres returns it. */
interface MarkerRow extends Record<string, unknown> {
  readonly page_id: string;
  readonly attempts: number;
}

/** One row of the lint cache as Postgres returns it. */
interface LintCacheRow extends Record<string, unknown> {
  readonly input_hash: string;
  readonly findings: unknown;
  readonly error_count: number;
  readonly warning_count: number;
}

/** The cached lint result, in the shape the caller validates. */
export interface StoredLintCache {
  readonly inputHash: string;
  readonly findings: unknown;
  readonly errorCount: number;
  readonly warningCount: number;
}

/**
 * Read the embedding-refresh markers of one Stack in one state.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose markers to read.
 * @param state - Which list to read: retried or quarantined.
 * @returns The entries, in a stable order so a rewrite is deterministic.
 */
export async function readRefreshMarkers(
  db: Database,
  stackId: string,
  state: MarkerState,
): Promise<RefreshMarkerEntry[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<MarkerRow>(sql`
      select page_id, attempts
      from wiki.embedding_refresh_marker
      where stack_id = ${stackId} and state = ${state}
      order by page_id asc
    `);
    return rows.map((row) => ({ pageId: row.page_id, attempts: row.attempts }));
  });
}

/**
 * Replace one Stack's markers in one state with exactly `entries`.
 *
 * ## Why replace rather than merge
 *
 * The file was rewritten WHOLE on every settle, and that is the contract callers
 * depend on: an id that succeeded must disappear from the marker, and a merge would
 * leave it behind to be retried forever. Deleting what is absent is therefore part of
 * the write, not a cleanup.
 *
 * Both statements run in ONE transaction so a crash cannot leave the marker listing
 * an id in neither list.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns these markers.
 * @param state - Which list is being replaced.
 * @param entries - The complete set for that state.
 */
export async function replaceRefreshMarkers(
  db: Database,
  stackId: string,
  state: MarkerState,
  entries: readonly RefreshMarkerEntry[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    for (const entry of entries) {
      await tx.execute(sql`
        insert into wiki.embedding_refresh_marker (stack_id, page_id, attempts, state)
        values (${stackId}, ${entry.pageId}, ${entry.attempts}, ${state})
        on conflict (stack_id, page_id) do update set
          attempts = excluded.attempts,
          state = excluded.state,
          updated_at = now()
      `);
    }
    // Absent means settled: the caller's list IS the marker.
    await tx.execute(sql`
      delete from wiki.embedding_refresh_marker
      where stack_id = ${stackId} and state = ${state}
        and page_id <> all(${toArrayLiteral(entries.map((e) => e.pageId))}::text[])
    `);
  });
}

/**
 * Read one Stack's cached lint result, or undefined when nothing is cached.
 *
 * Named for the STORED result rather than `readLintCache`, which `linter/cache.ts`
 * already exports as the backend-aware entry point. Two exports with one name is how
 * a caller imports the wrong one and never notices.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose cache to read.
 * @returns The cached result, or undefined.
 */
export async function readCachedLintResult(
  db: Database,
  stackId: string,
): Promise<StoredLintCache | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<LintCacheRow>(sql`
      select input_hash, findings, error_count, warning_count
      from wiki.lint_cache
      where stack_id = ${stackId}
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      inputHash: row.input_hash,
      findings: row.findings,
      errorCount: row.error_count,
      warningCount: row.warning_count,
    };
  });
}

/**
 * Store one Stack's lint result, replacing any previous one.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the cache.
 * @param cache - The result to store.
 */
export async function writeCachedLintResult(
  db: Database,
  stackId: string,
  cache: StoredLintCache,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into wiki.lint_cache
        (stack_id, input_hash, findings, error_count, warning_count)
      values (
        ${stackId}, ${cache.inputHash}, ${JSON.stringify(cache.findings)}::jsonb,
        ${cache.errorCount}, ${cache.warningCount}
      )
      on conflict (stack_id) do update set
        input_hash = excluded.input_hash,
        findings = excluded.findings,
        error_count = excluded.error_count,
        warning_count = excluded.warning_count,
        updated_at = now()
    `);
  });
}

/**
 * Read one Stack's rule-extractor state, or undefined when it never ran.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose state to read.
 * @returns The stored snapshot, or undefined.
 */
export async function readRuleExtractorState(
  db: Database,
  stackId: string,
): Promise<unknown | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<{ state: unknown }>(sql`
      select state from wiki.rule_extractor_state where stack_id = ${stackId}
    `);
    return rows[0]?.state;
  });
}

/**
 * Store one Stack's rule-extractor state, replacing any previous snapshot.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the snapshot.
 * @param state - The snapshot to store.
 */
export async function writeRuleExtractorState(
  db: Database,
  stackId: string,
  state: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into wiki.rule_extractor_state (stack_id, state)
      values (${stackId}, ${JSON.stringify(state)}::jsonb)
      on conflict (stack_id) do update set
        state = excluded.state,
        updated_at = now()
    `);
  });
}

