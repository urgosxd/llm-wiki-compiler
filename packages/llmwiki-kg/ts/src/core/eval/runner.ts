/**
 * @file packages/llmwiki-kg/ts/src/core/eval/runner.ts
 * @description One evaluation run: drive the real stages with an injected decision
 * client, join what they produced to the labels, and hand it to the scorer.
 *
 * ## Why this reuses the production stages instead of calling JEV itself
 *
 * The measurement is only worth something if it measures the code that runs. This
 * runner therefore calls {@link classifyCandidates} — the same entry point the ingest
 * pipeline calls — so the request builders, the payload validation, the interpretation
 * rules and the decision mapping are all the real ones. The support question goes
 * through the same public adapter boundary for the same reason.
 *
 * ## What the client decides
 *
 * Everything about the network lives behind the injected {@link JevDecisionClient}:
 * the offline runner passes the recorded double, the real runner passes the HTTP
 * adapter. This module cannot tell them apart, which is what makes "the same scorer
 * runs in CI and against the vendor" true rather than aspirational.
 *
 * ## What it must never do
 *
 * It never reads a label to build a request. A claim comes from the example's recorded
 * claim, and the candidate from its recorded candidate: what a human labeled is
 * joined only after the decisions exist, so a label cannot influence a verdict.
 */

import type { CandidateDecision } from "../classify/types.js";
import { classifyCandidates } from "../classify/batch.js";
import type { EntityCandidate, KnowledgeCandidate, RelationCandidate } from "../candidates/types.js";
import type { TypeCatalog } from "../catalog/types.js";
import { requestDecision } from "../jev/client.js";
import type { JevConfig } from "../jev/config.js";
import { interpretSupport } from "../jev/interpret.js";
import { buildSupportRequest } from "../jev/questions.js";
import type { JevDecisionClient, SupportVerdict } from "../jev/types.js";
import { scoreEvalSet } from "./scorer.js";
import type { CandidateEvidence } from "../classify/types.js";
import type { EvalReport, EvalSet, LabeledExample, ObservedDecision, RunInfo } from "./types.js";

/** Everything one evaluation run needs. */
export interface EvalRunInput {
  readonly set: EvalSet;
  readonly catalog: TypeCatalog;
  readonly client: JevDecisionClient;
  readonly config: JevConfig;
  readonly run: RunInfo;
}

/** What one run produced: the report plus the raw decisions behind it. */
export interface EvalRun {
  readonly report: EvalReport;
  /** Every decision the classifier produced, in stage order. */
  readonly decisions: readonly CandidateDecision[];
  /** The support verdict per example id, absent when none was produced. */
  readonly supports: ReadonlyMap<string, SupportVerdict>;
}

/**
 * Turns one extracted example into the candidate the extraction stage would emit.
 *
 * The ref is the example id, so a decision can be joined back to its labels without
 * a second identifier. Provenance is synthetic because the set is synthetic: the
 * document is the set itself, and no chunk is persisted.
 *
 * @param example - An example the extractor produced a candidate for.
 * @param chunkIndex - Position in the set, used as the chunk index.
 * @returns The open candidate.
 * @throws {Error} When the example is marked extracted but carries no candidate.
 */
function candidateOf(example: LabeledExample, chunkIndex: number): KnowledgeCandidate {
  const source = { documentId: "eval-set", chunkId: null, chunkIndex };
  const base = { ref: example.id, source };
  if (example.kind === "entity") {
    if (example.candidate === undefined) throw new Error(`example ${example.id} carries no entity candidate`);
    const entity: EntityCandidate = {
      ...base,
      kind: "entity",
      name: example.candidate.name,
      proposedType: example.candidate.proposedType,
      description: null,
      properties: [],
    };
    return entity;
  }
  if (example.candidate === undefined) throw new Error(`example ${example.id} carries no relation candidate`);
  const relation: RelationCandidate = {
    ...base,
    kind: "relationship",
    fromName: example.candidate.from,
    toName: example.candidate.to,
    predicate: example.candidate.predicate,
    description: null,
  };
  return relation;
}

/**
 * Builds the candidates and the located evidence of one run.
 *
 * @param set - The labeled set.
 * @returns The candidates in set order, and the evidence keyed by candidate ref.
 */
function prepareRun(set: EvalSet): {
  candidates: KnowledgeCandidate[];
  evidence: Record<string, CandidateEvidence>;
} {
  const candidates: KnowledgeCandidate[] = [];
  const evidence: Record<string, CandidateEvidence> = {};
  set.examples.forEach((example, index) => {
    if (!example.extracted) return;
    candidates.push(candidateOf(example, index));
    evidence[example.id] = { quote: example.quote, context: example.source };
  });
  return { candidates, evidence };
}

/**
 * Asks the support question for one extracted example.
 *
 * The claim is the example's recorded claim: it is the assertion the pipeline asks
 * about, so the evaluation never restates a claim differently from the one a human
 * labeled.
 *
 * @param client - The decision client.
 * @param example - The example whose quote and claim are judged.
 * @param config - Endpoint model and the configured support band.
 * @returns The support verdict.
 */
async function supportVerdictOf(
  client: JevDecisionClient,
  example: LabeledExample,
  config: JevConfig,
): Promise<SupportVerdict> {
  const request = buildSupportRequest({
    claim: example.claim,
    evidenceQuote: example.quote,
    context: example.source,
    model: config.model,
  });
  return interpretSupport(await requestDecision(client, request), config.thresholds);
}

/**
 * Runs one evaluation and returns both the report and the decisions it came from.
 *
 * @param input - The set, catalog, client, configuration and run information.
 * @returns The report with the raw decisions behind it.
 * @throws {ClassificationInputError} When a candidate has no located quote.
 */
export async function runEvalSet(input: EvalRunInput): Promise<EvalRun> {
  const { candidates, evidence } = prepareRun(input.set);
  const batch = await classifyCandidates({
    candidates,
    catalog: input.catalog,
    client: input.client,
    config: input.config,
    evidence,
  });
  const decisionByRef = new Map(batch.decisions.map((decision) => [decision.ref, decision] as const));
  const supports = new Map<string, SupportVerdict>();
  for (const example of input.set.examples) {
    if (!example.extracted) continue;
    supports.set(example.id, await supportVerdictOf(input.client, example, input.config));
  }
  const observed: ObservedDecision[] = input.set.examples.map((example) => ({
    exampleId: example.id,
    decision: decisionByRef.get(example.id) ?? null,
    support: supports.get(example.id) ?? null,
  }));
  const report = scoreEvalSet({
    set: input.set,
    observed,
    run: input.run,
    catalogVersion: batch.catalogVersion,
  });
  return { report, decisions: batch.decisions, supports };
}
