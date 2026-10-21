import { sql } from "drizzle-orm";

import type { Database } from "../db.js";
import type {
  BackfeedEntityProposalDto,
  BackfeedRelationshipProposalDto,
} from "../dto.js";

/**
 * Consolidation — the TypeScript port of the backfeed half of
 * `app/core/consolidation.py`.
 *
 * ## This module makes no LLM calls
 *
 * Verified by reading the Python source: `consolidate_backfeed_proposal` is pure
 * graph/database logic. Reasoning happened before the item reached the queue;
 * consolidation only absorbs the reviewed result into the ontology. That is what
 * makes this vertical fully verifiable against the oracle without API keys.
 *
 * ## What "absorb" means, measured against the oracle
 *
 * Every entity and relationship written here carries three markers that
 * distinguish backfeed from document extraction:
 *
 * - `verified = true` — a human reviewed it (this is what makes it eligible for
 *   scope graduation in the AKS spec);
 * - `source_kind = 'backfeed'` instead of `'document'`;
 * - `pipeline = 'human-review'` instead of `'llamaindex-schema-extraction'`.
 *
 * `extracted_by_model` is deliberately left NULL, unlike document extraction.
 * Measured on the oracle: `select extracted_by_model from ontology_entities`
 * after an approval returns NULL.
 *
 * ## Returned counts are writes attempted, not rows changed
 *
 * `entities_absorbed` counts every proposal entity the loop handled — an update
 * of an existing entity counts exactly like a fresh insert. `relationships_absorbed`
 * counts every relationship that resolved both endpoints and reached the upsert;
 * a relationship whose endpoints cannot be resolved is skipped and not counted.
 *
 * ## Confidence arithmetic stays in doubles until Postgres rounds it
 *
 * `confidence` is a `real` column. Python computes `min(1.0, existing + 0.1)` in
 * double precision and hands the result to psycopg2, which sends text; Postgres
 * rounds to the nearest `real`. Reproducing the same double arithmetic
 * (`Math.min`, `Number`) and the same text serialization keeps the stored values
 * bit-identical: an existing `0.7` becomes `0.7999999999999999` in the double,
 * which `real` stores as `0.8`, exactly what the oracle shows.
 */

/** Confidence bump applied when backfeed corroborates an existing entity. */
const ENTITY_CONFIDENCE_BUMP = 0.1;

/** `source_kind` written for every row absorbed from an approved proposal. */
const BACKFEED_SOURCE_KIND = "backfeed";

/** `pipeline` written for every row absorbed from an approved proposal. */
const HUMAN_REVIEW_PIPELINE = "human-review";

/** Outcome of one proposal absorption. */
export interface BackfeedConsolidationResult {
  /** Entities inserted or updated. Mirrors `entities_absorbed`. */
  readonly entitiesAbsorbed: number;
  /** Relationships upserted. Mirrors `relationships_absorbed`. */
  readonly relationshipsAbsorbed: number;
}

/**
 * `select id, confidence, description` row from `ontology_entities`.
 *
 * Deliberately not `readonly`: drizzle's `execute<T>` constrains `T` to
 * `Record<string, unknown>`, which a fully-readonly interface does not satisfy.
 */
type EntityLookupRow = {
  id: string;
  confidence: number;
  description: string | null;
};

/**
 * Resolves an entity name to its id within a Stack, case-insensitively.
 *
 * Used only for relationship endpoints that the proposal itself did not carry —
 * Python looks those up against the existing ontology and skips the relationship
 * when the name is unknown rather than inventing an entity.
 */
async function findEntityIdByName(
  tx: Database,
  stackId: string,
  name: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ readonly id: string }>(sql`
    select id
    from ontology_entities
    where stack_id = ${stackId} and lower(name) = lower(${name})
  `);
  return rows[0]?.id;
}

/**
 * Absorbs an approved backfeed proposal into a Stack's ontology.
 *
 * Mirrors `consolidate_backfeed_proposal(conn, stack_id, entities,
 * relationships)`:
 *
 * 1. For each proposed entity, look up an existing row by
 *    `(stack_id, lower(name))`.
 *    - Found: bump confidence by {@link ENTITY_CONFIDENCE_BUMP} (capped at 1.0),
 *      keep the new description only when it is a non-empty string strictly
 *      longer than the stored one, mark `verified`, and touch `last_seen_at` /
 *      `updated_at`.
 *    - Not found: insert with `verified = true` and the backfeed markers.
 * 2. For each proposed relationship, resolve `from_entity` / `to_entity` against
 *    the names just processed and then against the existing ontology; skip when
 *    either side is unknown; otherwise upsert on
 *    `(stack_id, from_entity_id, to_entity_id, type)`.
 *
 * ## Two pass-through quirks preserved on purpose
 *
 * - A NULL description on an *existing* entity is rewritten as the empty string,
 *   because Python's `existing_desc = row["description"] or ""` is what it writes
 *   back. Measured: re-absorbing an entity that had a NULL description leaves
 *   `description = ''`, not NULL.
 * - A NULL proposal description is inserted as SQL NULL (not `''`), because
 *   `ent.get("description", "")` only substitutes when the key is *absent* —
 *   and the flag endpoint always serializes the key, with `None` when unset.
 *
 * `properties` is never written: the entity proposal carries it, but the Python
 * insert statement does not reference it, so absorbed entities keep the column
 * default `{}`. Measured on the oracle.
 *
 * @param tx request-scoped transaction; never the process-wide handle, or reads
 *   and writes would escape the request's transaction.
 * @param stackId Stack the proposal belongs to.
 * @param entities proposed entities, already validated by the DTO.
 * @param relationships proposed relationships, already validated by the DTO.
 */
export async function consolidateBackfeedProposal(
  tx: Database,
  stackId: string,
  entities: readonly BackfeedEntityProposalDto[],
  relationships: readonly BackfeedRelationshipProposalDto[],
): Promise<BackfeedConsolidationResult> {
  /** Lowercased name → entity id, for this proposal only. */
  const nameToId = new Map<string, string>();
  let entitiesAbsorbed = 0;
  let relationshipsAbsorbed = 0;

  for (const entity of entities) {
    const rows = await tx.execute<EntityLookupRow>(sql`
      select id, confidence, description
      from ontology_entities
      where stack_id = ${stackId} and lower(name) = lower(${entity.name})
    `);
    const existing = rows[0];

    if (existing !== undefined) {
      const existingConfidence = Number(existing.confidence);
      // `row["description"] or ""` — a NULL description is treated as empty, and
      // that empty string is what gets written back below.
      const existingDescription = existing.description ?? "";

      const nextConfidence = Math.min(
        1.0,
        existingConfidence + ENTITY_CONFIDENCE_BUMP,
      );

      // "meaningfully longer" per the Python rule: `if ent.get("description")`
      // rejects both `None` and `""`, then the length comparison decides. A
      // rejected candidate keeps the stored description — including the empty
      // string a NULL description was just coerced into.
      const candidate = entity.description;
      const nextDescription =
        candidate !== null &&
        candidate !== "" &&
        candidate.length > existingDescription.length
          ? candidate
          : existingDescription;

      await tx.execute(sql`
        update ontology_entities
        set confidence = ${nextConfidence},
            description = ${nextDescription},
            verified = true,
            last_seen_at = now(),
            updated_at = now()
        where id = ${existing.id}
      `);

      nameToId.set(entity.name.toLowerCase(), existing.id);
    } else {
      const inserted = await tx.execute<{ readonly id: string }>(sql`
        insert into ontology_entities (
          stack_id, name, type, description, confidence,
          verified, source_kind, pipeline
        )
        values (${stackId}, ${entity.name}, ${entity.type},
                ${entity.description}, ${entity.confidence},
                true, ${BACKFEED_SOURCE_KIND}, ${HUMAN_REVIEW_PIPELINE})
        returning id
      `);

      const created = inserted[0];
      if (created === undefined) {
        throw new Error("insert into ontology_entities returned no row");
      }
      nameToId.set(entity.name.toLowerCase(), created.id);
    }

    entitiesAbsorbed += 1;
  }

  for (const relationship of relationships) {
    const fromName = relationship.from_entity.toLowerCase();
    const toName = relationship.to_entity.toLowerCase();

    // Prefer the ids resolved from this proposal's own entities, then fall back
    // to the existing ontology — a proposal may relate new entities to ones the
    // Stack already knows.
    const fromId =
      nameToId.get(fromName) ??
      (await findEntityIdByName(tx, stackId, relationship.from_entity));
    const toId =
      nameToId.get(toName) ??
      (await findEntityIdByName(tx, stackId, relationship.to_entity));

    if (fromId === undefined || toId === undefined) {
      // Skip rather than invent an entity for an unresolved name.
      continue;
    }

    await tx.execute(sql`
      insert into ontology_relationships (
        stack_id, from_entity_id, to_entity_id, type,
        description, confidence, verified,
        source_kind, pipeline
      )
      values (${stackId}, ${fromId}, ${toId}, ${relationship.type},
              ${relationship.description}, ${relationship.confidence},
              true, ${BACKFEED_SOURCE_KIND}, ${HUMAN_REVIEW_PIPELINE})
      on conflict (stack_id, from_entity_id, to_entity_id, type)
      do update set
        confidence = greatest(
          ontology_relationships.confidence,
          excluded.confidence
        ),
        verified = true,
        description = case
          when excluded.confidence > ontology_relationships.confidence
          then excluded.description
          else ontology_relationships.description
        end
    `);

    relationshipsAbsorbed += 1;
  }

  return { entitiesAbsorbed, relationshipsAbsorbed };
}
