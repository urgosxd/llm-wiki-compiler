/**
 * @file The two-page-merge scenario the synthesis and attribution tests share: a second
 * source whose ingest makes a concept's article draw on TWO sources, plus the move that
 * adds it.
 *
 * WHY A FIXTURE. Both files need the same second contributor carrying the same bytes, and
 * one of them asserts a character count over that text. Two copies would let one drift and
 * silently change what the other measures -- and a "merged article" that is not really
 * merged passes the very assertions the two files exist for.
 */

import { writeSource } from "./curated-scenario.js";

/** Filename of the second source, as a page's frontmatter records it. */
export const BETA = "beta.md";

/** Beta's whole text: the same concept as alpha, a different account of it. */
export const BETA_SOURCE = "# Vector DB\n\nBeta says embeddings are indexed.\n";

/**
 * Write beta's source into the project, leaving alpha's in place.
 * @param root - Project root.
 */
export async function addBetaSource(root: string): Promise<void> {
  await writeSource(root, BETA, BETA_SOURCE);
}
