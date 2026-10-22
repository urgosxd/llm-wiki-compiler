/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/export.ts
 * @description `GET /aks/v1/export` — a portable AKS bundle.
 */

import { sql } from "drizzle-orm";
import type { Request, Response } from "express";

import {
  ENTITY_COLUMNS,
  RELATIONSHIP_COLUMNS,
  fetchContributingDocuments,
  rowToEntity,
  rowToRelationship,
  toPostgresArrayLiteral,
} from "../../core/aks_serializers.js";
import type { EntityRow } from "../../core/aks_serializers.js";
import { resolveStack } from "../../core/stack_resolver.js";
import type { StackRow } from "../../core/stack_resolver.js";
import type { Database } from "../../db.js";
import { AKSBundle, AKSDocumentSummary } from "../../dto.js";
import type { AKSBundleDto } from "../../dto.js";
import { toFastApiValidationError } from "../../errors.js";
import { isFilterSet, pydanticUtcNow, sendApiError, sendValidationError } from "./response.js";
import { EXPORT_QUERY_KEYS, ExportQuery, readQuery } from "./query-params.js";

// GET /aks/v1/export
// ---------------------------------------------------------------------------

/** One `stack_documents` row as the bundle export reads it. */
type BundleDocumentRow = {
  id: string;
  filename: string;
  ingested_at: string;
  source_hash: string;
  truncated: boolean;
  original_length: number | null;
  audit: unknown;
};

/**
 * `GET /aks/v1/export` — the whole Stack as an AKS Bundle.
 *
 * The bundle is assembled from four reads: entities (filtered), the relationships
 * whose **both** endpoints survived that filter, every document in the Stack, and
 * the contributing-document map for the surviving entities.
 *
 * Two details that look like bugs and are not:
 *
 * 1. **`document_count` is not affected by entity filters.** Documents are listed
 *    per Stack, not per selected entity, so `?min_confidence=1` on a Stack with no
 *    confident entities still reports `document_count: 1`. Measured.
 * 2. **Relationships are filtered by endpoint survival, twice.** An edge is kept
 *    only when *both* ends are in the filtered entity set, so a high
 *    `min_confidence` cannot leak a low-confidence neighbour through an edge.
 *    The entity query is skipped entirely when no entities survive, which is why
 *    `relationship_count` is 0 rather than an error.
 *
 * `compiled_at` is the request time, never a stored value: a bundle describes the
 * graph as it was when it was produced.
 */
/** Load the entities the export filter selects. */
async function loadExportEntities(
  tx: Database,
  stackId: string,
  minConfidence: number,
  verifiedOnly: boolean,
  entityType: string | null,
): Promise<EntityRow[]> {
  const verifiedClause = verifiedOnly ? sql`and verified = true` : sql.empty();
  const typeClause = isFilterSet(entityType) ? sql`and type = ${entityType}` : sql.empty();

  return tx.execute<EntityRow>(sql`
    select ${sql.raw(ENTITY_COLUMNS)}
    from ontology_entities
    where stack_id = ${stackId}
      and confidence >= ${minConfidence}
      ${verifiedClause}
      ${typeClause}
  `);
}

/** Load the edges whose BOTH endpoints are being exported. */
async function loadExportRelationships(
  tx: Database,
  stackId: string,
  entityIds: readonly string[],
): Promise<Parameters<typeof rowToRelationship>[0][]> {
  if (entityIds.length === 0) return [];
  return tx.execute<Parameters<typeof rowToRelationship>[0]>(sql`
    select ${sql.raw(RELATIONSHIP_COLUMNS)}
    from ontology_relationships
    where stack_id = ${stackId}
      and from_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
      and to_entity_id = any(${toPostgresArrayLiteral(entityIds)}::uuid[])
  `);
}

/** Load every document in the stack, newest first. */
async function loadExportDocuments(tx: Database, stackId: string): Promise<BundleDocumentRow[]> {
  return tx.execute<BundleDocumentRow>(sql`
    select distinct sd.id, sd.filename, sd.ingested_at,
           sd.source_hash, sd.truncated, sd.original_length, sd.audit
    from stack_documents sd
    where sd.stack_id = ${stackId}
    order by sd.ingested_at desc
  `);
}

export async function exportBundle(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, EXPORT_QUERY_KEYS);
  const query = ExportQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const {
    stack_id: stackId,
    domain,
    min_confidence: minConfidence,
    verified_only: verifiedOnly,
    entity_type: entityType,
  } = query.data;

  const resolved = await resolveStack(tx, stackId, domain);
  if (!resolved.ok) {
    sendApiError(res, resolved.error);
    return;
  }
  const stack: StackRow = resolved.stack;

  const entityRows = await loadExportEntities(
    tx, stack.id, minConfidence, verifiedOnly, entityType,
  );
  const entityIds = entityRows.map((row) => row.id);
  const relationshipRows = await loadExportRelationships(tx, stack.id, entityIds);
  const documentRows = await loadExportDocuments(tx, stack.id);
  const contributing = await fetchContributingDocuments(tx, entityIds);

  const bundle: AKSBundleDto = {
    aks_version: "0.2.0",
    domain: stack.domain,
    stack_id: stack.id,
    stack_name: stack.name,
    compiled_at: pydanticUtcNow(),
    scope: stack.scope,
    entity_count: entityRows.length,
    relationship_count: relationshipRows.length,
    document_count: documentRows.length,
    compilation_strategy: stack.compilation_strategy,
    documents: documentRows.map((row) => AKSDocumentSummary.parse(row)),
    entities: entityRows.map((row) => rowToEntity(row, contributing.get(row.id) ?? [])),
    relationships: relationshipRows.map(rowToRelationship),
  };

  res.json(AKSBundle.parse(bundle));
}

// ---------------------------------------------------------------------------
