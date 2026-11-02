/**
 * Degrade-aware v3 read pipeline (PR4D Task D3, spec §4.6/§4.7/§4.8).
 *
 * The surface loaders return an {@link EmbeddingLoadOutcome} — never a bare
 * store-or-null — so a consumer ALWAYS sees WHY semantic retrieval contributed
 * nothing (a v2/older store is degraded-on-read with a structured
 * `embedding-index-outdated` warning; lexical retrieval still works).
 *
 * READ-ONLY invariant: this module NEVER writes, migrates, or prunes the store.
 * Stale (not-live / hash-mismatched) ids are reported in `stalePageIds`; the
 * actual pruning happens only on the next write (D7).
 *
 * The retrieval pipeline (§4.6 steps 3-5):
 *   3. cheap identity prefilter — drop store entries whose `pageId` is not a
 *      live page (`buildLiveIdSet`) and whose surface flag excludes it, BEFORE
 *      any scoring;
 *   4. score the survivors in memory (cosine);
 *   5. walk the ranked candidates filling results — per candidate (score order)
 *      resolve via the live registry + verify content freshness, keep a fresh
 *      hit, drop+warn a stale one, stop at K fresh hits or pool exhaustion. This
 *      prevents a stale high-score hit from crowding out a lower-score fresh one.
 *
 * S12 rehydration: output `title`/`summary`/`text` come from the LIVE file (via
 * the registry loaders), never the store's cached copies — the cached values
 * exist only for migration/reuse and are NOT a tamper boundary (S8).
 */

import { getEmbeddingProvider } from "./embedding-provider.js";
import { assertVectorValid, EmbeddingIntegrityError } from "./embeddings-validate.js";
import {
  validateV3ForSearch,
  storeMatchesActiveEmbedding,
  type EmbeddingStoreV3,
  type PageEmbeddingV3,
  type ChunkEmbeddingV3,
} from "./embeddings-store.js";
import { readStoredEmbeddings, type StoredEmbeddingRead } from "./embeddings-storage.js";
import { cosineSimilarity } from "./embeddings-search.js";
import {
  buildLiveIdSet,
  buildLiveRegistryEntry,
  loadPageRecordsByPageId,
  buildNamespaceDirs,
  type LiveRegistryEntry,
} from "./page-registry.js";
import { splitIntoChunks } from "./retrieval.js";
import { parseQualifiedPageId, qualifiedPageId, type PageId } from "./page-id.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";
import type { RegistryPageSource } from "./page-registry.js";

/** Namespace→directory map resolved from the active profile (or reserved-only). */
type NamespaceDirs = Map<string, string>;

/**
 * The three things every freshness walk needs to resolve a page.
 *
 * Bundled because threading `root`, `namespaceDirs` and `source` separately put
 * five positional arguments on every rehydrator, and an argument added later
 * would sit in the same shape as one already there -- the kind of mistake the
 * compiler cannot catch.
 */
interface PageReader {
  root: string;
  namespaceDirs: NamespaceDirs;
  source?: RegistryPageSource;
}



/** Which surface flag a load filters by (each surface filters independently). */
export type RetrievalSurface = "search" | "context";

/** Structured warning surfaced in the outcome the consumer actually reads (S6). */
export interface EmbeddingWarning {
  code:
    | "embedding-index-outdated"
    | "embedding-store-unavailable"
    | "embedding-entry-stale"
    // A v3 store loaded, but the embedding CALL failed at read time (e.g. no
    // embedder credentials), so retrieval degraded to LLM/index selection.
    | "embedding-degraded";
  message: string;
}

/**
 * Outcome of a surface load. `store` is non-null only for a fully-handled v3
 * store; a v2/older/failed-gate/corrupt store degrades to `null` + a warning.
 */
export interface EmbeddingLoadOutcome {
  store: EmbeddingStoreV3 | null;
  warnings: EmbeddingWarning[];
  stalePageIds: PageId[];
}

/**
 * Where a load reads its store from.
 *
 * ## Why this seam exists
 *
 * The store used to have exactly one home -- a file under `.llmwiki` -- so the
 * loaders took a `root` and read it. It now has two possible homes, and which one
 * is authoritative is the CALLER's business: a serving process holds a database
 * handle, while a one-shot compile reads whatever is on disk. Threading that choice
 * as a parameter keeps the decision visible at each call site instead of burying a
 * default that silently reads the wrong place.
 *
 * ## Why the file is still the default
 *
 * Retiring the file outright would make every read depend on a live database before
 * the write path is converted, and a query would start failing for a reason that has
 * nothing to do with the query. The default is therefore the existing behaviour, and
 * a caller opts into the database explicitly. When the write path moves over, this
 * default moves with it, and the seam disappears.
 */
/**
 * The eligibility and scope constraints a ranking call must honour.
 *
 * Every field is a predicate the adapter can express in its own storage language,
 * which is the whole point: materializing the equivalent `Set` of allowed ids in
 * Node costs a full page read before the ranking can start. Measured on a 387-page
 * Stack, building that set took 27-31ms -- more than the ranking it would have
 * constrained -- because the listing carries every page `body`.
 *
 * ## The four filters that must travel
 *
 * 1. `pageScope` -- the caller's own narrowing (`narrowToScope`).
 * 2. `excludedNamespaces` -- a typed namespace whose surface flag is `false`.
 * 3. Liveness plus title, which the adapter applies unconditionally: the live
 *    predicate is `orphaned !== true && hasTitle`, and it does NOT test `archived`.
 *    Archiving is a freshness warning (`context/ranking.ts`), not an eligibility
 *    gate, so excluding archived rows would make this path disagree with the
 *    in-memory one on an axis only the row store knows about.
 *
 * A filter an adapter cannot express is NOT a filter it may drop: returning fewer
 * rows is acceptable, returning rows the caller could not use is not.
 */
export interface RankScope {
  /** Caller-narrowed page ids; `undefined` means unrestricted, not "no filter". */
  readonly pageScope?: readonly string[];
  /** Namespaces excluded by the profile's retrieval flag; empty means none. */
  readonly excludedNamespaces: readonly string[];
  /** Which surface's flag `excludedNamespaces` was derived from. */
  readonly surface: RetrievalSurface;
}

/**
 * One ranked chunk from a source that can rank without materializing vectors.
 *
 * `cosine` is a distinct field from the pipeline's `score` on purpose: callers
 * compare it against the in-memory cosine, so a source that returned `1 - dist`
 * from an approximate index instead would fail visibly rather than silently shift
 * the similarity floor.
 */
export interface RankedChunk {
  readonly pageDirectory: string;
  readonly slug: string;
  readonly chunkIndex: number;
  readonly cosine: number;
  /**
   * The hash stored alongside the vector, so the freshness walk can compare it
   * against the live body without a second read.
   *
   * A ranked chunk is a CANDIDATE, not a hit: the text may have changed since the
   * vector was written, and the walk is what decides. Carrying the hash here is
   * what lets `walkFreshChunks` keep doing that job unchanged.
   */
  readonly contentHash: string;
}

/**
 * The four header values a lightweight load needs, and nothing else.
 *
 * Deliberately NOT a store: it has no `entries`, no `chunks`, and no way to be
 * mistaken for one. A load that returns this cannot hand a caller a partial store
 * by accident, which is the failure a `{ entries: [], chunks: [] }` shape invites.
 *
 * `dimensions` is the field that makes this mandatory rather than optional: the
 * query embedding has to be validated against it, and skipping that check would
 * let a provider returning 1536 dims rank silently against a 768-dim store.
 */
export interface EmbeddingStoreMeta {
  readonly model: string;
  readonly dimensions: number;
  /** Omitted when the store predates calibration; omitted means no floor. */
  readonly minSimilarity?: number;
  /** Omitted when the store predates fingerprints. */
  readonly fingerprint?: string;
}

/**
 * The outcome of a ranking attempt that can decline to rank.
 *
 * Discriminated rather than a bare array so "I ranked and found nothing" cannot be
 * confused with "I could not rank at all". The second must never look like the
 * first: an empty result reads as "no relevant pages", which is a different claim
 * from "your index is unusable", and the user can only act on the difference if it
 * survives as a type.
 *
 * `code` reuses the warning vocabulary `gateActiveStore` already emits, so the
 * caller maps rather than translates.
 */
export type ChunkRanking =
  | { readonly kind: "ranked"; readonly hits: RankedChunk[] }
  | {
      readonly kind: "degraded";
      readonly code: "embedding-index-outdated" | "embedding-store-unavailable";
      readonly reason: string;
    };

/**
 * Where a load reads its store from, and what else that backend can answer.
 *
 * ## Why this is a UNION and not two optional methods
 *
 * A backend either materializes its store or ranks without it. `readMeta` and
 * `rankChunks` are meaningless apart: without the header there is no dimension to
 * validate the query embedding against, and without ranking the header alone cannot
 * answer anything the store does not. Spelling that as a union makes the impossible
 * combination unrepresentable instead of merely discouraged, so no caller has to
 * handle a shape that cannot work.
 *
 * The first branch is the file-backed path: `read` is its only capability, and the
 * caller must materialize. The second is the row-backed path: it MAY still be asked
 * for the whole store (the page pipeline does, when chunk ranking returns nothing),
 * but it can also answer from the header plus one ranked query.
 */
export type EmbeddingStoreSource =
  | {
      /**
       * Read the raw parsed store.
       *
       * Returns the same discriminated result the file reader returns: the gate
       * above needs to tell "absent" from "unavailable" from "parsed", because
       * each degrades with a different warning.
       */
      read(): Promise<StoredEmbeddingRead>;
    }
  | {
      read(): Promise<StoredEmbeddingRead>;
      /**
       * Read the header only. `null` means this Stack has no store at all.
       *
       * Side-effect free by design: validation belongs to `rankChunks`, which is
       * where the answer is used. A caller that only needs `dimensions` should not
       * pay for an integrity scan it will discard.
       */
      readMeta(): Promise<EmbeddingStoreMeta | null>;
      /**
       * Validate, then rank chunks by exact cosine, without materializing vectors.
       *
       * @param queryVec - The embedded query, already dimension-checked.
       * @param k - Maximum hits to return.
       * @param scope - Eligibility and scope constraints; applies to every hit.
       * @returns `ranked` with the hits (possibly none) or `degraded` with a code.
       */
      rankChunks(queryVec: number[], k: number, scope: RankScope): Promise<ChunkRanking>;
    };/**
 * The capability check, in one place.
 *
 * Callers must not test for `readMeta` and `rankChunks` separately: the union makes
 * them arrive together, and asking once keeps that guarantee visible at the call
 * site instead of restated with a risk of drift.
 *
 * @param source - Any embedding store source.
 * @returns True when the source can rank without materializing its store.
 */
// Consumed by the call-site wiring that follows this contract; the check lives
// here so no caller restates it.
// fallow-ignore-next-line unused-export
export function canRankWithoutStore(
  source: EmbeddingStoreSource | undefined,
): source is Extract<EmbeddingStoreSource, { readMeta: unknown }> {
  return source !== undefined && "readMeta" in source && "rankChunks" in source;
}

/**
 * How many candidates the source ranks per requested hit.
 *
 * The walk discards stale candidates, so ranking exactly `k` would leave fewer than
 * `k` fresh hits whenever any of them drifted. Overscanning keeps the walk's pool
 * deep enough to still fill `k` -- the same reason the in-memory path ranks every
 * entry rather than exactly `k`.
 */
const RANK_SCOPE_OVERSCAN = 3;

/**
 * Marks a store that carries only the header.
 *
 * A symbol rather than a boolean field so it cannot collide with the serialized
 * store shape, and so no persisted store can ever arrive already marked: a store
 * read from disk or from rows has no way to set it. Inferring lightness from
 * `entries.length === 0` would be wrong -- an empty-but-real store is a legitimate
 * state (a rebuild with nothing to embed), and treating it as light would materialize
 * a second time for no reason.
 */
const META_ONLY_STORE = Symbol("llmwiki.metaOnlyStore");

/** The shape a header-only store carries, plus the marker. */
type MetaOnlyStore = EmbeddingStoreV3 & { readonly [META_ONLY_STORE]?: true };

/**
 * Whether this store came from the header-only load.
 *
 * @param store - Any v3 store.
 * @returns True when the store carries no entries by design, not by emptiness.
 */
export function isMetaOnlyStore(store: EmbeddingStoreV3): boolean {
  return (store as MetaOnlyStore)[META_ONLY_STORE] === true;
}

/** A live-rehydrated page hit carrying its qualified id (spec §4.7). */
export interface PageHitV3 {
  pageId: PageId;
  slug: string;
  title: string;
  summary: string;
  score: number;
}

/** A live-rehydrated chunk hit carrying its qualified id and chunk index. */
export interface ChunkHitV3 {
  pageId: PageId;
  slug: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  score: number;
}

/**
 * Load the active store for the SEARCH surface. The returned store is filtered
 * by `includeInSearch` later, in {@link findRelevantPagesV3}/{@link findRelevantChunksV3}
 * — the load itself only version/integrity/model-gates (degrade-on-read).
 */
export async function loadEmbeddingsForSearch(
  root: string,
  source?: EmbeddingStoreSource,
): Promise<EmbeddingLoadOutcome> {
  return gateActiveStore(root, source);
}

/**
 * Load ONLY the header, for a backend that ranks without materializing vectors.
 *
 * Deliberately a SEPARATE entry point rather than a branch inside
 * `loadEmbeddingsForSearch`. That function is public and its callers expect a store
 * they can score; returning one with empty `entries` would silently delete the
 * page-embedding level from every cascade that reads it. A caller that wants the
 * light path has to name it, and takes on the obligation to materialize before
 * touching `store.entries` or `store.chunks`.
 *
 * @param source - Backend that exposes a header.
 * @returns A store carrying the header only, or a degraded outcome.
 */
export async function loadMetaForSearch(root: string, source: EmbeddingStoreSource): Promise<EmbeddingLoadOutcome> {
  if (!canRankWithoutStore(source)) return gateActiveStore(root, source);
  return loadMetaOnly(source);
}

/**
 * Build the lightweight store from the source's header.
 *
 * `null` from `readMeta` is the row store's "this Stack has never been embedded",
 * which is the same condition `gateActiveStore` reports as ABSENT. A failed read
 * rethrows instead: an unavailable database must not look like an empty Stack, or
 * the caller rebuilds a corpus that was never lost.
 *
 * @param source - Backend that exposes a header.
 * @returns A store carrying the header only, or a degraded outcome.
 */
async function loadMetaOnly(
  source: Extract<EmbeddingStoreSource, { readMeta: unknown }>,
): Promise<EmbeddingLoadOutcome> {
  const meta = await source.readMeta();
  if (meta === null) return degraded("embedding-index-outdated", "No embedding index found.");
  const store: MetaOnlyStore = {
    [META_ONLY_STORE]: true,
    version: 3,
    model: meta.model,
    dimensions: meta.dimensions,
    entries: [],
    chunks: [],
    ...(meta.fingerprint === undefined ? {} : { fingerprint: meta.fingerprint }),
    ...(meta.minSimilarity === undefined ? {} : { minSimilarity: meta.minSimilarity }),
  };
  return { store, warnings: [], stalePageIds: [] };
}

/**
 * Load the active store for the CONTEXT surface. Filtering by `includeInContext`
 * happens in the pipeline functions; the load is surface-agnostic gating only.
 */
export async function loadEmbeddingsForContext(
  root: string,
  source?: EmbeddingStoreSource,
): Promise<EmbeddingLoadOutcome> {
  return gateActiveStore(root, source);
}

/**
 * Parse + gate the on-disk store READ-ONLY. Returns a usable v3 store, or a
 * degraded outcome (`store: null`) with a structured warning when the store is
 * not v3 (older version — the writer has not flipped yet), failed the search
 * gate (corrupt vectors / over-cap), was built by a different embedding
 * configuration (provider, endpoint, or model), or is absent.
 */
async function gateActiveStore(
  root: string,
  source?: EmbeddingStoreSource,
): Promise<EmbeddingLoadOutcome> {
  const result = source === undefined ? await readStoredEmbeddings(root) : await source.read();
  if (result.kind === "absent") return degraded("embedding-index-outdated", "No embedding index found.");
  if (result.kind === "unavailable") return degraded("embedding-store-unavailable", result.reason);
  const parsed = result.parsed;
  if (parsed.version !== 3) {
    return degraded("embedding-index-outdated", "Embedding index is an older version; rebuild with 'llmwiki compile'.");
  }
  const validation = validateV3ForSearch(parsed);
  if (!validation.available) {
    return degraded("embedding-store-unavailable", "Embedding index failed integrity validation; rebuilt on next compile.");
  }
  if (isStaleConfiguration(parsed.store)) {
    return degraded(
      "embedding-index-outdated",
      "Embedding index was built with a different embedding configuration; rebuild with 'llmwiki compile'.",
    );
  }
  return { store: parsed.store as unknown as EmbeddingStoreV3, warnings: [], stalePageIds: [] };
}

/**
 * True when the persisted store came from a different embedding configuration
 * (provider, model, or endpoint) than the active one.
 *
 * Still fails CLOSED on a throw: `resolveEmbeddingFingerprint` validates the
 * configured provider name, so a misspelled LLMWIKI_EMBEDDING_PROVIDER degrades
 * retrieval rather than propagating out of a read path that several callers do
 * not guard.
 */
function isStaleConfiguration(store: Record<string, unknown>): boolean {
  try {
    return !storeMatchesActiveEmbedding(store);
  } catch {
    return true;
  }
}

/** Build a degraded (store-null) outcome with one structured warning. */
function degraded(code: EmbeddingWarning["code"], message: string): EmbeddingLoadOutcome {
  return { store: null, warnings: [{ code, message }], stalePageIds: [] };
}

/**
 * Run the §4.6 page pipeline against an already-loaded v3 store: cheap identity
 * prefilter → score → walk-ranked freshness fill → live rehydration.
 *
 * Returns the K freshest top-scoring page hits with live-rehydrated text plus
 * the ids dropped for staleness this read (reported, never written).
 */
/**
 * Build the reader and the candidate set shared by BOTH retrieval pipelines.
 *
 * The page and chunk pipelines differ only in what they filter and how they verify
 * freshness; everything up to that point was duplicated line for line, and fallow
 * flagged the copies. Sharing it also keeps one answer to "which pages are live",
 * which is the step a divergence would silently corrupt.
 *
 * @param root - Project root the reader resolves against.
 * @param entries - Store entries (pages or chunks) to prefilter.
 * @param surface - Retrieval surface deciding eligibility.
 * @param profile - Loaded profile, when one is in play.
 * @param source - Registry page source, when rows back the corpus.
 * @returns The reader plus the entries that passed the prefilter.
 */
async function buildRankingScope<T extends { readonly pageId: PageId }>(
  root: string,
  entries: readonly T[],
  surface: RetrievalSurface,
  profile: LoadedProfile | undefined,
  source: RegistryPageSource | undefined,
): Promise<{ readonly reader: PageReader; readonly eligible: T[] }> {
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const reader: PageReader = { root, namespaceDirs, source };
  const liveIds = await buildLiveIdSet(
    root, await activeNamespaces(root, profile), namespaceDirs, profile, source,
  );
  const eligible = entries.filter((e) => passesPrefilter(e.pageId, liveIds, surface, profile));
  // Copied into a mutable array because the scoring helpers take `T[]`.
  return { reader, eligible: [...eligible] };
}

export async function findRelevantPagesV3(
  root: string,
  store: EmbeddingStoreV3,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
  source?: RegistryPageSource,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  const { reader, eligible } = await buildRankingScope(
    root, store.entries, surface, profile, source,
  );
  // Nothing to rank against — return before embedding. Skips a billed provider
  // round-trip whose result could only be scored against an empty pool.
  if (eligible.length === 0) return { hits: [], stalePageIds: [] };
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scorePageEntries(queryVec, eligible);
  if (!levelHasSignal(ranked, store.minSimilarity)) return { hits: [], stalePageIds: [] };
  return walkFreshPages(reader, ranked, k);
}

/**
 * Run the §4.6 chunk pipeline against an already-loaded v3 store. Same
 * prefilter→score→walk-ranked-freshness shape as the page pipeline, but a chunk
 * hit's freshness is verified against the live page's chunk-hash at its index.
 */

/**
 * Whether a ranked level found anything this STORE considers signal.
 *
 * The floor comes from the store, not from a global constant, because cosine scale
 * is a property of the embedding space that produced the vectors. A store with no
 * floor (uncalibrated, or written before the column existed) keeps the original
 * behaviour and filters nothing: returning zero pages is a worse failure than
 * returning a weak answer, so an uncalibrated store must degrade to the latter.
 *
 * Applied to the best candidate of a level rather than to every entry: an empty
 * level lets the cascade fall through to the next one instead of answering from
 * noise, while ranking INSIDE a level keeps its top-K semantics untouched.
 *
 * @param ranked - Candidates sorted by descending score.
 * @param minSimilarity - The store's floor, or undefined when it has none.
 * @returns Whether the level has signal.
 */
function levelHasSignal(
  ranked: ReadonlyArray<{ score: number }>,
  minSimilarity: number | undefined,
): boolean {
  if (minSimilarity === undefined) return true;
  const best = ranked[0];
  return best !== undefined && best.score >= minSimilarity;
}

export async function findRelevantChunksV3(
  root: string,
  store: EmbeddingStoreV3,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
  source?: RegistryPageSource,
  embeddingSource?: EmbeddingStoreSource,
  pageScope?: readonly PageId[],
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  // When the backend can rank without materializing vectors, it does. The store is
  // then only a source of `dimensions` and `minSimilarity`, which the lightweight
  // load took from the header -- `store.chunks` is empty and MUST NOT be read, or
  // the prefilter would be computed over nothing and every query would look empty.
  // Routed only for a LIGHTWEIGHT store: one that carries the header and no
  // chunks. A full store still ranks in memory, so this path cannot change an
  // answer anywhere it was not explicitly asked for.
  if (canRankWithoutStore(embeddingSource) && isMetaOnlyStore(store)) {
    return rankChunksViaSource(root, embeddingSource, store, { surface, question, k, profile, source, pageScope });
  }
  const { reader, eligible } = await buildRankingScope(
    root, store.chunks ?? [], surface, profile, source,
  );
  // See findRelevantPagesV3 — no candidates means no reason to embed the query.
  if (eligible.length === 0) return { hits: [], stalePageIds: [] };
  const queryVec = await embedQuery(question, store.dimensions);
  const ranked = scoreChunkEntries(queryVec, eligible);
  if (!levelHasSignal(ranked, store.minSimilarity)) return { hits: [], stalePageIds: [] };
  return walkFreshChunks(reader, ranked, k);
}

/** Everything the source-backed chunk path needs, grouped to keep the call readable. */
interface SourceRankingInput {
  readonly surface: RetrievalSurface;
  readonly question: string;
  readonly k: number;
  readonly profile?: LoadedProfile;
  readonly source?: RegistryPageSource;
  readonly pageScope?: readonly PageId[];
}

/**
 * Rank chunks through the source, then run the SAME freshness walk as the store path.
 *
 * The walk is not optional and must not be folded into the query. Measured on the
 * `wiki` Stack, 23 of 28 pages carry a stored hash that no longer matches their live
 * body; a ranked hit whose text changed is a hit whose vector describes text that no
 * longer exists. Only the walk compares the two hashes, and only it can put those
 * ids into `stalePageIds` -- which is what the user's `embedding-entry-stale`
 * warning is built from. Skipping it because "the join already filtered" would drop
 * a warning for 82% of that corpus.
 *
 * @param root - Wiki root the reader resolves against.
 * @param embeddingSource - Backend that can rank without a materialized store.
 * @param store - Lightweight store carrying `dimensions` and `minSimilarity` only.
 * @param input - Query, surface, scope, and the registry source for live hashes.
 * @returns Fresh hits plus the ids dropped as stale.
 */
async function rankChunksViaSource(
  root: string,
  embeddingSource: Extract<EmbeddingStoreSource, { readMeta: unknown }>,
  store: EmbeddingStoreV3,
  input: SourceRankingInput,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  const queryVec = await embedQuery(input.question, store.dimensions);
  const namespaceDirs = buildNamespaceDirs(input.profile?.profile);
  const outcome = await embeddingSource.rankChunks(queryVec, input.k * RANK_SCOPE_OVERSCAN, {
    ...(input.pageScope === undefined ? {} : { pageScope: input.pageScope }),
    excludedNamespaces: excludedNamespacesFor(input.surface, input.profile),
    surface: input.surface,
  });
  // A degraded ranking is NOT an empty result: returning [] would tell the caller
  // there is nothing relevant, which is a different claim from "I could not rank".
  if (outcome.kind === "degraded") throw new EmbeddingIntegrityError(`${outcome.code}: ${outcome.reason}`);
  if (outcome.hits.length === 0) return { hits: [], stalePageIds: [] };
  const ranked = outcome.hits.map((hit) => ({
    entry: {
      pageId: qualifiedPageId(hit.pageDirectory, hit.slug),
      title: "",
      chunkIndex: hit.chunkIndex,
      contentHash: hit.contentHash,
      text: "",
      vector: [],
      updatedAt: "",
    } as ChunkEmbeddingV3,
    score: hit.cosine,
  }));
  // The floor compares the EXACT cosine the source returned, never a re-derived one.
  if (!levelHasSignal(ranked, store.minSimilarity)) return { hits: [], stalePageIds: [] };
  const reader: PageReader = { root, namespaceDirs, source: input.source };
  return walkFreshChunks(reader, ranked, input.k);
}

/**
 * No namespace is excluded from any surface.
 *
 * `includeInSearch` / `includeInContext` were declared entity-type settings, and
 * every type WITHOUT them already defaulted to included. With the two namespaces
 * fixed and nothing declarable, the excluded list is always empty — the same
 * answer the old code gave for a profile declaring neither flag.
 *
 * @param _surface - Which surface is asking (unused).
 * @param _profile - The caller's profile (unused).
 * @returns Always an empty list.
 */
function excludedNamespacesFor(
  _surface: RetrievalSurface,
  _profile: LoadedProfile | undefined,
): string[] {
  return [];
}

/**
 * Embed the query string and assert the returned vector matches the store dim.
 *
 * A non-positive `dimensions` means the store declares none — an empty store
 * written by a rebuild that had nothing to embed carries 0. Passing that through
 * would assert `vector.length === 0` and throw on every query, permanently:
 * nothing rewrites the store, so it never recovers. Treat it as UNKNOWN instead
 * and let the vector's own integrity check stand alone.
 */
async function embedQuery(question: string, dimensions: number): Promise<number[]> {
  const vec = await getEmbeddingProvider().embed(question, "query");
  assertVectorValid(vec, dimensions > 0 ? dimensions : undefined);
  return vec;
}

/** The namespaces a load scans: reserved dirs plus any profile entity types. */
async function activeNamespaces(_root: string, profile?: LoadedProfile): Promise<string[]> {
  const base = ["concepts", "queries"];
  if (!profile) return base;
  return [...base, ...Object.keys(profile.profile.entities)];
}

/**
 * Cheap identity prefilter (§4.6 step 3): a store entry survives iff its pageId
 * names a LIVE page AND its namespace passes the surface flag. Concepts/queries
 * always pass the flag; a typed namespace consults its `RetrievalDef`.
 */
function passesPrefilter(
  pageId: PageId,
  liveIds: Set<PageId>,
  surface: RetrievalSurface,
  profile?: LoadedProfile,
): boolean {
  if (!liveIds.has(pageId)) return false;
  return passesSurfaceFlag(pageId, surface, profile);
}

/**
 * Every page passes every surface flag.
 *
 * @param _pageId - The page being checked (unused).
 * @param _surface - Which surface is asking (unused).
 * @param _profile - The caller's profile (unused).
 * @returns Always `true`.
 */
function passesSurfaceFlag(_pageId: PageId, _surface: RetrievalSurface, _profile?: LoadedProfile): boolean {
  return true;
}

/** Score page entries by cosine similarity, descending; ties keep input order. */
function scorePageEntries(
  queryVec: number[],
  entries: PageEmbeddingV3[],
): Array<{ entry: PageEmbeddingV3; score: number }> {
  const scored = entries.map((entry) => ({ entry, score: cosineSimilarity(queryVec, entry.vector) }));
  return stableSortByScore(scored, (item) => item.entry.pageId);
}

/** Score chunk entries by cosine similarity, descending; ties keep input order. */
function scoreChunkEntries(
  queryVec: number[],
  entries: ChunkEmbeddingV3[],
): Array<{ entry: ChunkEmbeddingV3; score: number }> {
  const scored = entries.map((entry) => ({ entry, score: cosineSimilarity(queryVec, entry.vector) }));
  return stableSortByScore(scored, (item) => `${item.entry.pageId}#${item.entry.chunkIndex}`);
}

/**
 * Sort by score descending, breaking ties on a STABLE non-key field (S7) so the
 * order is invariant under a slug→pageId re-key. The tie field is the qualified
 * id (or id+index), which is deterministic across the re-key.
 */
function stableSortByScore<T>(scored: Array<T & { score: number }>, tieKey: (item: T) => string): Array<T & { score: number }> {
  return scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return tieKey(a).localeCompare(tieKey(b));
  });
}

/**
 * One ranked candidate's freshness decision against the live registry entry:
 * `null` when stale/absent (drop + warn), otherwise the rehydrated hit.
 */
type FreshnessFill<E, H> = (
  entry: E,
  score: number,
  live: LiveRegistryEntry,
) => Promise<H | null>;

/**
 * Generic walk of the ranked pool (§4.6 step 5): per candidate (score order)
 * resolve its live registry entry, ask `fill` for a fresh rehydrated hit, keep
 * it or record the id as stale, and stop at K fresh hits or pool exhaustion.
 * This — NOT top-K-then-validate — is what prevents a stale high-score hit from
 * crowding out a lower-score fresh one.
 */
async function walkRankedFresh<E extends { pageId: PageId }, H>(
  reader: PageReader,
  ranked: Array<{ entry: E; score: number }>,
  k: number,
  fill: FreshnessFill<E, H>,
): Promise<{ hits: H[]; stalePageIds: PageId[] }> {
  const hits: H[] = [];
  const stalePageIds: PageId[] = [];
  for (const { entry, score } of ranked) {
    if (hits.length >= k) break;
    const live = await buildLiveRegistryEntry(reader.root, entry.pageId, reader.namespaceDirs, reader.source);
    const hit = live ? await fill(entry, score, live) : null;
    if (hit === null) stalePageIds.push(entry.pageId);
    else hits.push(hit);
  }
  return { hits, stalePageIds };
}

/** Walk page candidates, keeping a hit only when its `embeddingTextHash` is live. */
function walkFreshPages(
  reader: PageReader,
  ranked: Array<{ entry: PageEmbeddingV3; score: number }>,
  k: number,
): Promise<{ hits: PageHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(reader, ranked, k, async (entry, score, live) =>
    live.embeddingTextHash === entry.embeddingTextHash ? rehydratePageHit(reader, entry, score) : null,
  );
}

/** Walk chunk candidates, keeping a hit only when its `contentHash` is live. */
function walkFreshChunks(
  reader: PageReader,
  ranked: Array<{ entry: ChunkEmbeddingV3; score: number }>,
  k: number,
): Promise<{ hits: ChunkHitV3[]; stalePageIds: PageId[] }> {
  return walkRankedFresh(reader, ranked, k, async (entry, score, live) =>
    live.chunkHashes[entry.chunkIndex] === entry.contentHash
      ? rehydrateChunkHit(reader, entry, score, live.chunkHashes[entry.chunkIndex])
      : null,
  );
}

/** Rehydrate a page hit's title/summary from the LIVE file, never the store (S12). */
async function rehydratePageHit(
  reader: PageReader,
  entry: PageEmbeddingV3,
  score: number,
): Promise<PageHitV3> {
  const slug = parseQualifiedPageId(entry.pageId)?.pagePart ?? "";
  const live = await loadLivePage(reader, entry.pageId);
  return {
    pageId: entry.pageId,
    slug,
    title: live?.title ?? "",
    summary: live?.summary ?? "",
    score,
  };
}

/**
 * Rehydrate a chunk hit's text from the LIVE page body (S12). The live body is
 * re-split with the SAME `splitIntoChunks` the store used, and the chunk at the
 * hit's index is taken — the store's cached `entry.text` is never returned, so a
 * poisoned cached value cannot reach output even if its hash matched live.
 */
async function rehydrateChunkHit(
  reader: PageReader,
  entry: ChunkEmbeddingV3,
  score: number,
  liveContentHash: string,
): Promise<ChunkHitV3> {
  const live = await loadLivePage(reader, entry.pageId);
  const liveText = live ? splitIntoChunks(live.body)[entry.chunkIndex] ?? "" : "";
  return {
    pageId: entry.pageId,
    slug: parseQualifiedPageId(entry.pageId)?.pagePart ?? "",
    chunkIndex: entry.chunkIndex,
    contentHash: liveContentHash,
    text: liveText,
    score,
  };
}

/** Resolve one live page record via the confined registry loader (absent → null). */
async function loadLivePage(reader: PageReader, pageId: PageId): Promise<PageRecord | null> {
  const records = await loadPageRecordsByPageId(reader.root, [pageId], reader.namespaceDirs, reader.source);
  return records[0] ?? null;
}
