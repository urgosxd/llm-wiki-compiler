/**
 * @file packages/llmwiki-kg/ts/src/core/page/cache.ts
 * @description `get_or_generate_page`: cache lookup, generation, upsert.
 *
 * Split out of `core/page_generator.ts` as its own unit because it is the public
 * entry point the route calls, and its job is orchestration — gather, hash, look
 * up, generate on a miss, upsert — rather than any single one of those steps.
 */

import { sql } from "drizzle-orm";

import { config } from "../../config.js";
import type { Database } from "../../db.js";
import { computeGraphVersion } from "./graph-version.js";
import { gatherEntityContext, generateMarkdown } from "./context-read.js";
import { pydanticUtcNow } from "./utc-now.js";
import type { EntityPageContext, PageEntityRow } from "./context.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** What `GET /aks/v1/pages/{entity_name}` answers with. */
export interface EntityPage {
  readonly entity_name: string;
  readonly markdown: string;
  readonly generated_at: string;
  readonly source_entity_id: string;
  readonly graph_version: string;
  readonly source_type: string;
  readonly cached: boolean;
}

/** A cached `entity_pages` row as the read path selects it. */
type CachedPageRow = {
  markdown: string;
  graph_version: string;
  generated_at: string;
  source_type: string;
};

/** The `source_type` every compiled page carries. */
const COMPILED_SOURCE_TYPE = "compiled";

/** The parts of an `EntityPage` that do not depend on whether it was cached. */
function identity(
  context: EntityPageContext,
  entityId: string,
  graphVersion: string,
): Pick<EntityPage, "entity_name" | "source_entity_id" | "graph_version"> {
  return {
    entity_name: context.entity.name,
    source_entity_id: entityId,
    graph_version: graphVersion,
  };
}

/** The fields a cached row supplies as-is. */
function cachedFields(
  cached: CachedPageRow,
): Pick<EntityPage, "markdown" | "generated_at" | "source_type"> {
  return {
    markdown: cached.markdown,
    generated_at: cached.generated_at,
    source_type: cached.source_type,
  };
}

/** The hash over everything a page's text depends on. */
function versionOf(context: EntityPageContext): string {
  return computeGraphVersion(
    context.entity,
    [...context.outgoing, ...context.incoming],
    context.documents.map((document) => document.id),
  );
}

/** The entity's cached page, or `undefined` when it has never been generated. */
async function readCachedPage(
  tx: Database,
  entityId: string,
): Promise<CachedPageRow | undefined> {
  const rows = await tx.execute<CachedPageRow>(sql`
    select markdown, graph_version, generated_at, source_type
    from entity_pages
    where entity_id = ${entityId}
  `);
  return rows[0];
}

/** What a fresh generation needs to persist. */
interface PageWrite {
  readonly entityId: string;
  readonly entity: PageEntityRow;
  readonly markdown: string;
  readonly graphVersion: string;
  readonly generatedAt: string;
}

/** Upserts a generated page over any previous one for the same entity. */
async function storePage(tx: Database, write: PageWrite): Promise<void> {
  const { entityId, entity, markdown, graphVersion, generatedAt } = write;
  await tx.execute(sql`
    insert into entity_pages (
      entity_id, stack_id, entity_name, markdown,
      graph_version, source_type, generated_at,
      generated_by_model
    )
    values (
      ${entityId}, ${entity.stack_id}, ${entity.name}, ${markdown},
      ${graphVersion}, ${COMPILED_SOURCE_TYPE}, ${generatedAt},
      ${config.EXTRACTION_MODEL}
    )
    on conflict (entity_id) do update set
      markdown = excluded.markdown,
      graph_version = excluded.graph_version,
      generated_at = excluded.generated_at,
      generated_by_model = excluded.generated_by_model,
      entity_name = excluded.entity_name
  `);
}

/**
 * `get_or_generate_page` — the public entry point.
 *
 * Gather, hash, look in the cache, and only generate on a miss or a version
 * change. The write is an upsert on `entity_id`, so a regenerated page replaces
 * the old row rather than accumulating history. `stack_id` and `source_type` are
 * not in the `do update` list because the Python statement does not touch them
 * either — an entity never moves between Stacks, and `source_type` is always
 * `compiled`.
 *
 * Returns `null` where Python returns `{}` (the entity vanished between the
 * lookup and the read), which the route answers with a 500.
 */
export async function getOrGeneratePage(
  tx: Database,
  entityId: string,
): Promise<EntityPage | null> {
  const context = await gatherEntityContext(tx, entityId);
  if (context === null) {
    return null;
  }

  const { entity } = context;
  const currentVersion = versionOf(context);
  const cached = await readCachedPage(tx, entityId);

  if (cached !== undefined && cached.graph_version === currentVersion) {
    return { ...identity(context, entityId, currentVersion), ...cachedFields(cached), cached: true };
  }

  const markdown = await generateMarkdown(context);
  const generatedAt = pydanticUtcNow();
  await storePage(tx, { entityId, entity, markdown, graphVersion: currentVersion, generatedAt });
  return {
    ...identity(context, entityId, currentVersion),
    markdown,
    generated_at: generatedAt,
    source_type: COMPILED_SOURCE_TYPE,
    cached: false,
  };
}
