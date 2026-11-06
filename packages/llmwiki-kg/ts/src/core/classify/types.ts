/**
 * @file packages/llmwiki-kg/ts/src/core/classify/types.ts
 * @description The classification stage's own vocabulary: what one decision knows,
 * and which axes it keeps apart.
 *
 * ## A decision is not a verdict
 *
 * The JEV adapter answers a question with a {@link ClassificationVerdict}; a
 * decision is what this stage hands to persistence. The difference is that a
 * decision carries the three magnitudes that must never be confused with one
 * another, each in its own field:
 *
 * - `classificationState` — did a catalog type get assigned, and if not, why not:
 *   no match, ambiguity, or an operational problem (`pending` / `failed`).
 * - `supportState` — whether the source evidence supports the claim. Passed in by
 *   the caller from the evidence stage, never derived from the classification.
 * - `compatibility` (relations only) — whether the endpoint types are permitted by
 *   the catalog. Computed here, independently of every other axis.
 *
 * S23 requires those to stay distinguishable, so they are separate optional fields
 * of one record rather than a single confidence number that would blend them. The
 * fourth magnitude — human verification — is deliberately absent: nothing in this
 * stage may set it (S4, S39).
 *
 * ## Invariants the shape enforces
 *
 * `canonicalType` is non-null **iff** `classificationState` is `classified`. A free
 * entity or relation therefore cannot carry a type, which is what makes "free" mean
 * "no catalog type could be assigned" rather than "assigned a placeholder" (S3,
 * S27). `predicate` on a relation decision is always the extractor's original verb,
 * in every branch, including `classified` (S30, S31).
 *
 * ## Vocabulary is re-exported, never re-invented
 *
 * The three state names come from `schema-open-classification.ts`, the drizzle
 * mirror of the landed migration. Declaring parallel unions here would let storage
 * and this stage drift apart one string at a time.
 */

import type { KnowledgeCandidate } from "../candidates/types.js";
import type { TypeCatalog } from "../catalog/types.js";
import type { JevConfig } from "../jev/config.js";
import type { JevChoiceReadout, JevDecisionClient } from "../jev/types.js";
import type { ClassificationState, CompatibilityState, SupportState } from "../../schema-open-classification.js";

export type { ClassificationState, CompatibilityState, SupportState };

/**
 * Raised when the caller's input cannot be classified at all.
 *
 * A missing evidence quote or a blank predicate is a bug in the wiring, not a
 * condition of the provider: retrying the identical batch cannot fix it, so it is
 * reported loudly instead of becoming a stored `failed` decision that would look
 * like an outage forever.
 */
export class ClassificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassificationInputError";
  }
}

/**
 * The source text a candidate must be classified against.
 *
 * `quote` is the span the evidence stage located (T3) and `context` is the chunk it
 * was read from, which is what S19 means by "candidate and sufficient context"
 * plus "original evidence". Neither is normalized or truncated here.
 */
export interface CandidateEvidence {
  readonly quote: string;
  readonly context: string;
}

/** The fields every classification decision carries, whatever its kind. */
interface DecisionCore {
  /** The run-scoped candidate identifier this decision was made for. */
  readonly ref: string;
  /** Which of the five storage states the classifier ended in. */
  readonly classificationState: ClassificationState;
  /** The canonical catalog type, and only when the state is `classified`. */
  readonly canonicalType: string | null;
  /** The caller's semantic-support judgement, or `null` when none was recorded. */
  readonly supportState: SupportState | null;
  /** Why the classifier abstained or failed; `null` for a positive classification. */
  readonly reason: string | null;
  /** The vendor's raw answer, absent when the provider never answered. */
  readonly readout: JevChoiceReadout | null;
  /** The catalog version this decision was produced under. */
  readonly catalogVersion: string;
}

/** The classification of one entity candidate. */
export interface EntityClassificationDecision extends DecisionCore {
  readonly kind: "entity";
  /** The entity name as the extractor found it, verbatim. */
  readonly name: string;
}

/**
 * The classification of one relation candidate.
 *
 * `predicate` and `identityKey` are the two facts S33 needs: the verb is kept
 * verbatim for every branch, and the key derived from it is what lets a later
 * reclassification find this same decision again.
 */
export interface RelationClassificationDecision extends DecisionCore {
  readonly kind: "relationship";
  readonly fromName: string;
  readonly toName: string;
  /** The original predicate, verbatim, in every branch including `classified`. */
  readonly predicate: string;
  /** The dedup/reclassification key derived from the predicate. See `identity.ts`. */
  readonly identityKey: string;
  /** Whether the endpoint types are permitted by the catalog (S34). */
  readonly compatibility: CompatibilityState;
}

/** One decision of either kind. */
export type CandidateDecision = EntityClassificationDecision | RelationClassificationDecision;

/** Everything one classification run produced. */
export interface ClassificationBatch {
  /** The catalog version every decision in the batch was made under. */
  readonly catalogVersion: string;
  readonly entityDecisions: readonly EntityClassificationDecision[];
  readonly relationDecisions: readonly RelationClassificationDecision[];
  /** Both lists in candidate order, entities first, for a caller that wants one pass. */
  readonly decisions: readonly CandidateDecision[];
}

/**
 * Everything the classification stage needs from its caller.
 *
 * There is no database handle anywhere in this type: the stage is pure over its
 * inputs so the same call runs in a test, in the pipeline, and in a
 * reclassification pass (T13) without a transaction open across a provider call.
 */
export interface ClassifyCandidatesInput {
  /** The open candidates one run produced (T4), entities and relations intermixed. */
  readonly candidates: readonly KnowledgeCandidate[];
  /** The Stack's versioned catalog, used for orientation and for compatibility. */
  readonly catalog: TypeCatalog;
  /** The decision client: the real adapter, or the scripted double in tests. */
  readonly client: JevDecisionClient;
  /** Endpoint, model and the four confidence bands. */
  readonly config: JevConfig;
  /** The located quote and chunk per candidate ref. Every candidate needs one. */
  readonly evidence: Readonly<Record<string, CandidateEvidence>>;
  /** Semantic-support judgements by candidate ref, computed by the evidence stage. */
  readonly supportStates?: Readonly<Record<string, SupportState>>;
}
