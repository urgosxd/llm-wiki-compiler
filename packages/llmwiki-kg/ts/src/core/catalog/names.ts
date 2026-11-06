/**
 * @file packages/llmwiki-kg/ts/src/core/catalog/names.ts
 * @description Comparing a proposed type label with the spellings a catalog declares.
 *
 * ## Why one normalizer, shared by the parser and the resolver
 *
 * A catalog is declared by a human and a label arrives from an extractor, a
 * stored row, or a request parameter, so the two rarely agree character for
 * character: `role`, `Role `, `CARRY OUT`, `carry-out`. The parser uses this
 * normalizer to detect duplicates and alias collisions, and the resolver uses it
 * to match a label; if the two used different rules, a catalog could reject as a
 * duplicate two names the resolver then fails to distinguish, or accept an alias
 * that shadows a type at resolution time.
 *
 * ## What is folded, and what is not
 *
 * Case, surrounding whitespace, and internal whitespace or hyphen runs are
 * folded, because those are spelling differences and nothing else. Nothing else
 * is folded: no stemming, no plural folding, no accent stripping, no synonyms.
 * `Processes` does not resolve to `Process` unless the catalog declares that
 * alias, because a silent morphological guess is exactly the kind of quiet
 * coercion this module exists to prevent. The canonical spelling is always
 * whichever one the catalog declares.
 */

import { UNCLASSIFIED_ENTITY_TYPE } from "./types.js";

/** Runs of whitespace or hyphens that separate the words of one label. */
const LABEL_SEPARATOR = /[\s-]+/g;

/** The one separator a normalized label uses between its words. */
const LABEL_JOINER = "_";

/**
 * The comparison key for a type label or a catalog name.
 *
 * @param raw - Any label, from a catalog entry, an extractor proposal, or a request.
 * @returns The lower-case, underscore-joined form used for every comparison.
 */
export function normalizeCatalogName(raw: string): string {
  return raw.trim().replace(LABEL_SEPARATOR, LABEL_JOINER).toLowerCase();
}

/**
 * Whether a label names the entity type this application reserves.
 *
 * Used by the parser to refuse a declaration that would collide with the
 * free-entity convention, and by callers that must not treat that reserved label
 * as a catalog type. The comparison is normalized, so `UNCLASSIFIED ` and
 * `un-classified` are refused exactly like the canonical spelling.
 *
 * @param raw - The label to test.
 * @returns True when the label is the reserved unclassified entity type.
 */
export function isReservedEntityTypeName(raw: string): boolean {
  return normalizeCatalogName(raw) === normalizeCatalogName(UNCLASSIFIED_ENTITY_TYPE);
}
