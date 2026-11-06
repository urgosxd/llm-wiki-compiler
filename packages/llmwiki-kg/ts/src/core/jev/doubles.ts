/**
 * @file packages/llmwiki-kg/ts/src/core/jev/doubles.ts
 * @description The scripted in-memory decision client every automated test runs on,
 * and the builders that make a plausible vendor payload short to write.
 *
 * ## Why the double implements the interface rather than mocking `fetch`
 *
 * S18 asks for a substitutable adapter and S46 for doubles in every automated
 * test. A scripted client at the interface boundary exercises the real
 * interpretation path — validation, bands, verdict construction — while replacing
 * only the thing that would otherwise be a network call and a credential. Mocking
 * `fetch` instead would keep the HTTP adapter in the loop, so a suite would be
 * testing its own stub of the transport rather than the decision logic.
 *
 * ## The scripted payload is wire data, deliberately untyped
 *
 * A step may carry an `Error`, which stands in for a provider condition, or a
 * response built by {@link vendorResponse}. Payloads are not re-validated here:
 * `requestDecision` validates whatever a client returns, so the double and the
 * real adapter are checked by the same code and a test can prove that an unusable
 * payload becomes an operational failure rather than an abstention.
 */

import type { JevAnswer, JevChoiceAnswer, JevDecisionClient, JevDecisionRequest, JevDecisionResponse, JevNoulAnswer } from "./types.js";

/**
 * One scripted step: the payload to return, or the error to raise.
 *
 * An `Error` is thrown as-is, so a test can script exactly the condition it cares
 * about — a `JevProviderError` for a provider failure, for instance.
 */
export type JevScriptStep = JevDecisionResponse | Error;

/**
 * A decision client that replays a fixed script and records what it was asked.
 *
 * The script is replayed in order, one step per call. Running out of steps is a
 * test bug and is reported as such, never as a provider failure, because silently
 * repeating the last answer would hide a suite that asks more questions than it
 * scripted.
 */
export class ScriptedJevClient implements JevDecisionClient {
  private readonly steps: readonly JevScriptStep[];
  private cursor = 0;

  /** Every request this client received, in call order, for assertions. */
  readonly requests: JevDecisionRequest[] = [];

  /**
   * @param steps - The payloads and errors to replay, oldest first.
   */
  constructor(steps: readonly JevScriptStep[]) {
    this.steps = steps;
  }

  /**
   * Records the request and replays the next scripted step.
   *
   * @param request - The state and questions to decide.
   * @returns The scripted payload.
   * @throws The scripted error, or an error when the script is exhausted.
   */
  decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    this.requests.push(request);
    const step = this.steps[this.cursor];
    this.cursor += 1;
    if (step === undefined) {
      return Promise.reject(new Error(`no scripted Jev step for request #${String(this.cursor)}`));
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  }
}

/**
 * Builds a `choice` answer exactly as the vendor documents it.
 *
 * `confidence` is passed in rather than derived: it is the vendor's own dispersion
 * measure, and a double that invented a formula would let a test pass against a
 * number no real response contains.
 *
 * @param choice - The argmax label.
 * @param probabilities - The full distribution, verbatim.
 * @param confidence - The vendor `confidence` value to carry.
 * @returns The scripted answer.
 */
export function choiceAnswer(
  choice: string,
  probabilities: Readonly<Record<string, number>>,
  confidence: number,
): JevChoiceAnswer {
  return { type: "choice", choice, probabilities, confidence };
}

/**
 * Builds a `noul` answer: one probability, and no `confidence`.
 *
 * @param probabilityTrue - Probability of the `true` criterion.
 * @returns The scripted answer.
 */
export function noulAnswer(probabilityTrue: number): JevNoulAnswer {
  return { type: "noul", noul: probabilityTrue };
}

/**
 * Wraps answers in a documented response envelope.
 *
 * @param answers - Question id to answer.
 * @param model - The model id the response should echo.
 * @returns The scripted response.
 */
export function vendorResponse(
  answers: Readonly<Record<string, JevAnswer>>,
  model = "jev-test",
): JevDecisionResponse {
  return { model, answers };
}

/**
 * Creates a scripted client from a step list.
 *
 * @param steps - The payloads and errors to replay, oldest first.
 * @returns The double, ready to be passed to `requestDecision`.
 */
export function scriptedJevClient(steps: readonly JevScriptStep[]): ScriptedJevClient {
  return new ScriptedJevClient(steps);
}
