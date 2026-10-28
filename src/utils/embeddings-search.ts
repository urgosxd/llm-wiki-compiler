/**
 * @file src/utils/embeddings-search.ts
 * @description The cosine-similarity primitive the embedding rankers share.
 *
 * This module used to hold the v1/v2 retrieval surface as well: `findTopK`,
 * `findTopKChunks`, `findRelevantPages`, `findRelevantChunks`, and the store
 * gating that fed them. All of it read a bare `slug`, all of it was superseded by
 * the `pageId`-keyed v3 pipeline in `embeddings-load.ts`, and none of it had a
 * production caller. It was removed rather than maintained in parallel: two
 * ranking implementations answering the same question is where drift starts.
 *
 * What survives is `cosineSimilarity`, used by the live v3 rankers
 * (`embeddings-load.ts`, `dimensions/wiki/concept-resolution.ts`) and by tests, and
 * the warning cache the read path shares.
 */

import * as output from "./output.js";

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 when either vector has zero magnitude (safer than NaN for ranking).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Tracks which warnings have already been emitted, so repeat runs stay quiet. */
const warnedStaleModels = new Set<string>();

/** Test-only hook: clear the warned-pair cache so each test sees a fresh warning. */
export function resetStaleEmbeddingWarnings(): void {
  warnedStaleModels.clear();
}
