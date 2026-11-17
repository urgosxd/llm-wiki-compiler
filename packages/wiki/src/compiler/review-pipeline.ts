/**
 * Per-page page-generation pipeline for the compiler.
 *
 * Owns the single responsibility of turning one {@link MergedConcept} into a
 * {@link MergedPageOutcome}: render the page, run the validate prefilter, clear any
 * candidate the live write supersedes, and DEFER the write for the caller to commit as
 * a journalled batch.
 *
 * No review path lives here any more. Every candidate stager is retired because no
 * surface promotes a candidate into the wiki, so a hold could never be honoured: a page
 * this module renders is always a live write and never a staged record.
 */

import { validateWikiPage } from "../utils/markdown.js";
import { renderMergedPageContent } from "./page-renderer.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import { deleteCandidateBySlug } from "./candidates.js";
import * as output from "../utils/output.js";
import type { SchemaConfig } from "../schema/index.js";
import type { StackAuthority } from "../dimensions/stack-authority.js";
import type { MergedConcept, MergedPageOutcome } from "./types.js";

/**
 * Generate a wiki page from merged source content.
 * For shared concepts, the LLM sees content from all contributing sources
 * and frontmatter records every source file. The rendered page is validated with the
 * skip-invalid prefilter and then returned as a deferred live write.
 *
 * `contentSource` is the run's page reader, and it is load-bearing rather than
 * cosmetic: the renderer re-reads the page it is about to replace to carry forward
 * the fields only that page knows (`createdAt` and the aliases it already answers to).
 * Without it the read went to `wiki/concepts` on a corpus that lives in rows, found
 * nothing, and every re-render silently dropped the aliases the previous run had
 * already decided (S2). Absent keeps the on-disk read, so a file-backed run is
 * unchanged.
 *
 * @param root - Project root directory.
 * @param entry - The merged concept this page renders.
 * @param schema - The run's schema, used by the renderer and the prefilter.
 * @param env - The run's environment, and it is the PUBLISHED one: the compile resolved one
 *   Stack authority and wrote its id into this env before handing it down. The candidate
 *   seam branches on the id it finds here, so a run whose Stack came from the database
 *   clears its duplicate in THAT Stack's queue instead of in `.llmwiki/candidates`.
 *   Re-deriving it here from `options.env` was the defect: the request's env knows nothing
 *   about a Stack the database resolved.
 * @param contentSource - The run's page reader, or `undefined` to read `wiki/concepts`.
 * @param authority - The Stack this run RESOLVED, handed down as a value. The candidate
 *   custody seam branches on it rather than on the ambient `AKS_STACK_ID`, so a
 *   row-backed run no longer demands a candidate DIRECTORY of its own queue.
 * @returns The page outcome: a deferred live write, or the validation error.
 */
export async function generateMergedPage(
  root: string,
  entry: MergedConcept,
  schema: SchemaConfig,
  env: NodeJS.ProcessEnv,
  contentSource: PageContentSource | undefined,
  authority: StackAuthority,
): Promise<MergedPageOutcome> {
  // `env` is the run's PUBLISHED environment and `authority` is the Stack it resolved. Both
  // arrive as values: the compile resolved once, and neither this function nor the seams
  // below ask the environment a question the resolution already answered.
  //
  // `env` stays alongside `authority` because the seam below selects its backend FROM the
  // env (`candidate-source.ts` reads the id the publication wrote) and opens a connection
  // with it, while `authority` is what the custody branch reads. One resolution, two
  // transports of the same answer.
  const fullPage = await renderMergedPageContent(root, entry, schema, contentSource);

  if (!validateWikiPage(fullPage)) {
    output.status("!", output.warn(`Invalid page for "${entry.concept.concept}" — skipped.`));
    return { error: `Invalid page for "${entry.concept.concept}" — failed validation` };
  }
  await deleteCandidateBySlug(root, env, entry.slug, {}, authority);
  return { liveWrite: { namespace: "concepts", slug: entry.slug, body: fullPage } };
}
