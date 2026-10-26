/**
 * @file src/dimensions/wiki/derived-artifact-store.ts
 * @description The rendered navigation artifacts (`index.md`, `MOC.md`), as rows.
 *
 * ## What these artifacts are
 *
 * Both are DERIVED: rendered from the page registry, carrying nothing the registry
 * does not already hold. Nothing in `src/` reads them back; their consumers are a
 * browsing human, the Obsidian vault and the OKF export. They were files because
 * everything was, not because a file was the right shape.
 *
 * ## Why one store for two artifacts
 *
 * They differ only in the key they are stored under and what the renderer emitted.
 * A `kind` column carries that without a second table, a second policy and a second
 * grant -- the same reasoning that put the two embedding markers behind one `state`
 * column.
 *
 * ## Why the rendered text
 *
 * Unlike the activity log, where the OKF export parses headings and the field/data
 * split is load-bearing, nothing parses these. The row therefore stores exactly what
 * the writer produced. If a reader is ever added it should read this text rather than
 * re-derive it: the RENDERER may change, but a stored artifact must not change under
 * the feet of whoever read it.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";

/** Which derived artifact a row holds. */
export type DerivedArtifactKind = "index" | "moc";

/**
 * Store one rendered artifact for a Stack, replacing any prior render.
 *
 * An upsert rather than an insert because regeneration is idempotent by design: the
 * artifact is a FUNCTION of the registry, so writing it twice with the same input
 * must leave one row and not fail.
 *
 * @param db - Database handle.
 * @param stackId - The Stack this artifact belongs to.
 * @param kind - Which artifact is being stored.
 * @param content - Exactly what the renderer emitted.
 */
export async function saveDerivedArtifact(
  db: Database,
  stackId: string,
  kind: DerivedArtifactKind,
  content: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into wiki.derived_artifact (stack_id, kind, content)
      values (${stackId}, ${kind}, ${content})
      on conflict (stack_id, kind) do update set
        content = excluded.content,
        updated_at = now()
    `);
  });
}

/**
 * Read one Stack's rendered artifact, or undefined when it was never generated.
 *
 * Undefined is distinct from empty: a Stack that never compiled has no index, while a
 * Stack that compiled an empty corpus has a valid empty one.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose artifact to read.
 * @param kind - Which artifact to read.
 * @returns The rendered content, or undefined when absent.
 */
export async function readDerivedArtifact(
  db: Database,
  stackId: string,
  kind: DerivedArtifactKind,
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<{ content: string }>(sql`
      select content from wiki.derived_artifact
      where stack_id = ${stackId} and kind = ${kind}
    `);
    return rows[0]?.content;
  });
}
