/**
 * @file packages/llmwiki-kg/ts/src/core/jev/doubles.test.ts
 * @description The in-memory double every other suite runs on, and the proof that
 * the default suite is offline.
 *
 * WHY THIS FILE EXISTS. S46 requires doubles for automated tests and real calls to
 * be an explicit evaluation only. A convention is not a proof, so the last test
 * here stubs `globalThis.fetch` with a counter and drives a whole classification
 * through the double: if any path reached the vendor, the counter would move and
 * the assertion would fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { requestDecision } from "./client.js";
import { DEFAULT_JEV_THRESHOLDS } from "./config.js";
import { ScriptedJevClient, choiceAnswer, noulAnswer, vendorResponse } from "./doubles.js";
import { interpretClassification } from "./interpret.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, buildEntityClassificationRequest } from "./questions.js";
import { JevProviderError } from "./types.js";
import type { JevDecisionRequest } from "./types.js";

const REQUEST: JevDecisionRequest = {
  model: "jev-test",
  state: "candidate block",
  questions: {
    answerable: { type: "noul", instructions: "Does it fit?", criteria: { true: "yes", false: "no" } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScriptedJevClient", () => {
  it("replays the script in order and records every request it received", async () => {
    const first = vendorResponse({ answerable: noulAnswer(0.9) });
    const client = new ScriptedJevClient([first, vendorResponse({ answerable: noulAnswer(0.1) })]);
    await requestDecision(client, REQUEST);
    await requestDecision(client, REQUEST);
    expect(client.requests).toEqual([REQUEST, REQUEST]);
  });

  it("surfaces a scripted provider failure as an operational failure", async () => {
    const client = new ScriptedJevClient([
      new JevProviderError("provider_failed", "socket hang up", "https://jev.test/v1/systemone"),
    ]);
    const outcome = await requestDecision(client, REQUEST);
    expect(outcome.status).toBe("provider_failure");
    expect(outcome.status === "provider_failure" ? outcome.state : undefined).toBe("pending");
  });

  it("keeps the probabilities a script gives it, verbatim", () => {
    const answer = choiceAnswer("Role", { Role: 0.72, Process: 0.28 }, 0.55);
    expect(answer).toEqual({
      type: "choice",
      choice: "Role",
      probabilities: { Role: 0.72, Process: 0.28 },
      confidence: 0.55,
    });
    expect("confidence" in noulAnswer(0.8)).toBe(false);
  });
});

describe("the default suite is offline", () => {
  it("classifies end to end through the double without a single fetch", async () => {
    let networkCalls = 0;
    vi.stubGlobal("fetch", async () => {
      networkCalls += 1;
      throw new Error("an automated test tried to reach the network");
    });
    const client = new ScriptedJevClient([
      vendorResponse({
        [ENTITY_CLASSIFICATION_QUESTIONS.choice]: choiceAnswer("Role", { Role: 0.88, Process: 0.12 }, 0.76),
        [ENTITY_CLASSIFICATION_QUESTIONS.fits]: noulAnswer(0.93),
      }),
    ]);
    const request = buildEntityClassificationRequest({
      name: "Responsable de Seguridad",
      evidenceQuote: "El Responsable de Seguridad revisa el runbook.",
      context: "El Responsable de Seguridad revisa el runbook antes del despliegue.",
      catalog: defaultTypeCatalog(),
      model: "jev-test",
    });
    const verdict = interpretClassification(await requestDecision(client, request), {
      catalog: defaultTypeCatalog(),
      thresholds: DEFAULT_JEV_THRESHOLDS,
      questions: ENTITY_CLASSIFICATION_QUESTIONS,
    });
    expect(networkCalls).toBe(0);
    expect(verdict.status).toBe("classified");
  });
});
