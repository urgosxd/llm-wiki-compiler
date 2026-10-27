/**
 * @file test/fixtures/embeddings-degrade.ts
 * @description Assert that a bad store DEGRADES rather than ranks.
 *
 * ## Why this is one helper and not three copies
 *
 * Two invariants matter whenever the loader meets a store it cannot trust: the store
 * must come back `null` (never partially trusted) and the outcome must carry ONE
 * structured warning the caller can branch on. Both were asserted in several suites,
 * and fallow flagged the copies.
 *
 * The risk of duplication here is specific: a copy that checked only `store === null`
 * would pass while the caller lost its reason code, which is the half the CLI and MCP
 * surface actually depend on.
 */

import { expect } from "vitest";

import { loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";

/** Codes the loader can report when it refuses a store. */
export type EmbeddingDegradeCode =
  | "embedding-store-unavailable"
  | "embedding-index-outdated";

/**
 * Load from `root` and assert the store was refused for `code`.
 *
 * @param root - Project root whose store should degrade.
 * @param code - The reason code the outcome must name.
 * @returns The load outcome, for a caller that wants to assert more.
 */
export async function expectDegradedStore(
  root: string,
  code: EmbeddingDegradeCode,
): Promise<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>> {
  const outcome = await loadEmbeddingsForSearch(root);
  expect(outcome.store).toBeNull();
  expect(outcome.warnings.map((warning) => warning.code)).toContain(code);
  return outcome;
}
