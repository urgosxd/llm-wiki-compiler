/**
 * @file packages/llmwiki-kg/ts/src/core/classify/decision.ts
 * @description Mapping one JEV verdict onto one storable decision, without inventing anything.
 *
 * ## The mapping, and the three things it refuses to do
 *
 * | Verdict | `classificationState` | `canonicalType` |
 * | --- | --- | --- |
 * | `classified` | `classified` | the resolved catalog spelling |
 * | `free_no_match` | `free_no_match` | `null` |
 * | `free_uncertain` | `free_uncertain` | `null` |
 * | `operational_failure` | that verdict's `pending` / `failed` | `null` |
 *
 * Refused: substituting a default type for an abstention, turning a provider
 * problem into `free_no_match` (S25 — the operational arm is the only source of
 * `pending`/`failed`, and the abstention arms are the only source of the two free
 * states, so neither can be reached from the other), and dropping the original
 * predicate when a canonical type exists (S31).
 *
 * ## Why no branch here produces `Concept` or `Unclassified` (S27)
 *
 * `canonicalType` is copied from the verdict, and a `classified` verdict only exists
 * when `interpretClassification` resolved the chosen label against the catalog. The
 * catalog parser refuses to declare the reserved `Unclassified` label, so a
 * decision cannot carry it; and because there is no default branch in this file,
 * `Concept` can only appear when a caller's catalog declares it and the classifier
 * picked it — which is the one condition S27 allows.
 */

import type { EntityCandidate, RelationCandidate } from "../candidates/types.js";
import type { ClassificationVerdict, JevChoiceReadout } from "../jev/types.js";
import { relationIdentityKey } from "./identity.js";
import type {
  ClassificationState,
  CompatibilityState,
  EntityClassificationDecision,
  RelationClassificationDecision,
  SupportState,
} from "./types.js";

/**
 * The storage state a verdict maps to.
 *
 * A verdict's `status` is already spelled like the storage vocabulary for the three
 * classification outcomes, and the operational arm carries its own state, so this
 * mapping has no default case and no substitution.
 *
 * @param verdict - What interpretation produced.
 * @returns One of the five states the migration's CHECK constraint accepts.
 */
export function classificationStateOf(verdict: ClassificationVerdict): ClassificationState {
  return verdict.status === "operational_failure" ? verdict.state : verdict.status;
}

/**
 * The canonical type a verdict carries, and only for a positive classification.
 *
 * Exported because the compatibility check asks the same question: it needs the
 * relation's canonical type, and asking it any other way would be a second copy of
 * this mapping that could disagree with the decision's own field.
 *
 * @param verdict - What interpretation produced.
 * @returns The canonical spelling, or `null` for every abstention and failure.
 */
export function canonicalTypeOf(verdict: ClassificationVerdict): string | null {
  return verdict.status === "classified" ? verdict.canonicalType : null;
}

/**
 * The vendor readout, absent when the provider never answered.
 *
 * @param verdict - What interpretation produced.
 * @returns The raw answer, or `null`.
 */
function readoutOf(verdict: ClassificationVerdict): JevChoiceReadout | null {
  return verdict.status === "operational_failure" ? null : verdict.readout;
}

/**
 * Why a verdict abstained or failed.
 *
 * @param verdict - What interpretation produced.
 * @returns The reason, or `null` for a positive classification.
 */
function reasonOf(verdict: ClassificationVerdict): string | null {
  return verdict.status === "classified" ? null : verdict.reason;
}

/** What one decision needs besides the verdict itself. */
interface DecisionContext {
  /** The caller's semantic-support judgement, passed through untouched. */
  readonly supportState: SupportState | null;
  /** The catalog version in force for this run. */
  readonly catalogVersion: string;
}

/**
 * Builds the decision for one entity candidate.
 *
 * @param candidate - The entity candidate the verdict is about.
 * @param verdict - What interpretation produced for it.
 * @param context - Support state and catalog version.
 * @returns The storable decision.
 */
export function buildEntityDecision(
  candidate: EntityCandidate,
  verdict: ClassificationVerdict,
  context: DecisionContext,
): EntityClassificationDecision {
  return {
    kind: "entity",
    ref: candidate.ref,
    name: candidate.name,
    classificationState: classificationStateOf(verdict),
    canonicalType: canonicalTypeOf(verdict),
    supportState: context.supportState,
    reason: reasonOf(verdict),
    readout: readoutOf(verdict),
    catalogVersion: context.catalogVersion,
  };
}

/**
 * Builds the decision for one relation candidate.
 *
 * The predicate is copied from the candidate in every branch, including
 * `classified`: the canonical type says which catalog verb the assertion belongs
 * to, and it never replaces what the document said (S30, S31).
 *
 * @param candidate - The relation candidate the verdict is about.
 * @param verdict - What interpretation produced for it.
 * @param context - Support state, catalog version and the compatibility check.
 * @returns The storable decision, keyed by its original predicate.
 */
export function buildRelationDecision(
  candidate: RelationCandidate,
  verdict: ClassificationVerdict,
  context: DecisionContext & { readonly compatibility: CompatibilityState },
): RelationClassificationDecision {
  return {
    kind: "relationship",
    ref: candidate.ref,
    fromName: candidate.fromName,
    toName: candidate.toName,
    predicate: candidate.predicate,
    identityKey: relationIdentityKey(candidate.predicate),
    classificationState: classificationStateOf(verdict),
    canonicalType: canonicalTypeOf(verdict),
    supportState: context.supportState,
    compatibility: context.compatibility,
    reason: reasonOf(verdict),
    readout: readoutOf(verdict),
    catalogVersion: context.catalogVersion,
  };
}
