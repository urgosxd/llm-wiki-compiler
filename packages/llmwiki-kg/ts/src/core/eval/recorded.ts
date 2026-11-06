/**
 * @file packages/llmwiki-kg/ts/src/core/eval/recorded.ts
 * @description The recorded double: the answers one illustrative run produced,
 * replayed through the real adapter path with no network and no credential.
 *
 * ## What this is not
 *
 * These answers are NOT ground truth and they are not kept in sync with the labels.
 * They are a snapshot committed so the offline runner exercises the whole path —
 * request builders, payload validation, interpretation, decision mapping, scoring —
 * instead of a hand-built decision per example. If the snapshot happens to contain a
 * wrong classification, a false support verdict and a provider failure, that is the
 * point: an evaluation whose recorded run is perfect measures nothing.
 *
 * ## Why the order is fixed, and why it is documented here
 *
 * A scripted client replays steps in call order, so this module must emit them in
 * exactly the order the runner asks. The pipeline classifies all entities before all
 * relations (the relation pass needs the resolved endpoint types), then asks the
 * support question for each candidate in set order. Emitting with the same ordering
 * rule means adding an example to the JSON needs no change here.
 *
 * ## Failures are steps too
 *
 * A recorded `{"failure": "provider_failed"}` becomes a {@link JevProviderError}, the
 * same error the HTTP adapter raises for a transport problem. `requestDecision`
 * therefore turns it into an operational outcome exactly as it would in production,
 * which is how the offline run can measure information loss through the real path.
 */

import {
  ScriptedJevClient,
  choiceAnswer,
  noulAnswer,
  vendorResponse,
} from "../jev/doubles.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, RELATION_CLASSIFICATION_QUESTIONS, SUPPORT_QUESTION_ID } from "../jev/questions.js";
import { JevProviderError } from "../jev/types.js";
import type { JevScriptStep } from "../jev/doubles.js";
import type { ClassificationQuestionSet } from "../jev/types.js";
import type { EvalSet, LabeledExample, RecordedAnswers } from "./types.js";

/** The model id echoed by recorded answers, so a report cannot claim a real model. */
export const RECORDED_MODEL = "jev-recorded";

/** The endpoint the recorded failure names, so the message cannot look like a real URL. */
const RECORDED_ENDPOINT = "recorded://eval-set";

/**
 * Reads the recorded answers of an example, refusing a missing block loudly.
 *
 * @param example - One labeled example the extractor produced a candidate for.
 * @returns The recorded answers.
 * @throws {Error} When the example carries no recorded answers.
 */
function answersOf(example: LabeledExample): RecordedAnswers {
  if (example.recorded === undefined) {
    throw new Error(`example ${example.id} is marked extracted but carries no recorded answers`);
  }
  return example.recorded;
}

/**
 * Builds the scripted step for one classification request.
 *
 * @param example - The example whose candidate is being classified.
 * @param questions - The question set of the example's namespace.
 * @returns The step: a vendor-shaped response, or the provider error to raise.
 */
function classificationStep(example: LabeledExample, questions: ClassificationQuestionSet): JevScriptStep {
  const recorded = answersOf(example).classification;
  if ("failure" in recorded) {
    return new JevProviderError(
      "provider_failed",
      `${RECORDED_ENDPOINT} recorded a provider failure for example ${example.id}`,
      RECORDED_ENDPOINT,
    );
  }
  return vendorResponse(
    {
      [questions.choice]: choiceAnswer(recorded.choice, recorded.probabilities, recorded.confidence),
      [questions.fits]: noulAnswer(recorded.fits),
    },
    RECORDED_MODEL,
  );
}

/**
 * Builds the scripted step for one support request.
 *
 * @param example - The example whose claim is being judged.
 * @returns The step, or `undefined` when the example recorded no support answer.
 */
function supportStep(example: LabeledExample): JevScriptStep | undefined {
  const support = answersOf(example).support;
  if (support === undefined) return undefined;
  return vendorResponse(
    { [SUPPORT_QUESTION_ID]: choiceAnswer(support.choice, support.probabilities, support.confidence) },
    RECORDED_MODEL,
  );
}

/**
 * Emits the steps in the order the runner asks, skipping examples with no candidate.
 *
 * @param examples - The labeled set's examples.
 * @param kind - Which classification namespace to emit.
 * @param questions - The question set for that namespace.
 * @returns One step per classification request.
 */
function classificationSteps(
  examples: readonly LabeledExample[],
  kind: LabeledExample["kind"],
  questions: ClassificationQuestionSet,
): JevScriptStep[] {
  return examples.filter((example) => example.extracted && example.kind === kind).map((example) => classificationStep(example, questions));
}

/**
 * Emits one support step per extracted example, in set order.
 *
 * @param examples - The labeled set's examples.
 * @returns One step per support request.
 */
function supportSteps(examples: readonly LabeledExample[]): JevScriptStep[] {
  const steps: JevScriptStep[] = [];
  for (const example of examples) {
    if (!example.extracted) continue;
    const step = supportStep(example);
    if (step !== undefined) steps.push(step);
  }
  return steps;
}

/**
 * Builds the scripted client that replays the set's recorded answers.
 *
 * @param set - The labeled set.
 * @returns A client ready to be passed to the classification and support stages.
 */
export function recordedDoubleFor(set: EvalSet): ScriptedJevClient {
  const steps = [
    ...classificationSteps(set.examples, "entity", ENTITY_CLASSIFICATION_QUESTIONS),
    ...classificationSteps(set.examples, "relation", RELATION_CLASSIFICATION_QUESTIONS),
    ...supportSteps(set.examples),
  ];
  return new ScriptedJevClient(steps);
}

