/**
 * @file src/dimensions/wiki/compile-config-store.ts
 * @description The Stack-scoped half of `.llmwiki/state.json`, as a row.
 *
 * ## What this holds, and what it deliberately does not
 *
 * `state.json` carries two kinds of state that look alike and are not:
 *
 *   - per-DOCUMENT bookkeeping (hash, concept slugs, compiled-at), which
 *     `wiki.source_compile_state` already models;
 *   - per-COMPILE coordination (`frozenSlugs`, `frozenEntities`,
 *     `promptModifiers`), which is what this module stores.
 *
 * `indexHash` is not stored. Measured: nothing reads or writes it to make a
 * decision — it exists only in the type and in validation — so persisting it would
 * store a value no caller consults.
 *
 * ## Why `prompt_modifiers` distinguishes NULL from ""
 *
 * The empty string means "a compile ran and none were selected". NULL means "no
 * compile has recorded a digest yet". `promptModifiersChanged` treats an ABSENT
 * field as the same answer as `""`, so collapsing the two here would be harmless
 * today — but it would also erase the only evidence that a compile ever happened,
 * and the next reader would have to guess which meaning a blank was carrying.
 *
 * ## The tenant filter is written twice, on purpose
 *
 * Same reasoning as `page-store.ts`, measured there rather than assumed: RLS only
 * filters when the CONNECTION role is subject to it, and the shared harness
 * connects as `aks`, which is SUPERUSER with BYPASSRLS. The explicit
 * `where stack_id = ...` is the guarantee; the policy is the backstop.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { withTenant } from "./page-store.js";
import { toArrayLiteral } from "./sql-array.js";

/** The compile coordination state of one Stack. */
export interface StoredCompileConfig {
  /** Slugs frozen across batches so content from deleted sources survives. */
  readonly frozenSlugs: readonly string[];
  /** Typed mirror of {@link frozenSlugs}, as branded `concepts/<slug>` ids. */
  readonly frozenEntities: readonly string[];
  /** Prompt-modifier digest of the last compile; `""` means "none selected". */
  readonly promptModifiers: string | null;
}

/** What "this Stack has never compiled" looks like. */
export const EMPTY_COMPILE_CONFIG: StoredCompileConfig = {
  frozenSlugs: [],
  frozenEntities: [],
  promptModifiers: null,
};


/** One row as Postgres returns it. Extends `Record` for the driver's generic. */
interface CompileConfigRow extends Record<string, unknown> {
  readonly frozen_slugs: string[] | null;
  readonly frozen_entities: string[] | null;
  readonly prompt_modifiers: string | null;
}

/**
 * Read one Stack's compile coordination state.
 *
 * A Stack that has never compiled has NO row. That is not an error and not a
 * missing-fault: it is the normal state of a fresh Stack, so it answers
 * {@link EMPTY_COMPILE_CONFIG} rather than throwing or returning undefined. A
 * caller forced to handle `undefined` here would end up inventing an empty value
 * at every site, which is how one of them eventually invents a different one.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose config to read.
 * @returns The stored config, or the empty one when no compile has run.
 */
export async function readCompileConfig(
  db: Database,
  stackId: string,
): Promise<StoredCompileConfig> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<CompileConfigRow>(sql`
      select frozen_slugs, frozen_entities, prompt_modifiers
      from wiki.compile_config
      where stack_id = ${stackId}
    `);
    const row = rows[0];
    if (row === undefined) return EMPTY_COMPILE_CONFIG;
    return {
      frozenSlugs: row.frozen_slugs ?? [],
      frozenEntities: row.frozen_entities ?? [],
      promptModifiers: row.prompt_modifiers,
    };
  });
}

/**
 * Write one Stack's compile coordination state.
 *
 * Upsert rather than insert-then-update: a compile must be able to record its
 * state on a Stack that has never compiled, and doing that as two statements
 * would leave a window where the row exists with defaults that were never the
 * intent.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns this config.
 * @param config - The state to persist.
 */
export async function writeCompileConfig(
  db: Database,
  stackId: string,
  config: StoredCompileConfig,
): Promise<void> {
  await withTenant(db, stackId, async (tx) => {
    await tx.execute(sql`
      insert into wiki.compile_config
        (stack_id, frozen_slugs, frozen_entities, prompt_modifiers)
      values (
        ${stackId},
        ${toArrayLiteral(config.frozenSlugs)}::text[],
        ${toArrayLiteral(config.frozenEntities)}::text[],
        ${config.promptModifiers}
      )
      on conflict (stack_id) do update set
        frozen_slugs = excluded.frozen_slugs,
        frozen_entities = excluded.frozen_entities,
        prompt_modifiers = excluded.prompt_modifiers,
        updated_at = now()
    `);
  });
}
