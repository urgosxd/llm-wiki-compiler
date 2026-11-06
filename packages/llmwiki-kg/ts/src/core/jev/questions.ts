/**
 * @file packages/llmwiki-kg/ts/src/core/jev/questions.ts
 * @description The requests we send Jev: a candidate, its original evidence, the
 * catalog definitions, and explicit ways to abstain.
 *
 * ## The four inputs S19 requires, and where each one goes
 *
 * - **The candidate and enough context.** The `state`, as labelled data lines:
 *   the name or the original predicate, both endpoints for a relation, and the
 *   proposed type the extractor guessed. The guess is input, never a decision.
 * - **The original evidence.** The quote exactly as the evidence stage located it
 *   (T3), plus the chunk it came from. It is not paraphrased, truncated or
 *   "cleaned", because the same bytes must remain checkable against the recorded
 *   offsets.
 * - **The catalog definitions.** The `choice` criteria, keyed by canonical name,
 *   each value carrying the type's definition and its examples. Jev sees meaning,
 *   not a bare label list.
 * - **Explicit abstention.** A companion `noul` per classification asking whether
 *   any catalog option fits at all. That question is the ONLY way `NO_MATCH` is
 *   produced: there is no sentinel option, no `Unclassified` criterion and no
 *   catch-all label, so a document whose vocabulary is genuinely outside the
 *   catalog cannot be silently squeezed into a reserved type.
 *
 * ## The state is data, never instruction
 *
 * Everything in `state` is derived from document content — names, predicates, the
 * quote, the surrounding chunk — so all of it goes through the one framing helper
 * this repository has for it (`delimitUntrustedDocument`, S13). The instructions
 * live in the questions, where the vendor expects the task to be, which also keeps
 * "what to do" and "what was observed" in different fields of the wire body.
 *
 * ## One call per decision, no sentinel types
 *
 * Classification and support are separate request builders on purpose: S12 and
 * S23 require the support judgement to be independent of the label decision, so
 * neither request can inherit the other's answer.
 */

import type { EntityTypeDef, RelationTypeDef, TypeCatalog } from "../catalog/types.js";
import { delimitUntrustedDocument } from "../evidence/prompt-data.js";
import { JevQuestionError, MAX_CHOICE_OPTIONS } from "./types.js";
import type { ClassificationQuestionSet, JevDecisionRequest, JevNoulQuestion } from "./types.js";

/** Question ids and namespace of the entity classification decision. */
export const ENTITY_CLASSIFICATION_QUESTIONS: ClassificationQuestionSet = Object.freeze({
  namespace: "entity",
  choice: "entity-type",
  fits: "entity-type-fits",
});

/** Question ids and namespace of the relation classification decision. */
export const RELATION_CLASSIFICATION_QUESTIONS: ClassificationQuestionSet = Object.freeze({
  namespace: "relation",
  choice: "relation-type",
  fits: "relation-type-fits",
});

/** Question id of the semantic-support decision. */
export const SUPPORT_QUESTION_ID = "claim-support";

/**
 * The option labels of the support question.
 *
 * The storage column uses lower case (`supported` / `unsupported`), so this map is
 * the one place the wire spelling and the stored spelling are related.
 */
export const SUPPORT_CHOICE_LABELS = Object.freeze({
  supported: "SUPPORTED",
  unsupported: "UNSUPPORTED",
});

/** How an absent optional value is rendered in the state block. */
const ABSENT = "none";

/** What the paired `noul` criteria mean, shared by both classification requests. */
const FITS_CRITERIA: JevNoulQuestion["criteria"] = Object.freeze({
  true: "At least one catalog option genuinely describes the candidate.",
  false: "No catalog option describes the candidate; it belongs to something the catalog does not name.",
});

const ENTITY_CHOICE_INSTRUCTIONS =
  "Which catalog entity type does the candidate described in the state belong to? Pick the single best option, and pick only an option that is listed.";
const ENTITY_FITS_INSTRUCTIONS =
  "Does at least one catalog entity type genuinely describe the candidate in the state? Answer true only when a listed type really fits it, not when one is merely the closest.";
const RELATION_CHOICE_INSTRUCTIONS =
  "Which catalog relation type does the original predicate between the two entities in the state express? Pick the single best option, and pick only an option that is listed.";
const RELATION_FITS_INSTRUCTIONS =
  "Does at least one catalog relation type genuinely express the original predicate in the state? Answer true only when a listed relation really fits it, not when one is merely the closest.";
const SUPPORT_INSTRUCTIONS =
  "Does the quoted evidence support the claim under review? Answer SUPPORTED when the quote states the claim or directly entails it. Answer UNSUPPORTED when the quote exists but does not support the claim: it is about something else, contradicts it, or relates to it only loosely.";

/**
 * Renders a definition's examples as a trailing sentence.
 *
 * @param examples - Representative labels of the type.
 * @returns A sentence, or an empty string when the type declares no examples.
 */
function describeExamples(examples: readonly string[]): string {
  return examples.length === 0 ? "" : ` Examples: ${examples.join("; ")}.`;
}

/**
 * Describes one entity type for a `choice` criterion.
 *
 * @param def - The canonical entity type.
 * @returns Definition plus examples, the two things a classifier can reason from.
 */
function describeEntityType(def: EntityTypeDef): string {
  return `${def.definition}${describeExamples(def.examples)}`;
}

/**
 * Describes one relation type for a `choice` criterion.
 *
 * Direction is included because a passive phrasing reaches an `inverse` verb from
 * the other end, which changes what the label means.
 *
 * @param def - The canonical relation type.
 * @returns Definition, reading direction and examples.
 */
function describeRelationType(def: RelationTypeDef): string {
  return `${def.definition} Reading direction: ${def.direction}.${describeExamples(def.examples)}`;
}

/**
 * Refuses a catalog that cannot be asked as a single `choice` question.
 *
 * @param count - How many options the criteria would carry.
 * @param kind - Which namespace the options come from, for the message.
 * @throws {JevQuestionError} When the count exceeds the documented limit.
 */
function assertOptionCount(count: number, kind: string): void {
  if (count > MAX_CHOICE_OPTIONS) {
    throw new JevQuestionError(
      `the catalog declares ${String(count)} ${kind} types, but one choice question accepts at most ` +
        `${String(MAX_CHOICE_OPTIONS)} options; truncating them would classify against a vocabulary nobody chose`,
    );
  }
}

/**
 * Builds the `choice` criteria for a catalog's entity types.
 *
 * @param catalog - The Stack's catalog.
 * @returns Canonical name to definition-plus-examples.
 * @throws {JevQuestionError} When the catalog is wider than one question can ask.
 */
function entityCriteria(catalog: TypeCatalog): Record<string, string> {
  assertOptionCount(catalog.entityTypes.length, "entity");
  return Object.fromEntries(catalog.entityTypes.map((def) => [def.name, describeEntityType(def)]));
}

/**
 * Builds the `choice` criteria for a catalog's relation types.
 *
 * @param catalog - The Stack's catalog.
 * @returns Canonical name to definition, direction and examples.
 * @throws {JevQuestionError} When the catalog is wider than one question can ask.
 */
function relationCriteria(catalog: TypeCatalog): Record<string, string> {
  assertOptionCount(catalog.relationTypes.length, "relation");
  return Object.fromEntries(catalog.relationTypes.map((def) => [def.name, describeRelationType(def)]));
}

/**
 * Renders a labelled value, naming absence instead of omitting the line.
 *
 * @param label - The field label in the state block.
 * @param value - The value, when there is one.
 * @returns `label: value` or `label: none`.
 */
function field(label: string, value: string | undefined): string {
  return `${label}: ${value ?? ABSENT}`;
}

/**
 * Frames the state block as untrusted document-derived data.
 *
 * @param lines - The labelled data lines.
 * @returns One framed block, notice first.
 */
function stateBlock(lines: readonly string[]): string {
  return delimitUntrustedDocument(lines.join("\n"));
}

/** What every classification request needs from its caller. */
interface CandidateInput {
  /** The located source quote, verbatim. */
  readonly evidenceQuote: string;
  /** The chunk the quote came from: enough context to read the quote fairly. */
  readonly context: string;
  /** The model id the caller's configuration resolved. */
  readonly model: string;
}

/** An entity awaiting classification. */
export interface EntityClassificationInput extends CandidateInput {
  /** The entity name as the extractor found it, verbatim. */
  readonly name: string;
  /** What the extractor guessed. Orientation for the reader, never a decision. */
  readonly proposedType?: string;
  readonly catalog: TypeCatalog;
}

/** A relation awaiting classification. */
export interface RelationClassificationInput extends CandidateInput {
  /** The original predicate, verbatim. Never normalized before classification. */
  readonly predicate: string;
  /** Source entity name. */
  readonly fromName: string;
  /** Target entity name. */
  readonly toName: string;
  /** The source entity's canonical type, when it has one. */
  readonly fromCanonicalType?: string;
  /** The target entity's canonical type, when it has one. */
  readonly toCanonicalType?: string;
  /** What the extractor guessed for the predicate. Orientation only. */
  readonly proposedType?: string;
  readonly catalog: TypeCatalog;
}

/** A claim whose source support must be judged. */
export interface SupportQuestionInput extends CandidateInput {
  /** The claim as the pipeline states it, built from the candidate's own fields. */
  readonly claim: string;
}

/**
 * Builds the request that classifies one entity.
 *
 * @param input - The candidate, its evidence, the catalog and the model id.
 * @returns A System One request with the entity `choice` and its companion `noul`.
 * @throws {JevQuestionError} When the catalog cannot be asked as one question.
 */
export function buildEntityClassificationRequest(input: EntityClassificationInput): JevDecisionRequest {
  return {
    model: input.model,
    state: stateBlock([
      "CANDIDATE_KIND: entity",
      `CANDIDATE_NAME: ${input.name}`,
      field("PROPOSED_TYPE_BY_EXTRACTOR", input.proposedType),
      "ORIGINAL_EVIDENCE_QUOTE:",
      input.evidenceQuote,
      "DOCUMENT_CONTEXT:",
      input.context,
    ]),
    questions: {
      [ENTITY_CLASSIFICATION_QUESTIONS.choice]: {
        type: "choice",
        instructions: ENTITY_CHOICE_INSTRUCTIONS,
        criteria: entityCriteria(input.catalog),
      },
      [ENTITY_CLASSIFICATION_QUESTIONS.fits]: {
        type: "noul",
        instructions: ENTITY_FITS_INSTRUCTIONS,
        criteria: FITS_CRITERIA,
      },
    },
  };
}

/**
 * Builds the request that classifies one relation.
 *
 * Both endpoints travel with the predicate because what a predicate means depends
 * on what hangs off each end, and a known endpoint type is evidence a classifier
 * should have.
 *
 * @param input - The candidate, its endpoints, its evidence, the catalog and the model.
 * @returns A System One request with the relation `choice` and its companion `noul`.
 * @throws {JevQuestionError} When the catalog cannot be asked as one question.
 */
export function buildRelationClassificationRequest(input: RelationClassificationInput): JevDecisionRequest {
  return {
    model: input.model,
    state: stateBlock([
      "CANDIDATE_KIND: relationship",
      `ORIGINAL_PREDICATE: ${input.predicate}`,
      `FROM_ENTITY_NAME: ${input.fromName}`,
      field("FROM_CANONICAL_TYPE", input.fromCanonicalType),
      `TO_ENTITY_NAME: ${input.toName}`,
      field("TO_CANONICAL_TYPE", input.toCanonicalType),
      field("PROPOSED_TYPE_BY_EXTRACTOR", input.proposedType),
      "ORIGINAL_EVIDENCE_QUOTE:",
      input.evidenceQuote,
      "DOCUMENT_CONTEXT:",
      input.context,
    ]),
    questions: {
      [RELATION_CLASSIFICATION_QUESTIONS.choice]: {
        type: "choice",
        instructions: RELATION_CHOICE_INSTRUCTIONS,
        criteria: relationCriteria(input.catalog),
      },
      [RELATION_CLASSIFICATION_QUESTIONS.fits]: {
        type: "noul",
        instructions: RELATION_FITS_INSTRUCTIONS,
        criteria: FITS_CRITERIA,
      },
    },
  };
}

/**
 * Builds the request that judges whether a located quote supports a claim.
 *
 * No `noul` companion here: support has no "does not apply" answer, only the two
 * directions S20 names, and a band that reports `uncertain` when neither direction
 * dominates. That keeps this decision independent of the classification decision.
 *
 * @param input - The claim, the located quote, its context and the model id.
 * @returns A System One request with one `choice` over the two support answers.
 */
export function buildSupportRequest(input: SupportQuestionInput): JevDecisionRequest {
  return {
    model: input.model,
    state: stateBlock([
      "CLAIM_UNDER_REVIEW:",
      input.claim,
      "ORIGINAL_EVIDENCE_QUOTE:",
      input.evidenceQuote,
      "DOCUMENT_CONTEXT:",
      input.context,
    ]),
    questions: {
      [SUPPORT_QUESTION_ID]: {
        type: "choice",
        instructions: SUPPORT_INSTRUCTIONS,
        criteria: {
          [SUPPORT_CHOICE_LABELS.supported]: "The quote states, or directly entails, the claim as written.",
          [SUPPORT_CHOICE_LABELS.unsupported]:
            "The quote exists but does not support the claim: it is about something else, contradicts it, or relates to it only loosely.",
        },
      },
    },
  };
}
