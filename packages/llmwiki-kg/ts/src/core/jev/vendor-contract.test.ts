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
 * They are SPEC-DERIVED AND NOT YET OBSERVED. No vendor ANSWER has ever reached this
 * file: every execution so far failed before a response body was parsed — a request made
 * with a dummy credential did reach `api.typesafe.ai` and was refused there, which is
 * evidence that the endpoint answers and no evidence at all about anything below. The
 * first run with a configured key is the moment we learn whether these invariants were
 * right, and a failure there is a vendor divergence to report, not a defect to paper over
 * here. No assertion pins an answer, a label or a probability: the model is not
 * deterministic, so each one asserts only a property every correct response must have.
 *
 * The concrete `model` id is OBSERVED PER RUN, NOT ASSERTED. A keyed run logs the id the
 * vendor answered with, the `usage` object it carried and the sum of the probability
 * values, because `jev-latest` is an alias that MOVES and the code persists whatever id
 * the response echoes. That is also the structural limit to keep in mind: the assertions
 * here are property-based, and a property-only check cannot detect the alias moving to a
 * new version — only a recorded id, compared across runs, can.
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
 * `hasApiKey` and the two `message.includes(key)` booleans in the credential tests. Those
 * tests inject a `fetchImpl`, so they cannot ask the vendor at all: the credential is
 * quoted into the synthetic text the injected transport hands back, which is the only way
 * to observe whether the client's own redaction removes it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { asRecord } from "../llm/json.js";
import { createJevHttpClient } from "./client.js";
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from "./config.js";
import type {
  JevAnswer,
  JevChoiceAnswer,
  JevDecisionClient,
  JevDecisionRequest,
  JevDecisionResponse,
  JevNoulAnswer,
} from "./types.js";

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

/**
 * The budget for the credential tests, which open no socket at all.
 *
 * Their transport is injected, so the only work left is the client's own retry
 * bookkeeping. A verdict that takes longer than this means something reached the
 * network, which is the one thing these tests must never do.
 */
const OFFLINE_TEST_TIMEOUT_MS = 5_000;

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
 * The credential as a value, for the tests that must inject it.
 *
 * The suite gate above already skipped this file when the variable is absent, so
 * reaching the throw means the gate and the fixture disagreed — a failure worth seeing,
 * never a silently empty needle that would match everywhere.
 *
 * @returns The credential configured for this run.
 */
function liveCredential(): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error("TYPESAFE_API_KEY is absent, so the credential tests must have been skipped");
  }
  return apiKey;
}

/**
 * The message a client failed with, or a named failure when it did not fail.
 *
 * A resolved call is reported by name rather than as a passing test: a failure path
 * that never fires would let every credential assertion below pass without observing
 * anything.
 *
 * @param client - The client under test.
 * @returns The message it threw.
 */
async function thrownMessage(client: JevDecisionClient): Promise<string> {
  try {
    await client.decide(REQUEST);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    "the client resolved, so the failure path is UNPROVEN: " +
      "a resolved failure is a credential leak waiting for the next vendor error body",
  );
}

/**
 * Registers the two credential invariants, which need no vendor at all.
 *
 * They replace a real `fetch` against a closed local port, whose genuine error text is
 * `… request failed: fetch failed` and never quotes the credential: an assertion that
 * such a message excludes the key cannot fail, so it proved nothing about `redact.ts`.
 * Here the credential is quoted INTO the synthetic failure, and each test first asserts
 * that its own fixture carries it — that fixture assertion is what makes the assertion
 * about the client's message able to fail. `fetchImpl` and `sleep` are both injected, so
 * no socket is opened and the vendor is not billed.
 *
 * @returns Nothing; the tests are registered as a side effect.
 */
function registerCredentialRedaction(): void {
  it("removes the credential a transport failure quotes back", async () => {
    const key = liveCredential();
    const syntheticText = `connect ECONNREFUSED 127.0.0.1:1 with authorization: Bearer ${key}`;
    // Self-proving: if this fixture stopped carrying the key, the assertions below
    // would be vacuous, so that condition is a failure here instead.
    expect(syntheticText.includes(key)).toBe(true);
    const failTransport = (): Promise<Response> => Promise.reject(new Error(syntheticText));
    const client = createJevHttpClient({
      baseUrl: UNREACHABLE_BASE_URL,
      apiKey: key,
      timeoutMs: REQUEST_TIMEOUT_MS,
      sleep: async () => undefined,
      fetchImpl: failTransport,
    });
    const message = await thrownMessage(client);
    expect(message.length).toBeGreaterThan(0);
    expect(message.includes(key)).toBe(false);
    expect(/bearer\s+\S+/i.test(message)).toBe(false);
  }, OFFLINE_TEST_TIMEOUT_MS);

  it("removes the credential a refused request quotes in its body", async () => {
    const key = liveCredential();
    const syntheticBody = JSON.stringify({ error: `bad key ${key}` });
    // Self-proving: the same fixture assertion as above, for the body path.
    expect(syntheticBody.includes(key)).toBe(true);
    const refuseWithBody = (): Promise<Response> => Promise.resolve(new Response(syntheticBody, { status: 401 }));
    const client = createJevHttpClient({
      baseUrl: UNREACHABLE_BASE_URL,
      apiKey: key,
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl: refuseWithBody,
    });
    const message = await thrownMessage(client);
    expect(message).toContain("401");
    expect(message.includes(key)).toBe(false);
  }, OFFLINE_TEST_TIMEOUT_MS);
}

/**
 * Registers the live half: one request first, then the invariants it feeds.
 *
 * The `beforeAll` lives inside this nested suite and nowhere above it, so a `-t`
 * selection of the credential tests leaves it unrun: a run that asks nothing of the
 * vendor must make no request at all, not a skipped request.
 *
 * @returns Nothing; the hook and the two invariant groups are registered as a side effect.
 */
function registerLiveResponseSuite(): void {
  beforeAll(async () => {
    const client = createJevHttpClient({
      baseUrl: DEFAULT_JEV_BASE_URL,
      apiKey: apiKey ?? "",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    // ONE call, through the real client's public method. The scripted double is
    // deliberately not used: it is the thing this file exists to check against.
    response = await client.decide(REQUEST);
    // The record a keyed run leaves behind, and the only place the concrete vendor id
    // becomes visible: observed here, asserted nowhere. Read defensively so a malformed
    // answer costs its own invariant test rather than this report.
    const observed = response.answers[CHOICE_QUESTION_ID];
    const probabilitySum =
      observed?.type === "choice"
        ? Object.values(observed.probabilities).reduce((sum, probability) => sum + probability, 0)
        : Number.NaN;
    console.log(
      `[jev-vendor-contract] model=${response.model} usage=${JSON.stringify(response.usage)} probabilitySum=${probabilitySum}`,
    );
  }, NETWORK_TEST_TIMEOUT_MS);

  describe("the choice answer of that one live response", registerChoiceInvariants);
  describe("the envelope of that same live response", registerEnvelopeInvariants);
}

/**
 * Registers the whole key-gated suite, as two nested suites that share no hook.
 *
 * The split is what makes the credential half selectable on its own: a `beforeAll` at
 * this level would ask the vendor for a test that needs nothing from it, and the two
 * halves must be able to report independently.
 *
 * @returns Nothing; the suites are registered as a side effect.
 */
function registerVendorContractCheck(): void {
  describe("the one live response", registerLiveResponseSuite);
  describe("the failure path never reports the credential", registerCredentialRedaction);
}

describe.skipIf(!hasApiKey)(SUITE_TITLE, registerVendorContractCheck);
