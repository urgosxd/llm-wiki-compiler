/**
 * @file packages/llmwiki-kg/ts/src/core/classify/endpoint-types.ts
 * @description What a batch already knows about each endpoint name, and when it refuses to know.
 *
 * ## One computation, two consumers
 *
 * The endpoint types feed both the relation request (as orientation) and the
 * compatibility check (as the thing being checked). Deriving them twice would let
 * JEV be told one type while the constraint check used another, so this module is
 * the single source and `batch.ts` passes the same map to both.
 *
 * ## Names fold; conflicting types resolve to nothing
 *
 * Names are keyed with `normalizeCatalogName`, the same rule the candidate parser
 * uses to decide that a relation's endpoint names a declared entity candidate — so
 * the lookup matches exactly when the parser accepted the relation.
 *
 * When two entity candidates fold to one key and were classified into two DIFFERENT
 * canonical types, no type is reported for that name. That is the honest answer:
 * S29 forbids merging homonyms, so the batch genuinely does not know which entity a
 * relation's endpoint means, and an endpoint type nobody established must not be
 * invented — which also turns the compatibility check into `indeterminate` instead
 * of a fabricated `conflict`.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import type { EntityClassificationDecision } from "./types.js";

/**
 * Collects the canonical type of every endpoint name the batch resolved uniquely.
 *
 * @param decisions - The entity decisions of one batch.
 * @returns Folded name to canonical type, omitting names with no type or two types.
 */
export function endpointCanonicalTypes(
  decisions: readonly EntityClassificationDecision[],
): ReadonlyMap<string, string> {
  const seen = new Map<string, string | null>();
  for (const decision of decisions) {
    if (decision.canonicalType === null) {
      continue;
    }
    const key = normalizeCatalogName(decision.name);
    const previous = seen.get(key);
    seen.set(key, previous === undefined || previous === decision.canonicalType ? decision.canonicalType : null);
  }
  const resolved = new Map<string, string>();
  for (const [key, canonicalType] of seen) {
    if (canonicalType !== null) {
      resolved.set(key, canonicalType);
    }
  }
  return resolved;
}

/**
 * Looks one endpoint name up in a resolved map.
 *
 * @param types - The map {@link endpointCanonicalTypes} produced.
 * @param name - The endpoint name as the relation candidate spelled it.
 * @returns The canonical type, or `null` when the batch knows none for that name.
 */
export function canonicalTypeOfEndpoint(
  types: ReadonlyMap<string, string>,
  name: string,
): string | null {
  return types.get(normalizeCatalogName(name)) ?? null;
}
