/**
 * @file packages/llmwiki-kg/ts/src/core/classify/index.ts
 * @description Public surface of the classification stage.
 *
 * One stage, one entry point: {@link classifyCandidates} takes a batch of open
 * candidates, the Stack's catalog, a {@link JevDecisionClient} and the configuration,
 * and returns one decision per candidate. Around it live the pieces a caller or a
 * test may need on its own — the decision vocabulary (`types.ts`), the verdict
 * mapping (`decision.ts`), the relation identity key (`identity.ts`), and the
 * endpoint compatibility check (`compatibility.ts`).
 *
 * Nothing here reads a database, opens a transaction, or writes a row, and nothing
 * here sets human verification: persisting these decisions, and keeping `verified`
 * a human-review fact, belong to the pipeline (T10) and the AKS projection (T11).
 */

export * from "./types.js";
export { classifyCandidates } from "./batch.js";
export { buildEntityDecision, buildRelationDecision, canonicalTypeOf, classificationStateOf } from "./decision.js";
export { relationIdentityKey } from "./identity.js";
export { assessRelationCompatibility } from "./compatibility.js";
export type { CompatibilityInput } from "./compatibility.js";
export { canonicalTypeOfEndpoint, endpointCanonicalTypes } from "./endpoint-types.js";
export { entityClassificationRequest, relationClassificationRequest } from "./requests.js";
