/**
 * Presentation and logging for the compilation pipeline.
 *
 * Owns the single responsibility of REPORTING what a compile did — emitting the
 * CLI banners/status lines, journalling the run to `log.md`, and building the
 * structured {@link CompileResult} — without mutating any content pages on disk.
 * Every function here is pure presentation or append-only activity logging; the
 * orchestration spine in `index.ts` owns the page-mutating work.
 */

import { appendLog, formatList, formatWikilinkList } from "../utils/activity-log.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { describeLinkCounts } from "./link-anchoring.js";
import { describeLinkReview, hasLinkReviewTruncation } from "./link-review.js";
import { describeCuratedLinks } from "./curated-links.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractionResult } from "./deps.js";
import type {
  CompileOptions,
  CompileResult,
  SourceChange,
} from "../utils/types.js";
import type { ChangeBuckets, PageGenerationResult } from "./types.js";

/**
 * Journal a non-review compile to log.md: the source files consumed, plus the
 * produced pages split into created (new on disk) and updated (overwritten).
 * Compile only ever writes concept-namespace pages (concept and seed pages both
 * land under wiki/concepts/), so existence is checked against that namespace.
 *
 * @param env - Environment naming the Stack the journal entry belongs to; defaults to
 *   `process.env`. The compile's OWN environment must be passed: the journal is
 *   Stack-scoped (`appendLog` -> `withJournalSource`), so leaving this to the default
 *   journalled a compile of Stack A into whichever Stack the process served — a
 *   cross-tenant WRITE, which outlives the call.
 */
export async function logCompile(
  root: string,
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  existingIds: Set<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) return;
  const produced = [...new Set([...generation.writtenPages.map((entry) => entry.slug), ...generation.seedSlugs])];
  const existed = (slug: string): boolean => existingIds.has(`${CONCEPTS_DIR}/${slug}`);
  const created = produced.filter((slug) => !existed(slug));
  const updated = produced.filter((slug) => existed(slug));
  const heading = `${buckets.toCompile.length} source(s) → ${produced.length} page(s)`;
  const details: string[] = [];
  if (buckets.toCompile.length > 0) {
    details.push(`Sources: ${formatList(buckets.toCompile.map((change) => change.file))}`);
  }
  if (created.length > 0) details.push(`Created: ${formatWikilinkList(created)}`);
  if (updated.length > 0) details.push(`Updated: ${formatWikilinkList(updated)}`);
  if (buckets.deleted.length > 0) details.push(`Deleted sources: ${buckets.deleted.length}`);
  await appendLog(root, "compile", heading, { details, env });
}

/** Build the structured CompileResult and emit the CLI completion banner. */
export function summarizeCompile(
  buckets: ChangeBuckets,
  generation: PageGenerationResult,
  extractions: ExtractionResult[],
  options: CompileOptions,
  retireErrors: readonly string[] = [],
): CompileResult {
  output.header("Compilation complete");
  output.status("✓", output.success(
    `${buckets.toCompile.length} compiled, ${buckets.unchanged.length} skipped, ${buckets.deleted.length} deleted`,
  ));
  reportLinkTotals(generation);
  reportLinkReview(generation);
  reportCuratedLinks(generation);
  if (generation.candidates.length > 0) {
    output.status("?", output.info(
      reviewSummaryLine(generation),
    ));
  } else if (buckets.toCompile.length > 0) {
    output.status("→", output.dim('Next: llmwiki query "your question here"'));
  }

  // Dimension-retirement failures ride along with the compile errors: the wiki
  // write succeeded, but the graph is now behind it, and a caller has to know
  // rather than assume the two dimensions agree.
  const errors = [...generation.errors, ...retireErrors];
  for (const result of extractions) {
    if (result.concepts.length === 0) {
      errors.push(`No concepts extracted from ${result.sourceFile}`);
    }
  }

  // Concept-page slugs first, then seed-page slugs from the same run, so
  // downstream consumers see every page the compile actually produced.
  // Seed pages are deterministic schema-driven writes; before this they
  // landed on disk silently and never appeared on CompileResult.pages.
  const conceptSlugs = generation.writtenPages.map((entry) => entry.slug);
  const baseResult: CompileResult = {
    compiled: buckets.toCompile.length,
    skipped: buckets.unchanged.length,
    deleted: buckets.deleted.length,
    concepts: generation.pages.map((entry) => entry.concept.concept),
    pages: [...conceptSlugs, ...generation.seedSlugs],
    errors,
  };
  if (generation.candidates.length > 0) {
    baseResult.candidates = generation.candidates;
    baseResult.review = generation.review;
  }
  return baseResult;
}

/**
 * Print ONE aggregate line for the whole run's contextual links.
 *
 * The per-page lines the gate emits say WHICH page lost a link and why; this says
 * what the run spent of its link budget. It follows the same silence rule as those
 * lines — it appears exactly when a rule refused something, because a clean run has
 * nothing to report and a limit nobody can see is the defect S8 forbids.
 *
 * @param generation - The compile-stage result, carrying the gate's run totals when
 *   the link phase ran.
 */
function reportLinkTotals(generation: PageGenerationResult): void {
  if (generation.linkCounts === undefined) return;
  const summary = describeLinkCounts(generation.linkCounts);
  if (summary === null) return;
  output.status("🔗", output.warn(`Contextual links in this run: ${summary}.`));
}

/**
 * Print ONE line for the incremental review of earlier pages, and nothing at all
 * when it had nothing to do.
 *
 * Two different claims need two different lines. The gate line above reports links
 * it REFUSED; this one reports what the review of EARLIER pages did, and whether a
 * bound cut its work short. A truncated run is printed as a warning and a clean one
 * as information, so a bound that fired is never mistaken for a quiet run -- the
 * silent limit S12 forbids. Silence here means the stage found no candidate, made no
 * review call and dropped nothing.
 *
 * @param generation - The compile-stage result, carrying the review totals when the
 *   link phase ran.
 */
function reportLinkReview(generation: PageGenerationResult): void {
  if (generation.linkReview === undefined) return;
  const summary = describeLinkReview(generation.linkReview);
  if (summary === null) return;
  const line = `Link review of earlier pages: ${summary}.`;
  output.status("🔗", hasLinkReviewTruncation(generation.linkReview)
    ? output.warn(line)
    : output.info(line));
}

/**
 * Print ONE line for the DURABLE curated links this run restored, stored or refused.
 *
 * Why a separate line from the two above: those report what the run DECIDED about links
 * (kept, demoted, added), while this reports what the wiki will still have AFTER this
 * run -- a curated link put back into a regenerated page, a record stored for one, and
 * a record dropped because the prose no longer supports it. A restored link and a lost
 * link are equally invisible without it, which is what S12 is about.
 *
 * @param generation - The compile-stage result, carrying the curated totals when any
 *   body-rewriting stage ran.
 */
function reportCuratedLinks(generation: PageGenerationResult): void {
  const counts = generation.curatedLinks;
  if (counts === undefined) return;
  const summary = describeCuratedLinks(counts);
  if (summary === null) return;
  const line = `Curated links: ${summary}.`;
  // A DROPPED record is a link the wiki just lost; a restored one is expected work.
  output.status("🔗", counts.dropped["anchor-missing"] > 0 ? output.warn(line) : output.info(line));
}

/** Human completion line for candidates created this run. */function reviewSummaryLine(generation: PageGenerationResult): string {
  const held = generation.review.held.length;
  const forced = generation.review.forced.length;
  if (held > 0 && forced === 0) {
    return `Wrote ${generation.writtenPages.length} page(s), held ${held} for review — run \`llmwiki review list\``;
  }
  return `${generation.candidates.length} candidate(s) awaiting review — run \`llmwiki review list\``;
}

/** Print a summary of detected source file changes. */
export function printChangesSummary(changes: SourceChange[]): void {
  const iconMap: Record<string, string> = {
    new: "+", changed: "~", unchanged: ".", deleted: "-",
  };
  const fmtMap: Record<string, (s: string) => string> = {
    new: output.success, changed: output.warn, unchanged: output.dim, deleted: output.error,
  };

  for (const c of changes) {
    const icon = iconMap[c.status] ?? "?";
    const fmt = fmtMap[c.status] ?? output.dim;
    const label = c.reason === "deselected" ? "deselected; file untouched" : c.status;
    output.status(icon, fmt(`${c.file} [${label}]`));
  }
  const deselected = changes.filter((change) => change.reason === "deselected").length;
  if (deselected) output.status("i", output.dim(
    `${deselected} source contribution(s) will be retired; to restore a source, select it again and compile.`,
  ));
}

/** Log where the schema was loaded from so the user can confirm it was picked up. */
export function reportSchemaStatus(schema: SchemaConfig): void {
  if (schema.loadedFrom) {
    output.status("i", output.dim(`Schema: ${schema.loadedFrom}`));
  }
}

/** Log slugs held because at least one required source failed extraction. */
export function reportFrozenSlugs(frozenSlugs: Set<string>): void {
  for (const slug of frozenSlugs) {
    output.status("i", output.dim(`Frozen: ${slug} (required source extraction failed)`));
  }
}
