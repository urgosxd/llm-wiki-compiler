/**
 * v3 re-embed pass for the embedding writer (spec §4.5).
 *
 * After {@link migrateEmbeddingStore} content-verifies and re-keys the
 * preservable vectors, this module embeds the pages the migration could not
 * preserve (`reembedPageIds`) plus any explicitly changed pages — keyed by
 * qualified `pageId`. It produces fresh v3 page + chunk records and merges them
 * into the migrated store, replacing any same-`pageId` records.
 *
 * Page and chunk texts are embedded through the SAME batched {@link embedTextBatch}
 * primitive the legacy writer used, so batch sizing, retry/fallback, and
 * integrity validation are unchanged — only the record key (pageId, not slug)
 * and the page `embeddingTextHash` differ.
 */

import { getEmbeddingProvider } from "./embedding-provider.js";
import { embedWorkItems, makeCountingProvider } from "./embeddings-batch.js";
import type {
  EmbeddingStoreV3,
  PageEmbeddingV3,
  ChunkEmbeddingV3,
} from "./embeddings-store.js";
import type { CollectedPage } from "./embeddings-collect.js";
import type { PageId } from "./page-id.js";

/** A flat chunk work item carrying its parent page identity + position. */
interface ChunkWork {
  pageId: PageId;
  title: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
}

/** Telemetry for the embeddings report line. */
export interface ReembedReport {
  pagesEmbedded: number;
  chunksEmbedded: number;
  requests: number;
}

/**
 * Reports how much of the PAGE pass has settled, counted in page records.
 *
 * The unit is pages because that is what a caller can compare against its own
 * page count; chunk counts are one page's worth of unrelated work and would make
 * the same "40" mean two different things across passes.
 */
export type EmbeddingProgressCallback = (completed: number, total: number) => void;

/**
 * Reports the settled cardinalities once the embedding pass finishes.
 *
 * Separate from {@link EmbeddingProgressCallback} because these are totals, not a
 * running position: chunks are only known after the chunk pass, and a consumer
 * must be able to tell a final cardinality from a ratio it can divide.
 */
export type EmbeddingDetailCallback = (detail: { chunks: number; requests: number }) => void;

/**
 * Re-embed `reembedIds` against `collected`, returning a v3 store whose page and
 * chunk records for those ids are freshly embedded and merged over `migrated`.
 * Ids absent from `collected` (deleted / ineligible) are skipped — never embedded.
 *
 * @param migrated - The v3 store returned by the migration (preserved vectors).
 * @param collected - Every eligible live page, by pageId.
 * @param reembedIds - The pageIds to (re-)embed this write.
 * @param batchSize - Provider batch size.
 * @param expectedDim - Expected vector dimension (omit on a dimensionless store).
 * @param onProgress - Optional page-record progress sink, driven by the page pass ONLY.
 */
export async function reembedIntoStore(
  migrated: EmbeddingStoreV3,
  collected: CollectedPage[],
  reembedIds: Set<PageId>,
  batchSize: number,
  expectedDim: number | undefined,
  onProgress?: EmbeddingProgressCallback,
  onDetail?: EmbeddingDetailCallback,
): Promise<{ store: EmbeddingStoreV3; report: ReembedReport }> {
  const byId = new Map(collected.map((p) => [p.pageId, p]));
  const targets = [...reembedIds].map((id) => byId.get(id)).filter((p): p is CollectedPage => Boolean(p));
  const { provider, requestCount } = makeCountingProvider(getEmbeddingProvider());
  const now = new Date().toISOString();

  // The page pass owns the progress sink; the chunk pass deliberately does not,
  // because its counts are a different unit and would overwrite the page counts a
  // consumer is already rendering as "pages embedded".
  const pageEntries = await embedPageLevel(provider, targets, batchSize, expectedDim, now, onProgress);
  const chunkEntries = await embedChunkLevel(provider, targets, batchSize, expectedDim, now);

  const reembedSet = new Set(targets.map((p) => p.pageId));
  const store = mergeReembedded(migrated, pageEntries, chunkEntries, reembedSet);
  const report = {
    pagesEmbedded: pageEntries.length,
    chunksEmbedded: chunkEntries.length,
    requests: requestCount(),
  };
  // Chunks are only knowable after the chunk pass, so the cardinality is
  // published once here rather than interpolated during the page pass.
  onDetail?.({ chunks: report.chunksEmbedded, requests: report.requests });
  return { store, report };
}

/** Embed the page-level vector for each target, keyed by pageId with its text hash. */
async function embedPageLevel(
  provider: ReturnType<typeof makeCountingProvider>["provider"],
  targets: CollectedPage[],
  batchSize: number,
  expectedDim: number | undefined,
  now: string,
  onProgress?: EmbeddingProgressCallback,
): Promise<PageEmbeddingV3[]> {
  if (targets.length === 0) return [];
  const vectors = await embedWorkItems(
    provider, targets, (p) => p.embeddingText, (i) => targets[i]?.pageId, "page", batchSize, expectedDim, onProgress,
  );
  return targets.map((page, i) => ({
    pageId: page.pageId,
    title: page.title,
    summary: page.summary,
    embeddingTextHash: page.embeddingTextHash,
    vector: vectors[i],
    updatedAt: now,
  }));
}

/**
 * Embed every chunk of every target in one shared batch, keyed by (pageId, index).
 *
 * Intentionally takes no progress sink: chunk counts are not page counts, so
 * publishing them would misreport the page unit the caller already committed to.
 */
async function embedChunkLevel(
  provider: ReturnType<typeof makeCountingProvider>["provider"],
  targets: CollectedPage[],
  batchSize: number,
  expectedDim: number | undefined,
  now: string,
): Promise<ChunkEmbeddingV3[]> {
  const work = buildChunkWork(targets);
  if (work.length === 0) return [];
  const vectors = await embedWorkItems(
    provider, work, (w) => w.text, (i) => work[i]?.pageId, "chunk", batchSize, expectedDim,
  );
  return work.map((w, i) => ({
    pageId: w.pageId,
    title: w.title,
    chunkIndex: w.chunkIndex,
    contentHash: w.contentHash,
    text: w.text,
    vector: vectors[i],
    updatedAt: now,
  }));
}

/** Flatten every target's chunk texts into a deterministic (page, index) work-list. */
function buildChunkWork(targets: CollectedPage[]): ChunkWork[] {
  const work: ChunkWork[] = [];
  for (const page of targets) {
    page.chunkTexts.forEach((text, chunkIndex) => {
      work.push({ pageId: page.pageId, title: page.title, chunkIndex, contentHash: page.chunkContentHashes[chunkIndex], text });
    });
  }
  return work;
}

/**
 * Merge freshly-embedded page/chunk records over the migrated store: drop any
 * preserved record whose pageId was re-embedded this pass, then append the fresh
 * ones. The store dimension is taken from the first available vector.
 */
function mergeReembedded(
  migrated: EmbeddingStoreV3,
  pageEntries: PageEmbeddingV3[],
  chunkEntries: ChunkEmbeddingV3[],
  reembedSet: Set<PageId>,
): EmbeddingStoreV3 {
  const entries = [...migrated.entries.filter((e) => !reembedSet.has(e.pageId)), ...pageEntries];
  const chunks = [...(migrated.chunks ?? []).filter((c) => !reembedSet.has(c.pageId)), ...chunkEntries];
  const dimensions = entries[0]?.vector.length ?? chunks[0]?.vector.length ?? migrated.dimensions;
  return { version: 3, model: migrated.model, dimensions, entries, chunks };
}
