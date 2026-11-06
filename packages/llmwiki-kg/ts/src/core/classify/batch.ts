/**
 * @file packages/llmwiki-kg/ts/src/core/classify/batch.ts
 * @description The classification stage's one entry point: a batch in, decisions out, no I/O.
 *
 * ## What this function is responsible for, in order
 *
 * 1. Refuse a batch whose candidates do not all have a located quote, BEFORE any
 *    provider call. A candidate classified without its evidence would be an
 *    unevaluated fact wearing a decision (S19, S25), and failing fast means a
 *    misconfigured run costs no JEV requests at all.
 * 2. Classify entities in candidate order.
 * 3. Derive the endpoint types the batch actually resolved.
 * 4. Classify relations in candidate order, and check each one's compatibility.
 *
 * Entity decisions never gate relation decisions, and relation decisions never feed
 * back into entity decisions: the two loops read the candidate list and return, so a
 * free node cannot force its relations free and a classified node cannot force its
 * relations classified (S32). The endpoint types handed to JEV are orientation and
 * the input to the compatibility check — never a verdict.
 *
 * ## Failure is data here, and nothing else is
 *
 * `requestDecision` already converts provider conditions into an outcome instead of
 * throwing, and this stage turns that outcome into `pending` or `failed` without
 * dropping the candidate. Nothing in the loop is wrapped in a `try`: a programming
 * error must stay visible as an exception rather than be laundered into a stored
 * operational state, and the only errors that reach the caller are the ones that
 * mean the input was unusable.
 *
 * ## No database, no transaction, no clock
 *
 * The stage reads its inputs and returns values. Persisting them — in bounded
 * transactions, never held open across a provider call — belongs to the pipeline
 * (T10) and to reclassification (T13).
 */

import type { EntityCandidate, RelationCandidate } from "../candidates/types.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, RELATION_CLASSIFICATION_QUESTIONS } from "../jev/questions.js";
import { requestDecision } from "../jev/client.js";
import { interpretClassification } from "../jev/interpret.js";
import { assessRelationCompatibility } from "./compatibility.js";
import { buildEntityDecision, buildRelationDecision, canonicalTypeOf } from "./decision.js";
import { canonicalTypeOfEndpoint, endpointCanonicalTypes } from "./endpoint-types.js";
import { entityClassificationRequest, relationClassificationRequest } from "./requests.js";
import { ClassificationInputError } from "./types.js";
import type {
  CandidateEvidence,
  ClassificationBatch,
  ClassifyCandidatesInput,
  EntityClassificationDecision,
  RelationClassificationDecision,
  SupportState,
} from "./types.js";

/** One entity candidate bound to the evidence it must be classified against. */
interface PreparedEntity {
  readonly candidate: EntityCandidate;
  readonly evidence: CandidateEvidence;
}

/** One relation candidate bound to its evidence. */
interface PreparedRelation {
  readonly candidate: RelationCandidate;
  readonly evidence: CandidateEvidence;
}

/** A batch split by kind, with every evidence quote already resolved. */
interface PreparedCandidates {
  readonly entities: readonly PreparedEntity[];
  readonly relations: readonly PreparedRelation[];
}

/**
 * Binds every candidate to its evidence, refusing the batch when one is missing.
 *
 * The refusal names every candidate without a quote, so a wiring bug is fixed in one
 * pass instead of one rerun per candidate.
 *
 * @param candidates - Every candidate of the run.
 * @param evidence - Located quote and context, keyed by candidate ref.
 * @returns The candidates split by kind, each with its evidence.
 * @throws {ClassificationInputError} When any candidate has no evidence entry.
 */
function prepareCandidates(
  candidates: ClassifyCandidatesInput["candidates"],
  evidence: ClassifyCandidatesInput["evidence"],
): PreparedCandidates {
  const entities: PreparedEntity[] = [];
  const relations: PreparedRelation[] = [];
  const missing: string[] = [];
  for (const candidate of candidates) {
    const located = evidence[candidate.ref];
    if (located === undefined) {
      missing.push(candidate.ref);
    } else if (candidate.kind === "entity") {
      entities.push({ candidate, evidence: located });
    } else {
      relations.push({ candidate, evidence: located });
    }
  }
  if (missing.length > 0) {
    throw new ClassificationInputError(
      `no located evidence quote was supplied for ${missing.join(", ")}; a candidate is never classified without its source quote`,
    );
  }
  return { entities, relations };
}

/**
 * Reads the caller's support judgement for one candidate.
 *
 * @param input - The batch input, which may carry no judgements at all.
 * @param ref - The candidate ref.
 * @returns The judgement, or `null` when none was recorded.
 */
function supportStateFor(input: ClassifyCandidatesInput, ref: string): SupportState | null {
  return input.supportStates?.[ref] ?? null;
}

/**
 * Classifies every prepared entity candidate, in order.
 *
 * @param entities - The entity candidates with their evidence.
 * @param input - The batch input, for the client, catalog and configuration.
 * @returns One decision per candidate, in candidate order.
 */
async function classifyEntities(
  entities: readonly PreparedEntity[],
  input: ClassifyCandidatesInput,
): Promise<readonly EntityClassificationDecision[]> {
  const interpretation = {
    catalog: input.catalog,
    thresholds: input.config.thresholds,
    questions: ENTITY_CLASSIFICATION_QUESTIONS,
  };
  const decisions: EntityClassificationDecision[] = [];
  for (const { candidate, evidence } of entities) {
    const request = entityClassificationRequest(candidate, evidence, input.catalog, input.config.model);
    const verdict = interpretClassification(await requestDecision(input.client, request), interpretation);
    const context = { supportState: supportStateFor(input, candidate.ref), catalogVersion: input.catalog.version };
    decisions.push(buildEntityDecision(candidate, verdict, context));
  }
  return decisions;
}

/**
 * Classifies every prepared relation candidate, in order.
 *
 * @param relations - The relation candidates with their evidence.
 * @param input - The batch input, for the client, catalog and configuration.
 * @param endpointTypes - Canonical types the entity pass resolved, by folded name.
 * @returns One decision per candidate, in candidate order, each with its compatibility.
 */
async function classifyRelations(
  relations: readonly PreparedRelation[],
  input: ClassifyCandidatesInput,
  endpointTypes: ReadonlyMap<string, string>,
): Promise<readonly RelationClassificationDecision[]> {
  const interpretation = {
    catalog: input.catalog,
    thresholds: input.config.thresholds,
    questions: RELATION_CLASSIFICATION_QUESTIONS,
  };
  const typeOf = (name: string): string | null => canonicalTypeOfEndpoint(endpointTypes, name);
  const decisions: RelationClassificationDecision[] = [];
  for (const { candidate, evidence } of relations) {
    const request = relationClassificationRequest(candidate, evidence, input.catalog, input.config.model, typeOf);
    const verdict = interpretClassification(await requestDecision(input.client, request), interpretation);
    const context = {
      supportState: supportStateFor(input, candidate.ref),
      catalogVersion: input.catalog.version,
      compatibility: assessRelationCompatibility({
        catalog: input.catalog,
        canonicalRelationType: canonicalTypeOf(verdict),
        fromCanonicalType: typeOf(candidate.fromName),
        toCanonicalType: typeOf(candidate.toName),
      }),
    };
    decisions.push(buildRelationDecision(candidate, verdict, context));
  }
  return decisions;
}

/**
 * Classifies one batch of open candidates: entities first, then relations.
 *
 * @param input - Candidates, catalog, decision client, configuration and evidence.
 * @returns One decision per candidate, with the catalog version they were made under.
 * @throws {ClassificationInputError} When a candidate has no located evidence quote.
 */
export async function classifyCandidates(input: ClassifyCandidatesInput): Promise<ClassificationBatch> {
  const prepared = prepareCandidates(input.candidates, input.evidence);
  const entityDecisions = await classifyEntities(prepared.entities, input);
  const endpointTypes = endpointCanonicalTypes(entityDecisions);
  const relationDecisions = await classifyRelations(prepared.relations, input, endpointTypes);
  return {
    catalogVersion: input.catalog.version,
    entityDecisions,
    relationDecisions,
    decisions: [...entityDecisions, ...relationDecisions],
  };
}
