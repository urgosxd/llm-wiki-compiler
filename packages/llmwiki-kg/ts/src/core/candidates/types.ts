/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/types.ts
 * @description The open candidate model: what an extractor proposes, before anything classifies it.
 *
 * ## A candidate is a proposal, not a decision
 *
 * Nothing here is a canonical type, a stored row, or a verdict. A candidate is a
 * name the model found in a chunk plus whatever it proposed about that name, kept
 * with the provenance needed to check it later. Classification is a later stage
 * with its own vocabulary, so this module deliberately has no notion of a match, a
 * free entity, or a failure: those are answers to a question asked elsewhere.
 *
 * ## The proposal fields are FREE STRINGS, and that is the whole design
 *
 * `proposedType` and `predicate` are `string`, never an enum, a catalog id, or a
 * union of declared names. A catalog type can be rendered into a prompt as
 * orientation (see `contract.ts`), but a candidate whose proposal fits nothing must
 * survive parsing with its own wording intact — that is what keeps "deja sin
 * efecto" from being rewritten as `related_to` before any classifier could see it
 * (S31) and what lets a later stage decide that the wording names a canonical
 * relation after all (S33).
 *
 * ## Entities without relations are first class (S8)
 *
 * `CandidateSet` has two independent arrays. A chunk that yields only entities is
 * an ordinary result, not a degenerate one: `relations` is simply empty. There is
 * no placeholder edge, no synthetic self-relation, and no "dangling" flag to be
 * filtered out later, because a dummy edge would be indistinguishable from an
 * asserted fact to every stage downstream.
 */

import type { CandidateKind } from "../../schema-open-classification.js";

export type { CandidateKind };

/**
 * Where one candidate came from.
 *
 * `chunkId` is `null` when the chunk is not persisted yet; the character offsets
 * the evidence stage records are always into the chunk CONTENT, so the index plus
 * the document identify the text unambiguously even before an id exists.
 */
export interface CandidateSource {
  /** `stack_documents` id of the document the chunk belongs to. */
  readonly documentId: string;
  /** `document_chunks` id, or `null` while the chunk is only in memory. */
  readonly chunkId: string | null;
  /** Position of the chunk inside its document. */
  readonly chunkIndex: number;
}

/** One property the extractor attached to an entity, kept as it was written. */
export interface CandidateProperty {
  readonly name: string;
  readonly value: string;
}

/** Fields every candidate carries, whatever its kind. */
interface CandidateBase {
  /** Run-scoped identifier (`kind:documentId:chunkIndex:ordinal`), so a decision can name its candidate. */
  readonly ref: string;
  /** The document and chunk this candidate was read from. */
  readonly source: CandidateSource;
}

/** An entity the extractor proposed, with the type it proposed for it. */
export interface EntityCandidate extends CandidateBase {
  readonly kind: "entity";
  /** The name as the source spelled it, trimmed and otherwise untouched. */
  readonly name: string;
  /**
   * The type the model proposed, verbatim, or `null` when it proposed none.
   *
   * Never a default, never the reserved unclassified label, never a catalog entry
   * chosen here: an entity with no proposal is reported as having no proposal, and
   * classification decides what that means.
   */
  readonly proposedType: string | null;
  /** What the model said about the entity, or `null` when it said nothing. */
  readonly description: string | null;
  /** Properties the model attached; empty when it attached none. */
  readonly properties: readonly CandidateProperty[];
}

/** A relation the extractor proposed, with the predicate it read from the text. */
export interface RelationCandidate extends CandidateBase {
  readonly kind: "relationship";
  /** Name of the subject, matching a declared entity candidate. */
  readonly fromName: string;
  /** Name of the object, matching a declared entity candidate. */
  readonly toName: string;
  /**
   * The original predicate, verbatim.
   *
   * Required and never defaulted: a relation whose predicate the model did not
   * state is rejected rather than given a generic verb, because the verb is the
   * only part of the assertion a later classifier can normalize.
   */
  readonly predicate: string;
  /** What the model said about the relation, or `null` when it said nothing. */
  readonly description: string | null;
}

/** Any candidate an extraction pass produced. */
export type KnowledgeCandidate = EntityCandidate | RelationCandidate;

/**
 * Why a piece of the model's answer was refused.
 *
 * Every one of these is a fact the pipeline reports, never a repair it performs:
 * a rejected candidate leaves no entity, no edge, and no substituted value behind.
 */
export type CandidateRejectionReason =
  | "missing_name"
  | "missing_endpoint"
  | "missing_predicate"
  | "undeclared_endpoint";

/** One refused piece of a model answer, with what it contained. */
export interface CandidateRejection {
  /** Whether the refused item was an entity or a relation. */
  readonly candidateKind: CandidateKind;
  /** What was wrong with it. */
  readonly reason: CandidateRejectionReason;
  /**
   * The values that caused the rejection, as received.
   *
   * For `undeclared_endpoint` these are exactly the endpoints that no entity
   * candidate declared, which is what lets a report name them without parsing
   * prose.
   */
  readonly offending: readonly string[];
  /** Where the refused item came from. */
  readonly source: CandidateSource;
}

/**
 * Everything one chunk's answer produced.
 *
 * The three arrays are independent, so an entity-only chunk (S8) is representable
 * without inventing anything: `entities` is populated, `relations` is empty, and
 * `rejections` says whether anything was refused along the way.
 *
 * Nothing in this type or in any doc comment here promises that a set is complete.
 * A partial answer is the normal outcome of extraction over real documents (S9).
 */
export interface CandidateSet {
  /** The document and chunk this set was parsed from. */
  readonly source: CandidateSource;
  readonly entities: readonly EntityCandidate[];
  readonly relations: readonly RelationCandidate[];
  /** Items the parser refused, each with its reason and provenance. */
  readonly rejections: readonly CandidateRejection[];
}
