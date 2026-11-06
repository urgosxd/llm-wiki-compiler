/**
 * Shared interfaces for the compilation pipeline modules.
 *
 * These types are referenced by the orchestration spine (`index.ts`) and by
 * the extracted leaf modules (`extraction-merge`, `review-pipeline`,
 * `seed-pages`, `compile-report`). They live here, rather than in any single
 * module, so the modules can depend on the shapes without importing each other
 * — keeping the dependency graph acyclic.
 */

import type { CompilePageWrite } from "./compile-write.js";
import type { ContextualLinkCounts } from "./link-anchoring.js";
import type { LinkReviewCounts } from "./link-review.js";
import type { RelatedPageIndex } from "./page-renderer.js";
import type {
  ExtractedConcept,
  ReviewedCandidateRef,
  SourceChange,
  SourceState,
} from "../utils/types.js";

/** Per-source state snapshots keyed by source filename. */
export type SourceStateMap = Record<string, SourceState>;

/** A concept with all contributing sources merged for generation. */
export interface MergedConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
  /** Rebuild from live sources without feeding the prior page back to the model. */
  rebuild?: boolean;
  /**
   * Names that folded into this concept page, from the identity stage's decision.
   *
   * Carried on the merged entry so page generation records them in the surviving
   * page's frontmatter: the aliases are the reason a future ingest can fold the same
   * names deterministically instead of re-deciding them by similarity.
   */
  aliases?: readonly string[];
  /**
   * The run's shared sibling-page index, so every page of the run ranks its
   * cross-reference context against the SAME snapshot instead of re-reading the
   * wiki per page. Built once by the pipeline; absent for a single-page caller.
   */
  relatedPages?: RelatedPageIndex;
}

/** Buckets of source changes used by the compile pipeline. */
export interface ChangeBuckets {
  toCompile: SourceChange[];
  deleted: SourceChange[];
  unchanged: SourceChange[];
}

/** Result of phase 2: page writes plus any errors collected along the way. */
export interface PageGenerationResult {
  /** All merged concepts generated this run, including held candidates. */
  pages: MergedConcept[];
  /** Concept pages actually written into wiki/concepts this run. */
  writtenPages: MergedConcept[];
  errors: string[];
  /** Candidate ids written by --review or review policy. Empty otherwise. */
  candidates: string[];
  /** Structured split of candidates created this run. */
  review: {
    held: ReviewedCandidateRef[];
    forced: ReviewedCandidateRef[];
  };
  /**
   * Slugs of seed pages written this run (overview / comparison / entity).
   * Concept pages live on `pages`; seed pages don't fit MergedConcept's
   * source-list shape, so they're tracked separately here. summarizeCompile
   * concatenates these into CompileResult.pages so downstream consumers
   * (MCP, embeddings, programmatic callers) see seed-page changes too.
   */
  seedSlugs: string[];
  /**
   * What the ONE final link gate decided for this run: links kept, and how many
   * each rule demoted.
   *
   * Optional because it is filled by the link phase, which runs after this result is
   * built and after every page of the run exists — the only point where a link into
   * a page this same run created can be judged. `compile-report` prints it as ONE
   * aggregate line next to the per-page detail, so a run's link budget is visible
   * without reading every page's warning.
   */
  linkCounts?: ContextualLinkCounts;
  /**
   * What the incremental reference review of EARLIER pages decided this run: pages
   * reviewed, links added, and candidates dropped by each named bound.
   *
   * Optional for the same reason as {@link linkCounts}: it is filled by a stage that
   * runs after this result is built. `compile-report` prints it as ONE line, and
   * stays silent when the stage found nothing, reviewed nothing and dropped nothing.
   */
  linkReview?: LinkReviewCounts;
}

/**
 * The run's mutable report totals, collected by the stages that run after
 * generation.
 *
 * Grouped into one object because they are written in place by stages deeper than
 * the pipeline that builds the result, and because a caller that threaded one and
 * forgot the other would publish a compile whose limits are silently absent -- the
 * defect `S12` forbids.
 */
export interface RunReportTotals {
  /** Links kept and demoted by the ONE final link gate. */
  linkCounts: ContextualLinkCounts;
  /** Pages reviewed and links added by the incremental reference review. */
  linkReview: LinkReviewCounts;
}

/** Outcome of generating a single merged concept page. */
export interface MergedPageOutcome {
  error?: string;
  /**
   * A valid live page to write, deferred to the batched executor apply in
   * {@link generatePagesPhase}. Set ONLY on the live-write branch; the two
   * candidate branches leave it unset (they persist a candidate JSON instead).
   */
  liveWrite?: CompilePageWrite;
  candidate?: {
    mode: "held" | "forced";
    id: string;
    ref: ReviewedCandidateRef;
  };
}
