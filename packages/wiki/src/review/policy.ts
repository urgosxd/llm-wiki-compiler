/**
 * Review vocabulary shared by the candidate store and the surfaces that read it.
 *
 * The compile pipeline decides NOTHING here any more. The `review.hold` policy, its
 * evaluator and the modes that configured it are retired: no surface promotes a
 * candidate into the wiki, so a hold could never be honoured and evaluating one only
 * produced records nothing could act on.
 *
 * What remains is the RECORD shape. The closed reason set and the origin discriminator
 * are stored on candidate JSON that already exists on disk, and those records stay
 * readable — a retirement removes the producers, never the data.
 */

/**
 * Closed set of review reasons a stored candidate can carry.
 *
 * The Trust Guard's staged-write surface widens this into an OPEN union
 * (`HeldReasonCode` in `src/trust/staged-change.ts`) that keeps these literals
 * as a strict subset and adds trust-routing codes; this stays the narrow,
 * canonical policy set so the candidate store and its readers keep an exhaustive union.
 */
export type PolicyHeldReasonCode =
  | "low-confidence"
  | "contradicted"
  | "schema-violating"
  | "provenance-violating"
  | "all"
  | "manual-review-requested"
  | "imported-okf"
  | "connector-fetched";

/** Structured reason a stored candidate was held for review. */
export interface HeldReason {
  code: PolicyHeldReasonCode;
  detail?: string;
}

/**
 * Candidate origin recorded on the record: policy-selected, explicitly forced,
 * imported, or connector-fetched.
 *
 * All four literals stay declared because stored records carry them, even though no
 * producer can emit `policy` or `forced` any more. Reading one is the compatibility
 * path; writing one is gone.
 */
export type ReviewMode = "policy" | "forced" | "imported" | "connector";
