/**
 * @file packages/llmwiki-kg/ts/src/core/identity/resolve.ts
 * @description Deciding, per mention, whether it joins a known identity, opens a new one, or stays undecided.
 *
 * ## What a match is allowed to be based on
 *
 * Never the name alone (S29). Three things can attribute a mention, in this order:
 *
 * 1. **An established alias link.** Somebody recorded that this spelling names
 *    that identity, so the mention joins it. Without the link the alias is just
 *    another name and must not become the canonical entity by resemblance.
 * 2. **Key equality.** The mention derives the same identity key as a stored
 *    identity, so the same evidence — the same context or the same canonical id —
 *    is attached to both. This is the only way a disambiguated identity is ever
 *    matched.
 * 3. **Name folding, for bare mentions only, and only when it is unambiguous.**
 *    `Gateway` and `GATEWAY` are one spelling; the stored key is
 *    `lower(btrim(name))`, which folds case and surrounding space but not internal
 *    runs, so an exact key comparison first and a folded comparison second is what
 *    makes those variants resolve together without inventing a second row. A
 *    disambiguated identity is excluded from this step entirely: folding it would
 *    merge a homonym by name.
 *
 * When none of those attribute the mention and the name is already claimed by an
 * identity or two, the answer is `undecided`. Separation is the safe failure: an
 * unattributed mention can be decided later, a wrongly merged one cannot be pulled
 * apart, because its edges, evidence rows and provenance have already moved.
 *
 * ## Why `matched` echoes the stored key: the UUID-preservation invariant of S28
 *
 * A reclassifiable free entity must be updated in place, and re-ingestion must not
 * duplicate it. So a match reports the existing row's `identityId` and the
 * existing row's `identityKey` — never a key re-derived from the mention — and the
 * caller performs `update ... where id = identityId`. That single choice is what
 * preserves, at once, the row's UUID, the `entity_source_documents` and
 * `kg_evidence` rows keyed to it, and every edge whose endpoint is that UUID. A
 * caller that instead re-derived the key and upserted on it would still usually
 * land on the same row, but "usually" is decided by whether the two derivations
 * happen to agree, and the day they don't, the entity forks silently.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import { deriveIdentityKey, isDisambiguatedIdentityKey } from "./key.js";
import type {
  AliasLink,
  ExtractedMention,
  IdentityResolution,
  IdentityResolutionContext,
  KnownIdentity,
  MatchedIdentity,
} from "./types.js";

/**
 * Whether a name-only mention can be attributed by folding.
 *
 * @param mention - The mention to test.
 * @returns True when the mention carries no usable disambiguator.
 */
function isBareMention(mention: ExtractedMention): boolean {
  return deriveIdentityKey(mention) === deriveIdentityKey({ name: mention.name });
}

/**
 * The canonical identities the established alias links point this mention at.
 *
 * A link whose target is not among the known identities is a dangling reference: it
 * attributes nothing, so it is ignored rather than trusted.
 *
 * @param aliasLinks - Established links.
 * @param name - The mention's name.
 * @param known - Identities the Stack holds.
 * @returns Distinct target identities, in link order.
 */
function aliasTargetIdentities(
  aliasLinks: readonly AliasLink[],
  name: string,
  known: readonly KnownIdentity[],
): readonly KnownIdentity[] {
  const folded = normalizeCatalogName(name);
  const targetIds = aliasLinks
    .filter((link) => normalizeCatalogName(link.alias) === folded)
    .map((link) => link.canonicalIdentityId);
  return [...new Set(targetIds)]
    .map((id) => known.find((identity) => identity.id === id))
    .filter((identity): identity is KnownIdentity => identity !== undefined);
}

/**
 * Builds a `matched` outcome from a stored identity.
 *
 * @param ref - The mention being resolved.
 * @param identity - The stored identity it joins.
 * @param via - Which evidence attributed the mention.
 * @returns The outcome.
 */
function matched(ref: string, identity: KnownIdentity, via: MatchedIdentity["matchedVia"]): MatchedIdentity {
  return {
    status: "matched",
    ref,
    identityId: identity.id,
    identityKey: identity.identityKey,
    matchedVia: via,
  };
}

/**
 * Resolves a mention that carries no usable disambiguator.
 *
 * Alias link, then exact key, then folded name, then "is this name already
 * claimed"; anything but an unambiguous answer stays undecided.
 *
 * @param mention - The bare mention.
 * @param known - Identities the Stack holds.
 * @param aliasLinks - Established links.
 * @returns The outcome.
 */
function resolveBareMention(
  mention: ExtractedMention,
  known: readonly KnownIdentity[],
  aliasLinks: readonly AliasLink[],
): IdentityResolution {
  const aliasTargets = aliasTargetIdentities(aliasLinks, mention.name, known);
  if (aliasTargets.length > 1) {
    return { status: "undecided", ref: mention.ref, reason: "ambiguous_alias" };
  }
  const aliasTarget = aliasTargets[0];
  if (aliasTarget !== undefined) {
    return matched(mention.ref, aliasTarget, "alias");
  }

  const rawKey = deriveIdentityKey({ name: mention.name });
  const exact = known.find((identity) => identity.identityKey === rawKey);
  if (exact !== undefined) {
    return matched(mention.ref, exact, "identity_key");
  }

  const folded = normalizeCatalogName(mention.name);
  const sameName = known.filter((identity) => normalizeCatalogName(identity.name) === folded);
  const bares = sameName.filter((identity) => !isDisambiguatedIdentityKey(identity.identityKey));
  const bare = bares[0];
  if (bares.length === 1 && bare !== undefined) {
    return matched(mention.ref, bare, "identity_key");
  }
  if (bares.length > 1 || sameName.length > 0) {
    return { status: "undecided", ref: mention.ref, reason: "insufficient_context" };
  }
  return { status: "new", ref: mention.ref, identityKey: rawKey };
}

/**
 * Resolves one mention.
 *
 * @param mention - The mention to resolve.
 * @param known - Identities the Stack holds.
 * @param aliasLinks - Established links.
 * @returns The outcome.
 */
function resolveMention(
  mention: ExtractedMention,
  known: readonly KnownIdentity[],
  aliasLinks: readonly AliasLink[],
): IdentityResolution {
  if (isBareMention(mention)) {
    return resolveBareMention(mention, known, aliasLinks);
  }
  // A disambiguated mention is matched by its exact key only. Name folding here
  // would attach it to a homonym, and an alias link here would let an abbreviation
  // override the context the source actually provided.
  const key = deriveIdentityKey(mention);
  const exact = known.find((identity) => identity.identityKey === key);
  if (exact !== undefined) {
    return matched(mention.ref, exact, "identity_key");
  }
  return { status: "new", ref: mention.ref, identityKey: key };
}

/**
 * Resolves a batch of extracted mentions against the identities a Stack already holds.
 *
 * The function is pure: it reads its inputs, never queries, never writes, and
 * decides nothing about transactions or persistence. Two `new` outcomes with the
 * same `identityKey` are one identity — insert once per distinct key.
 *
 * @param mentions - The mentions extracted from the documents of this ingest.
 * @param context - Known identities and established alias links.
 * @returns One outcome per mention, in the order the mentions were given.
 */
export function resolveIdentities(
  mentions: readonly ExtractedMention[],
  context: IdentityResolutionContext,
): readonly IdentityResolution[] {
  const aliasLinks = context.aliasLinks ?? [];
  return mentions.map((mention) => resolveMention(mention, context.known, aliasLinks));
}
