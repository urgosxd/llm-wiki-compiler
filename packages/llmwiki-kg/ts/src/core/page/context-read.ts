/**
 * @file packages/llmwiki-kg/ts/src/core/page/context-read.ts
 * @description Reading an entity's compiled graph state, and generating from it.
 *
 * Split out of `core/page_generator.ts` as its own unit because these are the
 * only statements in the page path that touch the database, and their read order
 * is contractual: both edge reads order by `confidence desc` with no tie-break,
 * exactly as the oracle does, because that order is visible in the prompt.
 */

import { sql } from "drizzle-orm";

import type { Database } from "../../db.js";
import { complete } from "../llm_clients.js";
import { PAGE_MAX_TOKENS, buildPagePrompt } from "./prompt.js";
import type {
  EntityPageContext,
  PageDocumentRow,
  PageEntityRow,
  PageRelationshipRow,
} from "./context.js";

// ---------------------------------------------------------------------------
// Graph reads
// ---------------------------------------------------------------------------

/** The entity itself, or `undefined` when no row has that id. */
async function readEntity(tx: Database, entityId: string): Promise<PageEntityRow | undefined> {
  const rows = await tx.execute<PageEntityRow>(sql`
    select id, stack_id, name, type, description,
           properties::text as properties_text,
           confidence, verified, last_seen_at
    from ontology_entities
    where id = ${entityId}
  `);
  return rows[0];
}

/** Edges leaving `entityId`, other endpoint resolved. Ordered by confidence. */
async function readOutgoingRelationships(
  tx: Database,
  entityId: string,
): Promise<PageRelationshipRow[]> {
  return tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           e.name as other_name, e.type as other_type,
           'outgoing' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.to_entity_id
    where r.from_entity_id = ${entityId}
    order by r.confidence desc
  `);
}

/** Edges entering `entityId`, other endpoint resolved. Ordered by confidence. */
async function readIncomingRelationships(
  tx: Database,
  entityId: string,
): Promise<PageRelationshipRow[]> {
  return tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           e.name as other_name, e.type as other_type,
           'incoming' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.from_entity_id
    where r.to_entity_id = ${entityId}
    order by r.confidence desc
  `);
}

/** Documents that contributed to `entityId`. Ordered by ingestion time. */
async function readContributingDocuments(
  tx: Database,
  entityId: string,
): Promise<PageDocumentRow[]> {
  return tx.execute<PageDocumentRow>(sql`
    select sd.id, sd.filename, sd.ingested_at
    from entity_source_documents esd
    join stack_documents sd on sd.id = esd.document_id
    where esd.entity_id = ${entityId}
    order by sd.ingested_at
  `);
}

/**
 * `gather_entity_context` — everything needed to generate one entity's page.
 *
 * Four reads, in the Python order: the entity, its outgoing edges, its incoming
 * edges, and its contributing documents. Both edge reads order by
 * `confidence desc` with no tie-break, exactly as the oracle does — the order is
 * visible in the prompt, so a tie-break added here would be a prompt change.
 *
 * Returns `null` where Python returns `{}`, so "no such entity" is a distinct
 * type rather than an empty object every caller has to test.
 */
export async function gatherEntityContext(
  tx: Database,
  entityId: string,
): Promise<EntityPageContext | null> {
  const entity = await readEntity(tx, entityId);
  if (entity === undefined) {
    return null;
  }
  const outgoing = await readOutgoingRelationships(tx, entityId);
  const incoming = await readIncomingRelationships(tx, entityId);
  const documents = await readContributingDocuments(tx, entityId);
  return { entity, outgoing, incoming, documents };
}
/**
 * `generate_markdown` — one LLM call, constrained to grounded synthesis.
 *
 * `max_tokens` is 2048, not the module default: a page is much longer than a
 * description and truncation would cut the trailing sections off.
 */
export async function generateMarkdown(context: EntityPageContext): Promise<string> {
  return complete(buildPagePrompt(context), PAGE_MAX_TOKENS);
}
