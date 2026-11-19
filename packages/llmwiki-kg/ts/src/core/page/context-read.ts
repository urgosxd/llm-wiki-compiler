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
           confidence, verified, last_seen_at,
           ontology_verdict, ontology_rejection_reason, ontology_offending_type
    from ontology_entities
    where id = ${entityId}
  `);
  return rows[0];
}

/**
 * The ontology-verdict predicate for an edge read, or nothing for the wide default.
 *
 * The page is generated from the graph as it stands, and a refused edge IS part of it,
 * so the default is the wide one. `acceptedOnly` is the caller's own narrowing and is
 * the only thing that removes a row; returning `sql.empty()` otherwise keeps the
 * statement byte-identical to the one this module ran before the flag existed.
 */
function verdictClause(acceptedOnly: boolean): ReturnType<typeof sql> {
  return acceptedOnly ? sql`and r.ontology_verdict = 'accepted'` : sql.empty();
}

/** Edges leaving `entityId`, other endpoint resolved. Ordered by confidence. */
async function readOutgoingRelationships(
  tx: Database,
  entityId: string,
  acceptedOnly: boolean,
): Promise<PageRelationshipRow[]> {
  return tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           r.ontology_verdict, r.ontology_rejection_reason, r.ontology_offending_type,
           e.name as other_name, e.type as other_type,
           'outgoing' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.to_entity_id
    where r.from_entity_id = ${entityId}
      ${verdictClause(acceptedOnly)}
    order by r.confidence desc
  `);
}

/** Edges entering `entityId`, other endpoint resolved. Ordered by confidence. */
async function readIncomingRelationships(
  tx: Database,
  entityId: string,
  acceptedOnly: boolean,
): Promise<PageRelationshipRow[]> {
  return tx.execute<PageRelationshipRow>(sql`
    select r.type, r.confidence, r.description,
           r.ontology_verdict, r.ontology_rejection_reason, r.ontology_offending_type,
           e.name as other_name, e.type as other_type,
           'incoming' as direction
    from ontology_relationships r
    join ontology_entities e on e.id = r.from_entity_id
    where r.to_entity_id = ${entityId}
      ${verdictClause(acceptedOnly)}
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
 * ## The ontology class travels with every row, and can be narrowed away
 *
 * Each edge row carries the class the ontology assigned to it, because the prompt built
 * from this context is read by a model: an edge the ontology refused must arrive marked,
 * or it becomes wiki prose that later reads as a fact. `acceptedOnly` is the caller's
 * own narrowing, and it removes refused edges from BOTH directions — the same
 * argument, polarity and default the HTTP and MCP surfaces use.
 *
 * Returns `null` where Python returns `{}`, so "no such entity" is a distinct
 * type rather than an empty object every caller has to test.
 *
 * @param tx - Transaction carrying the reads.
 * @param entityId - The entity whose page is being generated.
 * @param options - `acceptedOnly` defaults to `false`: the page is generated from the
 *   whole graph, with refused edges marked rather than hidden.
 * @returns The context, or `null` when no row has that id.
 */
export async function gatherEntityContext(
  tx: Database,
  entityId: string,
  options: { readonly acceptedOnly?: boolean } = {},
): Promise<EntityPageContext | null> {
  const acceptedOnly = options.acceptedOnly === true;
  const entity = await readEntity(tx, entityId);
  if (entity === undefined) {
    return null;
  }
  const outgoing = await readOutgoingRelationships(tx, entityId, acceptedOnly);
  const incoming = await readIncomingRelationships(tx, entityId, acceptedOnly);
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
