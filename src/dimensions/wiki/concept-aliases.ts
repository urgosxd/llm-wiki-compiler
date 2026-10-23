/**
 * @file src/dimensions/wiki/concept-aliases.ts
 * @description Persisted record of which concept names resolve to which canonical
 * concept, and the invalidation rule that keeps it honest.
 *
 * Why this is persisted at all: a merge decided in one compile has to survive into
 * the next one, or the same synonym silently splits again on the next run and the
 * user sees a page appear and disappear. Persisting also keeps the review band
 * reversible — a merge that was only probable is stored separately and can be
 * dropped without touching the confident ones.
 *
 * ## Why the record keys on the embedding fingerprint, not the model name
 *
 * A similarity threshold is only meaningful inside one embedding configuration.
 * Vectors produced by different provider, model or endpoint are not comparable,
 * and — as `src/utils/embeddings-store.ts:306` documents — mixing them degrades
 * ranking into noise *with no error at all*, because the dimension does not
 * change. `resolveEmbeddingFingerprint()` already folds provider backend, model
 * and endpoint, and hashes the result because the endpoint routinely carries a
 * credential. Using it here means a configuration change invalidates this record
 * instead of quietly corrupting it.
 *
 * Records written before this field existed carry no fingerprint. They are treated
 * as invalid rather than trusted: a vector score whose configuration nobody
 * recorded is a score nobody can reproduce.
 */

/** Bump when the stored shape changes incompatibly. */
export const CONCEPT_ALIAS_RECORD_VERSION = 1 as const;

/**
 * Bumped whenever a normalization rule or threshold changes.
 *
 * Separate from the version and from the fingerprint: those two catch a shape
 * change and a vector-comparability change, while this catches "the same vectors
 * would now be judged by different rules", which silently changes which merges
 * fire.
 */
export const CONCEPT_IDENTITY_RULESET_VERSION = 1 as const;

/** One merged-away concept name recorded as resolving to a canonical one. */
export interface RecordedConceptAlias {
  /** Slug of the name that was merged away. */
  readonly aliasSlug: string;
  /** Slug of the name that absorbed it. */
  readonly canonicalSlug: string;
  /** Cosine score observed when the merge was decided. */
  readonly score?: number;
}

/** Persisted alias state for one wiki state file. */
export interface ConceptAliasRecord {
  readonly version: typeof CONCEPT_ALIAS_RECORD_VERSION;
  /** Identity of the embedding configuration that produced the decisions. */
  readonly fingerprint: string;
  /** Normalization/threshold ruleset version the decisions were made under. */
  readonly ruleset: number;
  /** Merges whose evidence was confident; always applied. */
  readonly aliases: readonly RecordedConceptAlias[];
  /** Merges inside the review band; applied but reported, and droppable. */
  readonly pending: readonly RecordedConceptAlias[];
}

/** The world the record has to still agree with to be usable. */
export interface ConceptAliasEnvironment {
  /** Active `resolveEmbeddingFingerprint()` value, or `undefined` when embeddings are unavailable. */
  readonly fingerprint: string | undefined;
}

/**
 * Whether a stored record was produced under the configuration active now.
 *
 * @param record - A record read from state, possibly malformed.
 * @param environment - The active embedding identity.
 * @returns True when every recorded decision is reproducible as-is.
 */
export function conceptAliasRecordUsable(
  record: ConceptAliasRecord | undefined,
  environment: ConceptAliasEnvironment,
): boolean {
  if (record === undefined) {
    return false;
  }
  if (record.version !== CONCEPT_ALIAS_RECORD_VERSION) {
    return false;
  }
  if (record.ruleset !== CONCEPT_IDENTITY_RULESET_VERSION) {
    return false;
  }
  if (environment.fingerprint === undefined || record.fingerprint === "") {
    return false;
  }
  return record.fingerprint === environment.fingerprint;
}

/**
 * Builds the record to persist after a resolution run.
 *
 * @param fingerprint - Active embedding identity that produced the decisions.
 * @param aliases - Confident aliases from the resolution.
 * @param pending - Review-band aliases from the resolution.
 */
export function buildConceptAliasRecord(
  fingerprint: string,
  aliases: readonly { readonly aliasSlug: string; readonly canonicalSlug: string; readonly score?: number }[],
  pending: readonly { readonly aliasSlug: string; readonly canonicalSlug: string; readonly score?: number }[],
): ConceptAliasRecord {
  const toRecorded = (entry: {
    readonly aliasSlug: string;
    readonly canonicalSlug: string;
    readonly score?: number;
  }): RecordedConceptAlias => {
    const recorded: RecordedConceptAlias = {
      aliasSlug: entry.aliasSlug,
      canonicalSlug: entry.canonicalSlug,
    };
    return entry.score === undefined ? recorded : { ...recorded, score: entry.score };
  };

  return {
    version: CONCEPT_ALIAS_RECORD_VERSION,
    fingerprint,
    ruleset: CONCEPT_IDENTITY_RULESET_VERSION,
    aliases: aliases.map(toRecorded),
    pending: pending.map(toRecorded),
  };
}

/**
 * Folds the record's aliases into lookup form, confident merges first so a slug
 * that appears in both bands resolves to the confident decision.
 *
 * A record that is unusable under the active configuration contributes nothing:
 * stale scores must never decide a merge now.
 *
 * @param record - Persisted record, if any.
 * @param environment - The active embedding identity.
 * @param includePending - Whether review-band merges participate.
 * @returns Alias slug → canonical slug.
 */
export function aliasLookup(
  record: ConceptAliasRecord | undefined,
  environment: ConceptAliasEnvironment,
  includePending = true,
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  if (record === undefined || !conceptAliasRecordUsable(record, environment)) {
    return lookup;
  }
  const usable = record;
  for (const alias of usable.aliases) {
    lookup.set(alias.aliasSlug, alias.canonicalSlug);
  }
  if (!includePending) {
    return lookup;
  }
  for (const alias of usable.pending) {
    if (!lookup.has(alias.aliasSlug)) {
      lookup.set(alias.aliasSlug, alias.canonicalSlug);
    }
  }
  return lookup;
}
