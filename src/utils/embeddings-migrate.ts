/**
 * Pure v3 embedding-store reconciliation core.
 *
 * `migrateEmbeddingStore` is a side-effect-free transform: it takes the
 * version-discriminated old store, the set of VALID + ELIGIBLE live pages (the
 * caller supplies these — this module never touches the filesystem or a
 * provider), and the active model name, and returns a v3 store plus the list of
 * eligible pageIds that must be re-embedded by the caller.
 *
 * ## What changed, and why the v2 migration is gone
 *
 * This module used to re-key v2 records from a bare `slug` to a qualified
 * `pageId`, preserving vectors whose content still hashed to the same value.
 * That path is retired: a legacy v1/v2 store is now REBUILT from live pages
 * instead of migrated.
 *
 * The reason is that the re-key could fail silently. Preserving a v2 vector meant
 * guessing which live page an old slug belonged to, safe only when the slug mapped
 * to exactly one eligible page AND the recomputed hash still matched. Every other
 * outcome attached a vector built from different text to a page, and similarity
 * search then returned that page for content it never embedded — a wrong answer,
 * not an error.
 *
 * Rebuilding costs the provider work on the one upgrade where a legacy store is
 * encountered, and cannot attach a vector to the wrong page. The writer has
 * persisted v3 since 1.0.0, so this only touches stores older than that.
 *
 * ## The two guarantees that remain
 *
 *  - CONTENT VERIFICATION: a preserved v3 record is only kept when the live page's
 *    `embeddingTextHash` still matches (page) or the chunk contentHash still
 *    matches at the same index (chunk). Anything else re-embeds.
 *  - S2 PRIVACY (eligibility-gated): `reembedPageIds` only ever contains pages
 *    present in `eligibleLivePages`. A deleted page (no live page) or an
 *    opted-out / ineligible page (absent from `eligibleLivePages`) is dropped
 *    from the output store and is NEVER re-embedded — its old vector is not
 *    carried forward and the provider is never asked to embed it. "Couldn't
 *    preserve" must not default to "re-embed"; only eligibility does.
 */

import { assertEmbeddingStoreValid } from "./embeddings-validate.js";
import type {
  ParsedStore,
  EmbeddingStoreV3,
  PageEmbeddingV3,
  ChunkEmbeddingV3,
} from "./embeddings-store.js";
import type { PageId } from "./page-id.js";

/**
 * A valid + eligible live page, supplied by the caller with enough material to
 * build the bare-slug→pageId map and verify that a preserved vector still
 * matches the page's current content.
 */
export interface EligibleLivePage {
  /** Qualified `<namespace>/<page-part>` identity to re-key preserved vectors to. */
  pageId: PageId;
  /** The bare slug an old v2 entry would have been keyed under. */
  bareSlug: string;
  /** `hashChunkText(buildEmbeddingText(title, summary))` for the live page. */
  embeddingTextHash: string;
  /** `hashChunkText` of each live chunk body, in chunk order. */
  chunkContentHashes: string[];
}

/** Result of a migration: the v3 store plus the eligible pages to re-embed. */
export interface MigrationResult {
  store: EmbeddingStoreV3;
  reembedPageIds: PageId[];
}

/**
 * Migrate a parsed old store to v3, preserving content-verified vectors and
 * reporting the eligible pages that must be re-embedded. Pure — see file docs.
 */
export function migrateEmbeddingStore(
  parsedOld: ParsedStore | null,
  eligibleLivePages: EligibleLivePage[],
  activeModel: string,
): MigrationResult {
  const dims = storeDimensions(parsedOld);
  if (shouldRebuild(parsedOld, activeModel)) {
    return rebuild(eligibleLivePages, activeModel);
  }
  // `shouldRebuild` is the only guard that proves non-null, and TypeScript cannot
  // narrow through a function call, so the assertion is stated here rather than
  // inferred. A null store always rebuilds, which is why reaching this line means
  // `parsedOld` is a real v3 store.
  const liveByPageId = new Map(eligibleLivePages.map((p) => [p.pageId, p]));
  const reembed = new Set<PageId>();
  const entries = migrateEntries(parsedOld!.store, liveByPageId, reembed);
  const chunks = migrateChunks(parsedOld!.store, liveByPageId, reembed);
  addNewEligiblePages(eligibleLivePages, entries, reembed);
  return { store: { version: 3, model: activeModel, dimensions: dims, entries, chunks }, reembedPageIds: [...reembed] };
}

/**
 * Rebuild-only: empty v3 store + EVERY eligible pageId queued for re-embedding.
 *
 * `dimensions` is always 0 here, never the old store's dimension: a rebuild
 * discards every old vector, so the previous dimension describes nothing that
 * survives it. A stale nonzero value would carry forward into
 * embeddings.ts's `expectedDim` and reject every freshly embedded vector whose
 * new model has a different length; embeddings-write.ts recomputes the real
 * dimension from the first vector the re-embed pass actually produces.
 */
function rebuild(pages: EligibleLivePage[], model: string): MigrationResult {
  return {
    store: { version: 3, model, dimensions: 0, entries: [], chunks: [] },
    reembedPageIds: pages.map((p) => p.pageId),
  };
}

/** Read the declared dimension (default 0) from a parsed store of any version. */
function storeDimensions(parsedOld: ParsedStore | null): number {
  const dims = parsedOld?.store.dimensions;
  return typeof dims === "number" && Number.isFinite(dims) ? dims : 0;
}

/**
 * Gate to rebuild-only when no vector can be safely preserved: a missing store, a
 * legacy v1/v2 store, an unknown future version, a stored model that differs from
 * the active model, or any vector-integrity failure (non-finite / wrong-length
 * against `dimensions`).
 *
 * ## Why v1/v2 rebuilds instead of migrating
 *
 * Preserving a v1/v2 vector requires guessing which live page an old bare `slug`
 * belonged to, and that guess is only safe when the slug maps to exactly one
 * eligible page AND the recomputed embedding-input hash still matches. Every
 * failure mode of that guess is silent: a wrong pairing carries a vector built
 * from different text, and similarity search then returns a page for content it
 * never embedded.
 *
 * The migration is therefore gone rather than kept. A v1/v2 store is rebuilt from
 * live pages on the next write, which costs the provider work but cannot produce a
 * vector attached to the wrong page. The v3 path below is unaffected: it reconciles
 * by `pageId`, which needs no guessing.
 */
function shouldRebuild(parsedOld: ParsedStore | null, activeModel: string): boolean {
  if (!parsedOld || parsedOld.version !== 3) return true;
  if (parsedOld.store.model !== activeModel) return true;
  try {
    assertEmbeddingStoreValid(parsedOld.store);
    return false;
  } catch {
    return true;
  }
}


/**
 * Reconcile the v3 page entries.
 *
 * Only the v3 path remains: `shouldRebuild` sends legacy stores to the rebuild,
 * so a slug-to-pageId re-key can never be reached from here.
 */
function migrateEntries(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): PageEmbeddingV3[] {
  return reconcileV3Entries(store, liveByPageId, reembed);
}

/**
 * v3 idempotent reconciliation of page entries: keep a record only when its
 * pageId is an eligible live page whose `embeddingTextHash` still matches the
 * stored value. A dropped record that is still eligible (content drift) is queued
 * to re-embed; a record for a deleted/opted-out page is pruned silently.
 */
function reconcileV3Entries(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): PageEmbeddingV3[] {
  const out: PageEmbeddingV3[] = [];
  for (const entry of (store.entries as PageEmbeddingV3[] | undefined) ?? []) {
    const live = liveByPageId.get(entry.pageId);
    if (live && entry.embeddingTextHash === live.embeddingTextHash) out.push(entry);
    else if (live) reembed.add(entry.pageId);
  }
  return out;
}

/**
 * Reconcile the v3 chunk entries.
 *
 * Only the v3 path remains, for the same reason as the page entries.
 */
function migrateChunks(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): ChunkEmbeddingV3[] {
  return reconcileV3Chunks(store, liveByPageId, reembed);
}

/**
 * v3 idempotent reconciliation of chunk entries: keep a chunk only when its
 * pageId is an eligible live page whose chunk-hash at the same index still
 * matches. A drifted/absent chunk on a live page is pruned and its page queued
 * to re-embed; a chunk for a deleted/opted-out page is pruned silently.
 */
function reconcileV3Chunks(
  store: Record<string, unknown>,
  liveByPageId: Map<PageId, EligibleLivePage>,
  reembed: Set<PageId>,
): ChunkEmbeddingV3[] {
  const out: ChunkEmbeddingV3[] = [];
  for (const chunk of (store.chunks as ChunkEmbeddingV3[] | undefined) ?? []) {
    const live = liveByPageId.get(chunk.pageId);
    if (live && live.chunkContentHashes[chunk.chunkIndex] === chunk.contentHash) out.push(chunk);
    else if (live) reembed.add(chunk.pageId);
  }
  return out;
}


/** Queue any eligible live page that produced no preserved page entry to re-embed. */
function addNewEligiblePages(pages: EligibleLivePage[], entries: PageEmbeddingV3[], reembed: Set<PageId>): void {
  const preserved = new Set(entries.map((e) => e.pageId));
  for (const page of pages) {
    if (!preserved.has(page.pageId)) reembed.add(page.pageId);
  }
}


/** Narrow an unknown field to an array (empty when absent / not an array). */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
