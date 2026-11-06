/**
 * @file packages/llmwiki-kg/ts/src/core/identity/key.ts
 * @description The stored identity key: what makes two rows the same entity rather than the same spelling.
 *
 * ## The key is a database contract, so the bare form is not ours to choose
 *
 * `ontology_entities.identity_key` is `NOT NULL` with `unique (stack_id,
 * identity_key)`, and the landed migration already defines the bare form twice:
 * the backfill writes `lower(name)` and the `kg_entity_identity_key` trigger
 * defaults to `lower(btrim(name))`. If this module derived anything else for a
 * name-only identity — collapsing internal whitespace, say — then the same entity
 * would keep the legacy key on old rows and gain a second key on new ones, and
 * `unique (stack_id, identity_key)` would happily store both. A silent duplicate
 * is worse than an imperfect fold, so the bare key is exactly
 * `lower(btrim(name))`; every key this module emits for a name-only subject is
 * byte-identical to what the trigger would have written.
 *
 * ## Reused normalizer, and the one deliberate difference
 *
 * The comparison side reuses `normalizeCatalogName` from
 * `core/catalog/names.ts`, which is the single folding rule this repository
 * declares for labels: case, surrounding space, and internal whitespace or hyphen
 * runs, nothing else. Context labels fold through it because a context is natural
 * language (`"  Legal "` and `"legal"` are one context). Name-only keys cannot,
 * because the trigger does not, which is the whole reason `resolve.ts` matches an
 * un-disambiguated mention by folded name *after* an exact key comparison: the
 * comparison folds more than the stored key, and the stored key is what the
 * database enforces.
 *
 * A canonical id is an opaque token, so it is trimmed and otherwise kept verbatim.
 * Folding `Aks-1` and `Aks_1` onto one key would merge two identifiers that are
 * genuinely different.
 *
 * ## The anchor, and why it is what keeps homonyms apart
 *
 * A disambiguated key is `<bare>#<anchor>` where the anchor is `ctx:<folded
 * context>` or `id:<verbatim id>`. Two `Jordan`s with two contexts therefore carry
 * two keys and two rows. The separator is `#` because the migration already uses
 * `#<uuid>` to split legacy rows that collided on one key, and the `ctx:`/`id:`
 * prefixes keep this namespace disjoint from that suffix: a legacy split key never
 * matches a derived one, so it stays a separate identity until real evidence links
 * it, which is the safe direction.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import type { IdentityDisambiguator, IdentitySubject } from "./types.js";

/** Separator between the folded name and the anchor of an identity key. */
export const IDENTITY_KEY_ANCHOR_SEPARATOR = "#";

/** Anchor prefix for a folded mention context. */
const CONTEXT_ANCHOR = "ctx:";

/** Anchor prefix for a verbatim canonical id. */
const ID_ANCHOR = "id:";

/**
 * The bare, name-only key of a subject, matching the landed trigger and backfill.
 *
 * @param name - The name as spelled.
 * @returns `lower(btrim(name))`, the form `kg_entity_identity_key` would write.
 */
function storedNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The anchor a disambiguator contributes, or `undefined` when it contributes none.
 *
 * A blank context or id carries no information, and inventing an anchor from it
 * would fork a second identity out of nothing; it is treated as "no evidence".
 *
 * @param disambiguator - The evidence attached to a subject.
 * @returns The `ctx:`/`id:` anchor, or `undefined`.
 */
function anchorOf(
  disambiguator: Exclude<IdentityDisambiguator, { readonly kind: "aliasTarget" }>,
): string | undefined {
  if (disambiguator.kind === "mentionContext") {
    const context = normalizeCatalogName(disambiguator.context);
    return context === "" ? undefined : `${CONTEXT_ANCHOR}${context}`;
  }
  const id = disambiguator.id.trim();
  return id === "" ? undefined : `${ID_ANCHOR}${id}`;
}

/**
 * Derives the stable identity key of a subject.
 *
 * An alias target is not appended: the alias inherits its target's whole key, so
 * an alias mention and the canonical identity it names compare equal by key alone.
 * Different targets therefore yield different keys.
 *
 * @param subject - A name plus the evidence that may separate it from a homonym.
 * @returns The key a row for this subject must store.
 */
export function deriveIdentityKey(subject: IdentitySubject): string {
  const nameKey = storedNameKey(subject.name);
  const disambiguator = subject.disambiguator;
  if (disambiguator === undefined) {
    return nameKey;
  }
  if (disambiguator.kind === "aliasTarget") {
    return deriveIdentityKey(disambiguator.target);
  }
  const anchor = anchorOf(disambiguator);
  return anchor === undefined ? nameKey : `${nameKey}${IDENTITY_KEY_ANCHOR_SEPARATOR}${anchor}`;
}

/**
 * Whether a stored key carries a disambiguator.
 *
 * A bare key records that nothing separated its subject from a homonym, so it may
 * be matched by name folding. A disambiguated key records a specific piece of
 * evidence, so it may only ever be matched by that exact key — matching it by name
 * is the merge this module exists to prevent. Keys the migration split with
 * `#<uuid>` also read as disambiguated, which keeps them out of name folding too.
 *
 * @param key - A stored `identity_key`.
 * @returns True when the key carries an anchor.
 */
export function isDisambiguatedIdentityKey(key: string): boolean {
  return key.includes(IDENTITY_KEY_ANCHOR_SEPARATOR);
}
