/**
 * @file src/dimensions/wiki/wiki-state-source.ts
 * @description Load and persist the compile state from rows, not `.llmwiki/state.json`.
 *
 * ## Why the shape in memory does not change
 *
 * Roughly twenty modules read `state.sources[...]` — freshness, lint, the viewer,
 * `rm`, `review-approve`, the compiler's dependency graph, the hasher, the rule
 * extractor. None of them cares WHERE the state came from; they care about the
 * `WikiState` shape. So the migration is not "rewrite twenty callers": it is
 * "change the two places that load and persist", which are
 * `CompileStateDraft.load` and `CompileStateDraft.flush`, plus the read-only
 * classification callers.
 *
 * That is the whole trick, and it is worth stating because the file count (46
 * references to path constants) makes it look like a rewrite.
 *
 * ## Two tables, one shape
 *
 * The persisted state splits across two tables that already exist:
 *
 *   - `wiki.source_compile_state` — one row per document: hash, concept slugs,
 *     compiled-at, and the reusable extraction cache.
 *   - `wiki.compile_config` — one row per Stack: `frozenSlugs`, `frozenEntities`,
 *     `promptModifiers`.
 *
 * This module reassembles them into the single `WikiState` the rest of the code
 * knows, and splits them back on write. A caller never sees the split.
 *
 * ## What is deliberately dropped
 *
 * `indexHash` is NOT persisted, because nothing reads or writes it to make a
 * decision — measured, it exists only in the type and in validation. Carrying it
 * across the migration would store a value no caller consults.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import type { WikiState, SourceState } from "../../utils/types.js";
import { KNOWN_STATE_VERSION } from "../../utils/state.js";
import { readCompileConfig, writeCompileConfig } from "./compile-config-store.js";
import { toArrayLiteral } from "./sql-array.js";

/** One `source_compile_state` row as Postgres returns it. */
interface CompileStateRow extends Record<string, unknown> {
  readonly source_identity: string;
  readonly compiled_hash: string;
  readonly concept_slugs: string[] | null;
  readonly compiled_at: string | Date;
  readonly extraction: unknown;
  readonly entities: string[] | null;
  readonly output_language: string | null;
  readonly source_ref: string | null;
}

/**
 * A stored `compiled_at` as the ISO string `SourceState.compiledAt` expects.
 *
 * `pg` hands timestamps back as `Date` objects, while the file format stores ISO
 * strings. Normalising here keeps `compiledAt` comparable with string arithmetic
 * downstream, and keeps a round trip byte-identical to the file format.
 *
 * @param value - Timestamp as the driver returned it.
 * @returns An ISO-8601 string.
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Rebuild the full state for one Stack from both tables.
 *
 * A Stack with no rows and no config is a Stack that has never compiled: it reads
 * as a valid, EMPTY state rather than as an error. That is what `readState` did for
 * a missing `state.json`, and keeping the same answer means no caller needs a new
 * branch.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose state to read.
 * @returns The reassembled state.
 */
export async function readWikiStateFromRows(db: Database, stackId: string): Promise<WikiState> {
  const [config, rows] = await Promise.all([
    readCompileConfig(db, stackId),
    readCompileStateRows(db, stackId),
  ]);
  const sources: Record<string, SourceState> = {};
  for (const row of rows) sources[row.source_identity] = toSourceState(row);
  return {
    version: KNOWN_STATE_VERSION,
    // Not persisted; see the file header.
    indexHash: "",
    sources,
    ...(config.frozenSlugs.length === 0 ? {} : { frozenSlugs: [...config.frozenSlugs] }),
    ...(config.frozenEntities.length === 0
      ? {}
      : { frozenEntities: [...config.frozenEntities] as never }),
    // NULL means "no compile recorded a digest"; "" means "none selected". Both
    // read as "no modifiers", so the absent case is simply omitted.
    ...(config.promptModifiers === null ? {} : { promptModifiers: config.promptModifiers }),
  };
}

/**
 * Read every `source_compile_state` row for one Stack.
 *
 * Both the binding and the explicit predicate, for the reason measured in
 * `page-store.ts`: under a superuser owner the policy is inert, so a query relying
 * on RLS alone would return every Stack's rows.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose rows to read.
 * @returns The rows, ordered by identity for a stable result.
 */
async function readCompileStateRows(db: Database, stackId: string): Promise<CompileStateRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    return tx.execute<CompileStateRow>(sql`
      select source_identity, compiled_hash, concept_slugs, compiled_at,
             extraction, entities, output_language, source_ref
      from wiki.source_compile_state
      where stack_id = ${stackId}
      order by source_identity asc
    `);
  });
}

/**
 * Map one row onto the `SourceState` shape the compiler already understands.
 *
 * @param row - A `source_compile_state` row.
 * @returns The equivalent source state.
 */
function toSourceState(row: CompileStateRow): SourceState {
  return {
    hash: row.compiled_hash,
    concepts: row.concept_slugs ?? [],
    compiledAt: toIsoString(row.compiled_at),
    ...(row.source_ref === null ? {} : { source: row.source_ref }),
    ...(row.entities === null || row.entities.length === 0
      ? {}
      : { entities: row.entities as never }),
    // The extraction cache is validated on read (fingerprint + hash + ownership), so
    // a malformed one is a cache MISS rather than an error. Passing it through
    // unvalidated here is safe precisely because the validator rejects it.
    ...(row.extraction === null || row.extraction === undefined
      ? {}
      : { extraction: row.extraction as SourceState["extraction"] }),
  };
}

/**
 * Persist a whole state for one Stack.
 *
 * Rewrites the config row and upserts every source row. Rows for documents that no
 * longer appear in `state.sources` are DELETED: a removed source must not leave a
 * compile record behind, or the next run would consider a document that no longer
 * exists to be already compiled.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns this state.
 * @param state - The state to persist.
 */
export async function writeWikiStateToRows(
  db: Database,
  stackId: string,
  state: WikiState,
): Promise<void> {
  await writeCompileConfig(db, stackId, {
    frozenSlugs: state.frozenSlugs ?? [],
    frozenEntities: (state.frozenEntities ?? []) as readonly string[],
    promptModifiers: state.promptModifiers ?? null,
  });
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    for (const [identity, entry] of Object.entries(state.sources)) {
      await tx.execute(sql`
        insert into wiki.source_compile_state
          (stack_id, source_identity, compiled_hash, concept_slugs, compiled_at,
           extraction, entities, output_language, source_ref)
        values (
          ${stackId}, ${identity}, ${entry.hash},
          ${toArrayLiteral(entry.concepts)}::text[],
          ${entry.compiledAt}::timestamptz,
          ${entry.extraction === undefined ? null : JSON.stringify(entry.extraction)}::jsonb,
          ${toArrayLiteral((entry.entities ?? []) as readonly string[])}::text[],
          null,
          ${entry.source ?? null}
        )
        on conflict (stack_id, source_identity) do update set
          compiled_hash = excluded.compiled_hash,
          concept_slugs = excluded.concept_slugs,
          compiled_at = excluded.compiled_at,
          extraction = excluded.extraction,
          entities = excluded.entities,
          source_ref = excluded.source_ref
      `);
    }
    await tx.execute(sql`
      delete from wiki.source_compile_state
      where stack_id = ${stackId}
        and source_identity <> all(${toArrayLiteral(Object.keys(state.sources))}::text[])
    `);
  });
}


/**
 * Bind this Stack's row-backed state to the two-method shape the compile draft takes.
 *
 * Shaped as a closure pair rather than a class so the draft never imports a database
 * type: the draft lives on the compile path, which must stay usable with no database
 * at all.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose state this is.
 * @returns A reader and a writer for that Stack's state.
 */
export function createWikiStateRowsBackend(
  db: Database,
  stackId: string,
): { read(): Promise<WikiState>; write(state: WikiState): Promise<void> } {
  return {
    read: () => readWikiStateFromRows(db, stackId),
    write: (state) => writeWikiStateToRows(db, stackId, state),
  };
}
