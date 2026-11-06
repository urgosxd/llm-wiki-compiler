/**
 * @file packages/llmwiki-kg/ts/src/routes/reclassify/types.ts
 * @description The vocabulary of a reclassification run: what one stored decision
 * looks like when read back, and what a run reports.
 *
 * ## A stored decision is read, never assumed
 *
 * The ingest pipeline knows the previous state of every row it classifies: it wrote
 * `pending` itself, moments earlier. A reclassification pass has no such knowledge —
 * the row was decided by another run, under another catalog, possibly by a human —
 * so the previous state and the previous canonical type are READ and carried into the
 * plan and into the history log. Anything else would make the log a record of what the
 * writer expected rather than of what changed.
 *
 * ## The report is counts, because a reclassification has no single row to return
 *
 * One run touches many rows across two tables, and the interesting outcomes are
 * mutually exclusive per row: it changed, it was only refreshed, it did not move, it
 * was refused because a human verified it, or it was preserved because the classifier
 * could not answer. Those counts are what makes a sweep auditable at a glance, and
 * `truncated` is what keeps a bounded run legible as bounded (S9).
 */

import type {
  ClassificationState,
  CompatibilityState,
  SupportState,
} from "../../schema-open-classification.js";
import type { KnowledgeCandidate } from "../../core/candidates/types.js";
import type { CandidateEvidence } from "../../core/classify/types.js";

/**
 * The classification columns of one stored row.
 *
 * `verified` is copied here because it decides whether the row may be touched at all
 * (S39); it is never written by anything in this module.
 */
export interface StoredDecision {
  readonly classificationState: ClassificationState | null;
  readonly canonicalType: string | null;
  readonly supportState: SupportState | null;
  readonly catalogVersion: string | null;
  readonly classifierVersion: string | null;
  readonly verified: boolean;
}

/** One row a reclassification run selected, with the evidence it will be judged against. */
export interface ReclassifyRow {
  readonly id: string;
  readonly kind: "entity" | "relationship";
  /** The candidate ref the row's newest located evidence carries, and the log's key. */
  readonly ref: string;
  readonly stored: StoredDecision;
  /** The compatibility verdict storage already holds; relationships only. */
  readonly compatibility: CompatibilityState | null;
  /**
   * Where a relationship row sits: both endpoint ids and its stored identity key.
   *
   * Present only for relationships, and only because the shared decision updater
   * addresses an edge that way. Carrying it here keeps one writer for the decision
   * columns instead of a second, id-addressed copy in this module.
   */
  readonly edge?: { readonly fromId: string; readonly toId: string; readonly identityKey: string };
  /**
   * The candidate built from the STORED row, never from a fresh extraction.
   *
   * It carries the same fields an ingest candidate carries — the name or the two
   * endpoint names plus the original predicate, and the type the extractor proposed —
   * because the classification stage takes candidates, not rows. Rebuilding it from
   * storage is what makes a re-decision cost no extraction, no chunking and no
   * embedding (S43).
   */
  readonly candidate: KnowledgeCandidate;
  /** The quote and the stored chunk the classifier is asked against (S19). */
  readonly evidence: CandidateEvidence;
}

/** Everything one run selected, and everything it had to leave out. */
export interface ReclassifySelection {
  /** The catalog this run is deciding under, already resolved for the Stack. */
  readonly catalogVersion: string;
  /** Rows the classifier will be asked about, entities first. */
  readonly classifiable: readonly ReclassifyRow[];
  /** Rows left untouched because a human verified them (S39). */
  readonly refusedVerified: readonly ReclassifyRow[];
  /** Rows whose versions are stale but whose evidence is not located: never guessed. */
  readonly skippedNoEvidence: number;
  /** How many rows the skew predicate selected, refused and skipped ones included. */
  readonly selected: { readonly entities: number; readonly relationships: number };
  /** True when there was more to select than one run is allowed to take. */
  readonly truncated: boolean;
}

/** What one reclassification run did, in counts. */
export interface ReclassificationReport {
  readonly stack_id: string;
  readonly catalog_version: string;
  readonly classifier_version: string;
  readonly jev_model: string;
  readonly selected: { readonly entities: number; readonly relationships: number };
  /** Decisions written to a row, `changed` and `versions_refreshed` together. */
  readonly applied: number;
  /** Rows whose classification state or canonical type moved. */
  readonly changed: number;
  /** Rows re-decided to the same answer under a new catalog or classifier version. */
  readonly versions_refreshed: number;
  /** Rows that were selected, asked, and answered identically under the same versions. */
  readonly unchanged: number;
  /** Human-verified rows the run left alone, and said so (S39). */
  readonly refused_verified: number;
  /** Rows kept intact because the classifier failed operationally (S45.13). */
  readonly preserved_after_failure: number;
  /** Rows with no located quote: selected by version, never classified without evidence. */
  readonly skipped_no_evidence: number;
  /** True when one run was not allowed to take everything that matched. */
  readonly truncated: boolean;
}
