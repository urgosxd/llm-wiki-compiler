/**
 * @file packages/llmwiki-kg/ts/src/core/classify/requests.ts
 * @description Turning one candidate plus its evidence into the request JEV is asked.
 *
 * ## Thin on purpose
 *
 * Every field of both requests is already owned by `core/jev/questions.ts`, which is
 * where S19's four inputs and the companion abstain question were implemented and
 * tested. This module does not rebuild any of that: it copies a candidate's own
 * fields into that builder's input, so there is one definition of what a
 * classification request looks like and a change there cannot leave a second,
 * drifted copy here.
 *
 * ## What is passed, and what is deliberately not
 *
 * The endpoint types of a relation travel as ORIENTATION when the caller already
 * knows them (the batch resolved them from the entity decisions of the same run). A
 * known endpoint type is real evidence for a classifier reading a verb, and passing
 * it is not the same as gating on it: the verdict still comes from the client, which
 * is what keeps a free node from forcing its relations free (S32).
 */

import type { EntityCandidate, RelationCandidate } from "../candidates/types.js";
import type { TypeCatalog } from "../catalog/types.js";
import { buildEntityClassificationRequest, buildRelationClassificationRequest } from "../jev/questions.js";
import type { CandidateEvidence } from "./types.js";

/**
 * Renders an optional builder field, omitting it entirely when absent.
 *
 * `exactOptionalPropertyTypes` distinguishes "this key is absent" from "this key is
 * `undefined`", and the request builders rely on absence to render `none` in the
 * state block, so an absent value must not be materialized as a key.
 *
 * @param key - The builder field name.
 * @param value - The value, or `null` when there is none.
 * @returns A one-key object, or an empty object.
 */
function optionalField<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

/**
 * Builds the request that classifies one entity candidate.
 *
 * @param candidate - The entity candidate, with the type label the extractor proposed.
 * @param evidence - The quote and chunk already located for this candidate.
 * @param catalog - The Stack's catalog, sent as the `choice` criteria.
 * @param model - The configured JEV model id.
 * @returns The System One request for this entity.
 */
export function entityClassificationRequest(
  candidate: EntityCandidate,
  evidence: CandidateEvidence,
  catalog: TypeCatalog,
  model: string,
): ReturnType<typeof buildEntityClassificationRequest> {
  return buildEntityClassificationRequest({
    catalog,
    model,
    evidenceQuote: evidence.quote,
    context: evidence.context,
    name: candidate.name,
    ...optionalField("proposedType", candidate.proposedType),
  });
}

/**
 * Builds the request that classifies one relation candidate.
 *
 * @param candidate - The relation candidate, with its original predicate.
 * @param evidence - The quote and chunk already located for this candidate.
 * @param catalog - The Stack's catalog, sent as the `choice` criteria.
 * @param model - The configured JEV model id.
 * @param endpointTypes - Canonical type per folded endpoint name, when already known.
 * @returns The System One request for this relation.
 */
export function relationClassificationRequest(
  candidate: RelationCandidate,
  evidence: CandidateEvidence,
  catalog: TypeCatalog,
  model: string,
  endpointTypes: (name: string) => string | null,
): ReturnType<typeof buildRelationClassificationRequest> {
  return buildRelationClassificationRequest({
    catalog,
    model,
    evidenceQuote: evidence.quote,
    context: evidence.context,
    predicate: candidate.predicate,
    fromName: candidate.fromName,
    toName: candidate.toName,
    ...optionalField("fromCanonicalType", endpointTypes(candidate.fromName)),
    ...optionalField("toCanonicalType", endpointTypes(candidate.toName)),
  });
}
