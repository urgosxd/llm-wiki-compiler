/**
 * @file packages/llmwiki-kg/ts/src/core/page/graph-version.ts
 * @description `compute_graph_version` — the cache key for a generated page.
 *
 * Split out of `core/page_generator.ts` as its own unit because the hash is
 * nothing but Python-representation formatting over the entity's state, and any
 * deviation from it makes two servers sharing one `entity_pages` table
 * invalidate each other's cache on every read.
 */

import { createHash } from "node:crypto";

import { compareCodePoints, pythonJsonDumps } from "./json-dumps.js";
import { pythonFloatRepr } from "./float-repr.js";
import type { PageEntityRow, PageRelationshipRow } from "./context.js";

/**
 * `compute_graph_version` — the cache key.
 *
 * A stable hash of the entity's compiled state: its name, description,
 * confidence, properties, every relationship (`type|other_name|confidence`,
 * sorted), and every contributing document id (sorted). Any change to any of
 * them changes the hash, which is exactly what invalidates the cache.
 */
export function computeGraphVersion(
  entity: PageEntityRow,
  relationships: readonly PageRelationshipRow[],
  contributingDocumentIds: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(entity.name, "utf8");
  hash.update(entity.description ?? "", "utf8");
  hash.update(pythonFloatRepr(Number(entity.confidence)), "utf8");
  hash.update(pythonJsonDumps(entity.properties_text), "utf8");

  const relationReps = relationships
    .map(
      (relationship) =>
        `${relationship.type}|${relationship.other_name}|${pythonFloatRepr(Number(relationship.confidence))}`,
    )
    .sort(compareCodePoints);
  for (const rep of relationReps) {
    hash.update(rep, "utf8");
  }

  for (const documentId of [...contributingDocumentIds].sort(compareCodePoints)) {
    hash.update(documentId, "utf8");
  }

  return hash.digest("hex").slice(0, 16);
}
