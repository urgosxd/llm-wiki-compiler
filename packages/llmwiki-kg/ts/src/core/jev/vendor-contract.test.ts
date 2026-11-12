/**
 * @file packages/llmwiki-kg/ts/src/core/jev/vendor-contract.test.ts
 * @description The one test in this repository that asks the REAL TypeSafe AI
 * System One vendor (`https://api.typesafe.ai`) a question.
 *
 * ## Why this file exists beside nine suites that already cover the adapter
 *
 * Every other `*.test.ts` in this directory drives the adapter through the scripted
 * double in `doubles.ts`, which replays payloads written from the same `types.ts` the
 * adapter validates them with. That proves this code agrees with this repository's
 * copy of the contract, and it cannot notice the moment the contract itself moves at
 * `api.typesafe.ai`, because both sides of that comparison live here. This file is
 * the only one that closes the gap, so it is also the only test here that reaches the
 * network and can spend money. It is deliberately tiny: ONE request carrying both
 * answer shapes, no loop, and the client's own retry policy as the only retry.
 *
 * ## How it behaves without a credential
 *
 * With no `TYPESAFE_API_KEY` the whole suite is SKIPPED, loudly and twice over: the
 * `describe` title states the consequence, and a module-scope warning repeats it. A
 * run that never asked the vendor must read as UNVERIFIED, never as passed. CI has no
 * such key on purpose, so a CI report says SKIPPED — see `AGENTS.md`.
 *
 * ## What these assertions are, and are not
 *
 * They are SPEC-DERIVED AND NOT YET OBSERVED. Nothing in this file has been executed
 * against the vendor; the first run with a configured key is the moment we learn
 * whether these invariants were right, and a failure there is a vendor divergence to
 * report, not a defect to paper over here. No assertion pins an answer, a label or a
 * probability: the model is not deterministic, so each one asserts only a property
 * every correct response must have.
 *
 * There is no System One RESPONSE specification inside this checkout to derive them
 * from. `models.md`, `api/system-one.md` and `primitives-choice.md` are not present,
 * and `docs/configuration/kg-classification.mdx` documents the request body only. The
 * invariants below therefore come from the parent brief for this file and are
 * unverified against any in-repo spec text — which is precisely why a run without a
 * key is reported as unverified rather than as a pass.
 *
 * ## The credential never leaves this file
 *
 * The key is read as presence-or-absence only. Nothing here prints it, logs it, copies
 * it, measures a prefix of it or asserts on its format or length; the only reads are
 * the boolean `hasApiKey` and the boolean `message.includes(key)` in the failure-path
 * test, and the failure-path client cannot ask the vendor at all.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { asRecord } from "../llm/json.js";
import { createJevHttpClient } from "./client.js";
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from "./config.js";
import type { JevAnswer, JevChoiceAnswer, JevDecisionRequest, JevDecisionResponse, JevNoulAnswer } from "./types.js";

/** The credential. Only its absence or presence is ever read; see the file header. */
const apiKey = process.env["TYPESAFE_API_KEY"];
const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;

/** The sentence that must appear in every report of a run that skipped. */
const SKIP_REASON = "SKIPPED: TYPESAFE_API_KEY absent — the vendor contract is UNVERIFIED in this run";

if (!hasApiKey) {
  // Loud on purpose. A skip that only shows up as a grey dot in a verbose report is
  // read as a pass by everyone who only counts failures.
  console.warn(`[jev-vendor-contract] ${SKIP_REASON}`);
}

/**
 * The suite title, which must not claim a skip it did not make.
 *
 * Both arms are explicit: the skipping arm states the variable and the consequence,
 * and the running arm still says the invariants are unobserved here, because
 * executing this file locally does not by itself confirm them for anybody else.
 */
const SUITE_TITLE = hasApiKey
  ? "real TypeSafe System One vendor contract (TYPESAFE_API_KEY present — invariants remain SPEC-DERIVED)"
  : `real TypeSafe System One vendor contract (${SKIP_REASON})`;

/** The per-request timeout handed to the client: one decision is quick or it is an outage. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The budget for anything that waits on a socket.
 *
 * The client's own retry policy spends up to three attempts of {@link REQUEST_TIMEOUT_MS}
 * plus two backoff waits of a few hundred milliseconds, so anything under three and a
 * half minutes would abort the test before the policy could report its own verdict.
 */
const NETWORK_TEST_TIMEOUT_MS = 210_000;

/** A port nothing listens on: the transport fails deterministically and costs the vendor nothing. */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

/** Id of the `choice` question, echoed back as a key of `answers`. */
const CHOICE_QUESTION_ID = "contract-colour-choice";

/** Id of the `noul` companion, echoed back as a key of `answers`. */
const NOUL_QUESTION_ID = "contract-colour-fits";

/**
 * The smallest request the documented grammar carries.
 *
 * One `state`, one `choice` over two options, and its `noul` companion, which is the
 * shape `questions.ts` builds: the vendor answers every question of one request in one
 * response, so a single call covers both answer variants and the happy path stays at
 * one request.
 */
const REQUEST: JevDecisionRequest = {
  model: DEFAULT_JEV_MODEL,
  state: [
    "The line below is the only observation the questions are about.",
    "The maintenance runbook is printed on blue paper and is reviewed every Tuesday.",
  ].join("\n"),
  questions: {
    [CHOICE_QUESTION_ID]: {
      type: "choice",
      instructions:
        "Which colour does the observation in the state mention? Pick the single best option, and pick only an option that is listed.",
      criteria: {
        blue: "The observation mentions the colour blue.",
        red: "The observation mentions the colour red.",
      },
    },
    [NOUL_QUESTION_ID]: {
      type: "noul",
      instructions: "Does the observation in the state mention any colour at all?",
      criteria: {
        true: "The observation names a colour.",
        false: "The observation names no colour.",
      },
    },
  },
};

/**
 * How far `sum(probabilities)` may sit from 1.
 *
 * A distribution normalized in the vendor's own arithmetic reaches us as shortest
 * round-trip JSON decimals, and summing a handful of doubles accumulates on the order
 * of one unit in the last place per term: ~1e-16 to 1e-15 for a two-option question.
 * This tolerance is set nine orders above that rounding floor on purpose. It still
 * rejects a distribution that was never normalized — logits, percentages, or a dropped
 * option — which is the failure worth catching, while not pretending a JSON body can
 * carry an exact decimal `1`. A bare `toBeCloseTo` default would pin a precision nobody
 * here reasoned about, so the number is named and used explicitly.
 */
const PROBABILITY_SUM_TOLERANCE = 1e-6;

/** The response one answered request produced, shared by the invariant tests below. */
let response: JevDecisionResponse;

/**
 * The answer to one question, or a named failure when the vendor skipped it.
 *
 * @param questionId - The question id this file asked.
 * @returns The answer the response carried for it.
 */
function answerFor(questionId: string): JevAnswer {
  const answer = response.answers[questionId];
  if (answer === undefined) {
    throw new Error(`the vendor returned no answer for question ${questionId}`);
  }
  return answer;
}

/**
 * The `choice` answer, or a named failure when the other variant came back.
 *
 * @returns The `choice` answer.
 */
function choiceAnswer(): JevChoiceAnswer {
  const answer = answerFor(CHOICE_QUESTION_ID);
  if (answer.type !== "choice") throw new Error(`${CHOICE_QUESTION_ID} came back as ${answer.type}`);
  return answer;
}

/**
 * The `noul` answer, or a named failure when the other variant came back.
 *
 * @returns The `noul` answer.
 */
function noulAnswer(): JevNoulAnswer {
  const answer = answerFor(NOUL_QUESTION_ID);
  if (answer.type !== "noul") throw new Error(`${NOUL_QUESTION_ID} came back as ${answer.type}`);
  return answer;
}

/**
 * Registers the two invariants that read the live `choice` answer.
 *
 * A registered function rather than an inline arrow because the house lint counts the
 * whole body of a callback, nested tests included, against a 40-line limit.
 *
 * @returns Nothing; the tests are registered as a side effect.
 */
function registerChoiceInvariants(): void {
  it("names the option its own distribution gives the highest probability", () => {
    const answer = choiceAnswer();
    const probabilities = Object.values(answer.probabilities);
    expect(probabilities.length).toBeGreaterThan(1);
    // Compared as VALUES, never as an index: a tie between two options is a correct
    // answer, and an index comparison would flake on one while asserting nothing more.
    // This is the dependency that matters most — `interpret.ts` labels
    // `probabilities[choice]` as `jev_top_probability` and gates on it.
    const maximum = Math.max(...probabilities);
    expect(answer.probabilities[answer.choice]).toBe(maximum);
  });

  it("sends probabilities that sum to 1 within the stated tolerance", () => {
    const answer = choiceAnswer();
    const total = Object.values(answer.probabilities).reduce((sum, probability) => sum + probability, 0);
    expect(Math.abs(total - 1)).toBeLessThanOrEqual(PROBABILITY_SUM_TOLERANCE);
  });
}

/**
 * Registers the invariants that read the response envelope around the answers.
 *
 * @returns Nothing; the tests are registered as a side effect.
 */
function registerEnvelopeInvariants(): void {
  it("reports integer token counts inside a present `usage` object", () => {
    // `types.ts` declares `usage?: unknown`: the shape is vendor-owned, this adapter
    // discards it, and `payload.ts` surfaces it verbatim when one arrives. The spec
    // marks both counts required, which is exactly what a discarded field cannot
    // report — so presence is asserted first, then the counts, after one narrowing.
    const usage = asRecord(response.usage);
    expect(usage).toBeDefined();
    expect(Number.isInteger(usage?.["input_tokens"])).toBe(true);
    expect(Number.isInteger(usage?.["output_tokens"])).toBe(true);
  });

  it("echoes a non-empty model id that is not the alias the request sent", () => {
    // No documented versioned-id SHAPE exists in this checkout — `models.md`,
    // `api/system-one.md` and `primitives-choice.md` are absent, and
    // `docs/configuration/kg-classification.mdx` documents the request body only — so
    // no regex is invented here. What the aliasing itself requires is asserted: the
    // alias moves under us, so an echoed alias would make a stored decision
    // unattributable after the fact.
    expect(typeof response.model).toBe("string");
    expect(response.model.length).toBeGreaterThan(0);
    expect(response.model).not.toBe(REQUEST.model);
  });

  it("answers `noul` with a probability inside [0, 1]", () => {
    const answer = noulAnswer();
    expect(typeof answer.noul).toBe("number");
    expect(answer.noul).toBeGreaterThanOrEqual(0);
    expect(answer.noul).toBeLessThanOrEqual(1);
  });
}

/**
 * Registers the failure-path invariant, which needs no vendor at all.
 *
 * @returns Nothing; the test is registered as a side effect.
 */
function registerFailurePathInvariant(): void {
  it("fails without a message that could carry the credential", async () => {
    const key = apiKey ?? "";
    // The base-URL override is the mechanism: `createJevHttpClient` takes `baseUrl`
    // (`client.ts`) and appends the documented `JEV_SYSTEM_ONE_PATH`, so a closed local
    // port fails deterministically at zero vendor cost, without relying on the vendor
    // rejecting anything. `sleep` replaces only the retry TIMER; the client's own
    // policy still decides how many attempts a transport failure gets.
    const unreachable = createJevHttpClient({
      baseUrl: UNREACHABLE_BASE_URL,
      apiKey: key,
      timeoutMs: REQUEST_TIMEOUT_MS,
      sleep: async () => undefined,
    });
    let message: string | undefined;
    try {
      await unreachable.decide(REQUEST);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (message === undefined) {
      throw new Error(
        `the transport to ${UNREACHABLE_BASE_URL} did NOT throw, so the failure path is UNPROVEN: ` +
          "a refusal that resolves is a credential leak waiting for the next vendor error body",
      );
    }
    // Both reported paths run their text through `scrub()` — the non-2xx body at
    // `client.ts:151` and the transport failure at `client.ts:191` — and `scrub` is
    // `redactSecrets(text, [transport.apiKey])` (`client.ts`), the helper `redact.ts`
    // documents as the one place a credential is stripped from anything this package is
    // about to report, store or return. Only booleans are asserted: no value, no prefix.
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes(key)).toBe(false);
    expect(/bearer\s+\S+/i.test(message)).toBe(false);
  }, NETWORK_TEST_TIMEOUT_MS);
}

/**
 * Registers the whole suite: one live request first, then the invariants it feeds.
 *
 * The `beforeAll` lives here so it runs ONLY when the gate above let the suite in: a
 * run without a credential must make no request at all, not a skipped request.
 *
 * @returns Nothing; the hook and the three groups are registered as a side effect.
 */
function registerVendorContractCheck(): void {
  beforeAll(async () => {
    const client = createJevHttpClient({
      baseUrl: DEFAULT_JEV_BASE_URL,
      apiKey: apiKey ?? "",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    // ONE call, through the real client's public method. The scripted double is
    // deliberately not used: it is the thing this file exists to check against.
    response = await client.decide(REQUEST);
  }, NETWORK_TEST_TIMEOUT_MS);

  describe("the choice answer of that one live response", registerChoiceInvariants);
  describe("the envelope of that same live response", registerEnvelopeInvariants);
  describe("the failure path", registerFailurePathInvariant);
}

describe.skipIf(!hasApiKey)(SUITE_TITLE, registerVendorContractCheck);
