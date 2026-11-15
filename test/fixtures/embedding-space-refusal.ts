/**
 * @file test/fixtures/embedding-space-refusal.ts
 * @description Assert that retrieval REFUSED a store recorded in another embedding space.
 *
 * ## Why this is one helper and not three copies
 *
 * Three retrieval paths refuse with the same error class over the same contract: the
 * message must name BOTH sides (S4) -- the store's recorded model and width, and the
 * active model -- so an operator can tell which side to change. Each path asserted
 * that contract on its own, and fallow flagged the copies.
 *
 * The risk of a copy here is specific: one that drifted to assert only the class, or
 * only one of the two sides, would still pass while the diagnostic it guards lost the
 * half an operator needs to act on. `embeddings-degrade.ts` exists for the same
 * reason on the other side of the contract -- the suites must agree, not merely each
 * look green.
 */

import { expect } from "vitest";

import { EmbeddingSpaceMismatchError } from "../../packages/wiki/src/utils/embeddings-store.js";

/** The store side of a refusal: what the stored vectors say they are. */
export interface StoredSpace {
  /** Model id the store records. */
  readonly model: string;
  /** Width the store's vectors actually have. */
  readonly dimensions: number;
}

/**
 * Await a retrieval call and narrow its rejection to the space refusal.
 *
 * A degradation would return a value instead of throwing, so anything that is not the
 * named refusal is reported as a failure rather than silently ignored.
 *
 * @param call - The promise a retrieval entry point returned.
 * @returns The refusal, once it is proven to be one.
 */
export async function spaceRefusalOf(call: Promise<unknown>): Promise<EmbeddingSpaceMismatchError> {
  const settled = await call.catch((error: unknown) => error);
  if (!(settled instanceof EmbeddingSpaceMismatchError)) {
    throw new Error(`expected the space refusal, got ${JSON.stringify(settled)}`);
  }
  return settled;
}

/**
 * Assert the refusal names BOTH sides, so an operator can tell which one to change.
 *
 * Model ids and dimension counts are configuration, not secrets, which is why they may
 * be printed where an endpoint or a key may not.
 *
 * @param refusal - The refusal a retrieval entry point raised.
 * @param stored - Model id and width the store records.
 * @param activeModel - Model id the active configuration resolves to.
 */
export function expectSpaceRefusalNamesBothSides(
  refusal: Error | null | undefined,
  stored: StoredSpace,
  activeModel: string,
): void {
  expect(refusal?.message).toContain(`"${stored.model}"`);
  expect(refusal?.message).toContain(`${stored.dimensions} dimensions`);
  expect(refusal?.message).toContain(`"${activeModel}"`);
}
