/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/classify-stage.ts
 * @description Stages 4-6 of the ingest pipeline: classify entities, classify
 * relations, then validate what the decisions claim about themselves.
 *
 * ## ONE place builds the decision client
 *
 * `classificationRuntime` is the only construction site for the JEV client in this
 * package. Everything that needs a classifier — the pipeline today, a
 * reclassification pass tomorrow — asks this function, so the endpoint, the model
 * and the four thresholds cannot be read two different ways.
 *
 * ## Unconfigured is a supported state, and it is not a failure
 *
 * No `TYPESAFE_API_KEY` (or entirely blank) means classification is NOT configured,
 * and the pipeline must still succeed: every candidate is persisted with the
 * operational state `pending`, which the schema defines as "the classifier has not
 * answered yet". It is deliberately not `free_no_match` — an unattempted decision is
 * not an abstention (S25) — and nothing is dropped.
 *
 * A MALFORMED configuration is a different thing and raises: a threshold outside
 * (0, 1) or an inverted pair would move a whole corpus's abstention rate with
 * nothing in the log to explain it, so it fails loudly instead of quietly
 * classifying nothing (S24).
 *
 * ## Stages 4 and 5 are one batch, and they never gate each other
 *
 * `classifyCandidates` (T7-T9) classifies entities and then relations over the same
 * candidate list, so a free node cannot force its relations free and a classified
 * node cannot force its relations classified (S32). This module adds stage 6: the
 * invariants a decision must satisfy before anything is written, checked HERE so no
 * database constraint is ever the thing that catches a bug.
 *
 * ## No database handle appears anywhere below
 *
 * `ClassifyCandidatesInput` carries no connection, and neither does this module.
 * That is what lets the pipeline run stages 4-6 with no transaction open (S44).
 */

import { defaultTypeCatalog } from "../../core/catalog/default_catalog.js";
import { parseTypeCatalog } from "../../core/catalog/parse.js";
import type { TypeCatalog } from "../../core/catalog/types.js";
import { classifyCandidates } from "../../core/classify/batch.js";
import type {
  CandidateDecision,
  ClassificationBatch,
  EntityClassificationDecision,
  RelationClassificationDecision,
} from "../../core/classify/types.js";
import { createJevHttpClientFromEnv } from "../../core/jev/client.js";
import { parseJevConfig, type JevConfig, type JevEnv } from "../../core/jev/config.js";
import type { JevDecisionClient } from "../../core/jev/types.js";
import type { ClassificationStateCounts } from "./audit.js";
import { candidateEvidence, type CandidateSpan } from "./candidates.js";
import { assessSupport, supportStatesOf } from "./support-stage.js";
import type { SupportJudgements } from "./support-stage.js";

/**
 * Our label for the classifier stage that produced a decision.
 *
 * Stored on every row and every log entry beside `catalog_version`, so a
 * reclassification run (S43) can find the decisions a change to this stage
 * invalidated. It names the question set and interpreter pair, not the vendor
 * model: the model id is stored separately and can change without this.
 */
export const CLASSIFIER_VERSION = "jev-classification/1";

/** The decision client plus the configuration that produced it. */
export interface ClassificationRuntime {
  /** The substitutable adapter: the real HTTP client in production, a double in tests. */
  readonly client: JevDecisionClient;
  /** Endpoint, model id and the four confidence bands. */
  readonly config: JevConfig;
}

/**
 * Builds the classifier from configuration, or reports that none is configured.
 *
 * @param env - The environment to read; defaults to `process.env`.
 * @returns The runtime, or `undefined` when no credential is configured.
 * @throws {JevConfigError} When a configured value is unparseable or inconsistent.
 */
export function classificationRuntime(env: JevEnv = process.env): ClassificationRuntime | undefined {
  const apiKey = env["TYPESAFE_API_KEY"]?.trim() ?? "";
  if (apiKey === "") return undefined;
  return {
    client: createJevHttpClientFromEnv(env),
    // Parsed through the same function the client used, so the thresholds the
    // decisions were made with are the thresholds the caller can read back.
    config: parseJevConfig(env),
  };
}

/**
 * The vocabulary the classifier is asked against.
 *
 * The Stack's own versioned catalog when it has one, otherwise the documented
 * default. A stored catalog that does not parse raises: it is the vocabulary every
 * later classification is measured against, so silently substituting the default
 * would attribute decisions to a catalog nobody configured.
 *
 * @param stored - The raw `stacks.type_catalog` value.
 * @returns The validated, immutable catalog.
 * @throws {TypeCatalogError} When a stored catalog is present but invalid.
 */
export function classificationCatalog(stored: unknown): TypeCatalog {
  if (stored === null || stored === undefined) return defaultTypeCatalog();
  return parseTypeCatalog(stored);
}

/** Raised when a decision claims something the storage layer forbids. */
export class DecisionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionInvariantError";
  }
}

/**
 * Refuses a decision whose fields contradict each other.
 *
 * The one rule that matters is the pair the database also enforces
 * (`canonical_type_requires_classified`): a canonical type exists if and only if
 * the state is `classified`. Checking it here means a bug surfaces as a readable
 * error naming the candidate, not as a constraint violation deep inside a write
 * transaction — and nothing in this pipeline relies on the database to catch it.
 *
 * @param decision - One decision, of either kind.
 * @throws {DecisionInvariantError} When the state and the canonical type disagree.
 */
export function assertDecisionInvariant(decision: CandidateDecision): void {
  const classified = decision.classificationState === "classified";
  if (classified && decision.canonicalType === null) {
    throw new DecisionInvariantError(`${decision.ref} is classified with no canonical type`);
  }
  if (!classified && decision.canonicalType !== null) {
    throw new DecisionInvariantError(
      `${decision.ref} carries canonical type ${decision.canonicalType} in state ` +
        `${decision.classificationState}; "free" means no catalog type could be assigned`,
    );
  }
}

/**
 * Stage 6: validates every decision in a batch before anything is persisted.
 *
 * @param batch - What stages 4 and 5 produced.
 * @throws {DecisionInvariantError} When any decision contradicts itself.
 */
export function validateDecisions(batch: ClassificationBatch): void {
  for (const decision of batch.decisions) {
    assertDecisionInvariant(decision);
  }
}

/** What stages 4-6 need to run. */
export interface ClassifySpansInput {
  /** Stage 2's spans, entities first then relations. */
  readonly spans: readonly CandidateSpan[];
  /** The catalog the classifier is asked against. */
  readonly catalog: TypeCatalog;
  /** The decision client and its configuration. */
  readonly runtime: ClassificationRuntime;
}

/** Stage 6's output: the validated batch plus the per-kind lists a writer needs. */
export interface ClassificationOutcome {
  readonly entityDecisions: readonly EntityClassificationDecision[];
  readonly relationDecisions: readonly RelationClassificationDecision[];
  readonly catalogVersion: string;
  /** The semantic judgements stage 2b obtained, keyed by candidate ref. */
  readonly support: SupportJudgements;
}

/**
 * Runs stages 2b, 4, 5 and 6 over one document's candidates, with no transaction open.
 *
 * The support questions are asked FIRST and in full, before the first classification
 * question. That order is deliberate rather than incidental: support is a judgement
 * about the SOURCE, so it must not be able to move when the classification answer
 * does, and running the whole pass first makes the two request sequences independent
 * of one another (S12, S32).
 *
 * @param input - Spans, catalog and runtime.
 * @returns One validated decision per candidate, split by kind, plus the support pass.
 * @throws {DecisionInvariantError} When a decision contradicts itself.
 * @throws {ClassificationInputError} When a candidate has no located evidence.
 */
export async function classifySpans(input: ClassifySpansInput): Promise<ClassificationOutcome> {
  const support = await assessSupport({ spans: input.spans, runtime: input.runtime });
  const batch = await classifyCandidates({
    candidates: input.spans.map((span) => span.candidate),
    catalog: input.catalog,
    client: input.runtime.client,
    config: input.runtime.config,
    evidence: candidateEvidence(input.spans),
    supportStates: supportStatesOf(support),
  });
  validateDecisions(batch);
  return {
    entityDecisions: batch.entityDecisions,
    relationDecisions: batch.relationDecisions,
    catalogVersion: batch.catalogVersion,
    support,
  };
}

/**
 * How many decisions landed in each state, for the audit blob.
 *
 * The five keys are the schema's closed set, all optional, and absent keys are not
 * written — the same absent-when-empty rule the other sections follow, so a run of
 * twenty classified entities does not spell out four zeros.
 *
 * @param outcome - What stages 4-6 produced.
 * @returns Counts by state.
 */
export function stateCounts(outcome: ClassificationOutcome): ClassificationStateCounts {
  const counts: ClassificationStateCounts = {};
  for (const decision of [...outcome.entityDecisions, ...outcome.relationDecisions]) {
    const state = decision.classificationState;
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}
