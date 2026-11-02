/**
 * @file src/dimensions/wiki/project-config-store.ts
 * @description One Stack's project config, as a row.
 *
 * ## Why this replaces `.llmwiki/config.json`
 *
 * The config holds how a Stack's wiki is REVIEWED (`review`) and how its sources
 * are DISCOVERED (`sources`). Neither is a property of a checkout. Keeping them
 * in a file per clone let two checkouts serving one Stack review and discover
 * differently, with nothing to report the divergence — the defect the rest of
 * this migration series removes.
 *
 * ## Why the document is stored whole
 *
 * `config.json` is an extensible envelope: `requireConfigRecord` retains unknown
 * keys so one consumer never erases another's settings, and the `version` field
 * exists to let the shape grow. Storing it as JSONB keeps that contract; the
 * store owns durability and the caller keeps owning meaning.
 *
 * The file path stays as the FALLBACK for a project with no Stack, exactly as
 * every other seam in this codebase does. A project that never opted into rows
 * must keep behaving the way it always did.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { withTenant } from "./page-store.js";

/** The config envelope a Stack holds, or `undefined` when it holds none. */
export type StoredProjectConfig = Record<string, unknown>;

/**
 * A stored document whose inner version disagrees with its column.
 *
 * Worth its own type rather than a generic error: it means the writer stored
 * something inconsistent, which is a bug in this codebase and never in the
 * Stack's data.
 */
class ProjectConfigVersionMismatch extends Error {
  constructor(
    readonly documentVersion: unknown,
    readonly columnVersion: number,
  ) {
    super(
      `Stored project config has document version ${JSON.stringify(documentVersion)} ` +
        `but column version ${columnVersion}`,
    );
    this.name = "ProjectConfigVersionMismatch";
  }
}

/**
 * Read one Stack's config document.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose config to read.
 * @returns The stored document, or `undefined` when the Stack has none.
 */
export async function readProjectConfig(
  db: Database,
  stackId: string,
): Promise<StoredProjectConfig | undefined> {
  return await withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<{ document: unknown; version: number }>(sql`
      select document, version from wiki.project_config where stack_id = ${stackId}
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    const document = row.document;
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new ProjectConfigVersionMismatch(document, row.version);
    }
    const inner = (document as Record<string, unknown>).version;
    if (inner !== row.version) throw new ProjectConfigVersionMismatch(inner, row.version);
    return document as StoredProjectConfig;
  });
}
