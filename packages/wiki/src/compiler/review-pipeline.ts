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
import type { CompileOptions } from "../utils/types.js";
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
 */
export async function generateMergedPage(
  root: string,
  entry: MergedConcept,
  schema: SchemaConfig,
  options: CompileOptions,
  contentSource?: PageContentSource,
): Promise<MergedPageOutcome> {
  // THE BOUNDARY. `generateMergedPage` is where the request enters the page pipeline:
  // `CompileOptions` carries the caller's `env`, and this is the ONE place it is
  // resolved. Every seam below is handed the result, so a run answering for a NAMED
  // Stack clears its duplicate in THAT Stack instead of in whichever tenant the
  // process happens to be bound to.
  const env = options.env ?? process.env;
  const fullPage = await renderMergedPageContent(root, entry, schema, contentSource);

  if (!validateWikiPage(fullPage)) {
    output.status("!", output.warn(`Invalid page for "${entry.concept.concept}" — skipped.`));
    return { error: `Invalid page for "${entry.concept.concept}" — failed validation` };
  }
  await deleteCandidateBySlug(root, env, entry.slug);
  return { liveWrite: { namespace: "concepts", slug: entry.slug, body: fullPage } };
}
