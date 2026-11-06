/**
 * @file packages/llmwiki-kg/ts/src/core/identity/types.ts
 * @description Mentions, aliases and canonical identities, and the three answers identity resolution may give.
 *
 * ## Why the three concepts are separate types and not one "entity"
 *
 * The graph stores one row per **canonical identity**, but the extractor emits
 * **mentions**: one string found in one document chunk, with whatever context that
 * chunk happened to provide. An **alias** is a third thing — a spelling that
 * somebody established refers to a canonical identity. Collapsing the three would
 * make "the same name" indistinguishable from "the same entity", which is exactly
 * the merge S29 forbids: two people called `Jordan`, a document titled `Gateway`
 * and a service named `Gateway`, an abbreviation `J. Smith` that only means
 * `Jordan Smith` because a human said so.
 *
 * ## UNDECIDED is a successful outcome
 *
 * {@link IdentityResolution} carries three statuses, and `undecided` is not an
 * error path. When the evidence cannot tell two identities apart, keeping the
 * mention unattributed preserves the separation that a guess would destroy. It
 * carries no key and no id on purpose: a caller cannot merge what it was not
 * given, and a later pass with better evidence can still decide.
 *
 * ## The matched answer is what preserves UUIDs
 *
 * `matched` reports `identityId` AND `identityKey`, both taken from the stored
 * identity rather than re-derived from the mention. That is the invariant S28
 * depends on: the caller updates the row it was pointed at (same UUID, so same
 * provenance rows and same edges) instead of inserting a second row whose key
 * merely compares equal. See `resolve.ts` for the full argument.
 */

/**
 * A piece of evidence that keeps two same-named subjects apart.
 *
 * - `mentionContext`: the context the mention appeared in ("legal", "the
 *   engineering org"). Natural language, so it is folded like a label.
 * - `canonicalId`: an external or pre-assigned identifier. An opaque token, so it
 *   is kept verbatim; folding it could collide two distinct ids.
 * - `aliasTarget`: the subject this mention is an alias of. The alias inherits its
 *   target's key, which is what makes an established alias land on the canonical
 *   identity instead of opening a second one.
 */
export type IdentityDisambiguator =
  | { readonly kind: "mentionContext"; readonly context: string }
  | { readonly kind: "canonicalId"; readonly id: string }
  | { readonly kind: "aliasTarget"; readonly target: IdentitySubject };

/** Anything that can be turned into an identity key: a name and optional disambiguating evidence. */
export interface IdentitySubject {
  /** The name as it was spelled in the source or proposed by an extractor. */
  readonly name: string;
  /** Evidence that separates this subject from a same-named one; absent when none was found. */
  readonly disambiguator?: IdentityDisambiguator;
}

/** One occurrence of a name in one place, before identity is decided. */
export interface ExtractedMention extends IdentitySubject {
  /** Run-scoped identifier of this mention, so a resolution can be traced back to it. */
  readonly ref: string;
}

/**
 * A canonical identity the Stack already holds.
 *
 * `identityKey` is the stored `ontology_entities.identity_key`; `name` is the
 * display name of that same row. Both are needed: the key decides equality, and
 * the name decides whether a bare mention refers to a name somebody already
 * claimed with a disambiguator.
 */
export interface KnownIdentity {
  /** The row's UUID. Returned unchanged on a match, so the caller updates that row. */
  readonly id: string;
  /** The row's stored `identity_key`. Returned unchanged on a match. */
  readonly identityKey: string;
  /** The row's display name. */
  readonly name: string;
}

/**
 * A link somebody already established between an alias spelling and a canonical identity.
 *
 * The link is what makes an alias mean the canonical entity; without it the alias
 * is merely a name that happens to look like an abbreviation.
 */
export interface AliasLink {
  /** The alias spelling, as a mention of it would read. */
  readonly alias: string;
  /** `KnownIdentity.id` of the canonical identity this alias normalizes to. */
  readonly canonicalIdentityId: string;
}

/** Why a mention could not be attributed. Both reasons mean "keep them apart". */
export type UndecidedReason =
  /** No usable disambiguator, and the name is already taken by identities this mention cannot be told apart from. */
  | "insufficient_context"
  /** The established alias links disagree about which canonical identity the alias names. */
  | "ambiguous_alias";

/** A mention that joins an identity the Stack already holds. */
export interface MatchedIdentity {
  readonly status: "matched";
  readonly ref: string;
  /** The existing row's UUID: the caller updates this row, never inserts a sibling. */
  readonly identityId: string;
  /** The existing row's own key, NOT one re-derived from the mention. */
  readonly identityKey: string;
  /** Which evidence did the matching: key equality, or an established alias link. */
  readonly matchedVia: "identity_key" | "alias";
}

/** A mention that is not an identity yet, and the key its new row must carry. */
export interface NewIdentity {
  readonly status: "new";
  readonly ref: string;
  /**
   * The key to insert.
   *
   * Two `new` outcomes sharing one `identityKey` are ONE identity — the caller
   * inserts once per distinct key and reuses the id for every mention that
   * reported it.
   */
  readonly identityKey: string;
}

/** A mention whose identity the evidence cannot settle. Reported without any key or id. */
export interface UndecidedIdentity {
  readonly status: "undecided";
  readonly ref: string;
  readonly reason: UndecidedReason;
}

/** What resolution answered for one mention. */
export type IdentityResolution = MatchedIdentity | NewIdentity | UndecidedIdentity;

/** The identities and established alias links a resolution is measured against. */
export interface IdentityResolutionContext {
  /** Every identity the Stack currently holds; empty for a first ingest. */
  readonly known: readonly KnownIdentity[];
  /** Established alias links; absent when none were recorded. */
  readonly aliasLinks?: readonly AliasLink[];
}
