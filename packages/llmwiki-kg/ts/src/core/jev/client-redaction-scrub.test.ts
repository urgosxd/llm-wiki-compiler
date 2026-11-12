/**
 * @file packages/llmwiki-kg/ts/src/core/jev/client-redaction-scrub.test.ts
 * @description Proves in CI, with no credential and no socket, that `client.ts`'s
 * `scrub()` strips the vendor credential out of the text that becomes
 * `JevFailed.reason`.
 *
 * ## Why this file exists
 *
 * `JevFailed.reason` is not a log line: the pipeline PERSISTS it into
 * `kg_classification_log.reason` and into the document's audit blob. So a
 * regression that stops `scrub()` from redacting does not fail a test — it writes a
 * credential into the database, where it is discoverable only after the fact, by
 * whoever reads that table or calls that endpoint. The credential assertions in
 * `vendor-contract.test.ts` are gated on `TYPESAFE_API_KEY` and are therefore
 * SKIPPED in every CI run, which leaves exactly that regression invisible to CI.
 * This file closes the gap: a synthetic key, an injected `fetchImpl`, no environment
 * dependency, no network, no vendor spend.
 *
 * ## Both arms, and why neither alone is sufficient
 *
 * Arm A drives the REAL client and asserts the message carries no credential and no
 * `Bearer <token>` shape. That assertion is worthless on its own: a message that
 * never contained a key in the first place would satisfy it while proving nothing.
 * Arm B therefore mocks `redactSecrets` to the identity function and shows the SAME
 * two scenarios DO leak the key, which is what makes Arm A able to fail: it
 * demonstrates that with the redaction removed the credential really is present in
 * the text that would be persisted. The value layer is asserted separately, since
 * only it can catch a key that matches no header or bearer shape.
 *
 * The two arms are not interchangeable, and they do not cover the same faults: Arm A
 * catches both a broken redactor AND a redactor that is never called, while Arm B
 * catches only the first. See `clientWithoutScrub` below for the two mutation probes
 * (M1, M2) that separate them, and for why neither arm alone is sufficient.
 *
 * Arm A imports the real modules statically and Arm B loads its client through
 * `vi.doMock` + `vi.resetModules()` + a dynamic `import()`, so a mocked module can
 * never poison the real arm.
 *
 * ## Nothing guards the guard
 *
 * If this file's fixtures or Arm B were weakened, no other test in the suite would
 * notice: these assertions are the only ones that go red when redaction breaks, so
 * the guard's own coverage is itself unguarded. That is inherent to a mutation-style
 * proof rather than an oversight, and it is worth stating plainly rather than
 * papering over with a redundant file.
 *
 * ## What the dummy-key diagnostic established (observed)
 *
 * These four facts come from a request made with a dummy credential, not from a
 * specification; they are recorded here because they are the reason the assertions
 * below are shaped the way they are.
 *
 * 1. `api.typesafe.ai/v1/systemone` exists and answers. The request reached the
 *    vendor and was refused there, so the endpoint and path are live.
 * 2. Authentication is validated BEFORE body grammar. A dummy credential can never
 *    validate a payload, so no dummy-key run can tell a well-formed request from a
 *    malformed one — only a real key can.
 * 3. The vendor's error envelope is structured:
 *    `{"detail":{"error_type":"authentication_error","message":"..."}}`. Our client
 *    surfaces that body as TEXT and parses none of it, so our code cannot distinguish
 *    `authentication_error` from any other 401. That is a field the vendor hands us
 *    and we discard — the same shape of loss as `usage`.
 * 4. A 401 is refused after ONE attempt, which is correct: 401 is permanent, so a
 *    retry could only spend the budget to reproduce it.
 *
 * NO VENDOR SUCCESS PATH HAS BEEN OBSERVED. Nothing here claims one, and nothing here
 * needs one: the credential handling is exercised through the injected transport.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

import { createJevHttpClient } from "./client.js";
import type { JevFetch } from "./client.js";
import type { JevDecisionClient, JevDecisionRequest } from "./types.js";

/**
 * A key that belongs to no account.
 *
 * It is deliberately shaped so that NO layer other than the by-value one can redact
 * it: it is not a `Bearer` token, and it appears in no `name: value` position. That
 * makes the value-layer assertion below specific instead of incidental.
 */
const SYNTHETIC_KEY = "synthetic-probe-key-0123456789";

/** The smallest legal request: one state, one question. */
const REQUEST: JevDecisionRequest = {
  model: "jev-latest",
  state: "the candidate block under classification",
  questions: {
    answerable: {
      type: "noul",
      instructions: "Does this block fit the stack?",
      criteria: { true: "it fits", false: "it does not fit" },
    },
  },
};

/** Transport and timing shared by both arms; the port is closed by construction. */
const OFFLINE = {
  baseUrl: "http://127.0.0.1:1",
  timeoutMs: 5_000,
  sleep: async (): Promise<void> => undefined,
} as const;

/** Why: a transport error that quotes the request headers it failed to send. */
const bearerFailure: JevFetch = () =>
  Promise.reject(new Error(`socket hang up with authorization: Bearer ${SYNTHETIC_KEY}`));

/** A 401 in the vendor's real envelope shape, quoting the refused credential. */
const unauthorizedBody: JevFetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        detail: { error_type: "authentication_error", message: `invalid credential ${SYNTHETIC_KEY}` },
      }),
      { status: 401 },
    ),
  );

/** The message a caller would persist into `kg_classification_log.reason`. */
async function persistedReason(client: JevDecisionClient): Promise<string> {
  try {
    await client.decide(REQUEST);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "DID_NOT_THROW";
}

/**
 * A second, independently evaluated `client.js` whose `redactSecrets` is identity.
 *
 * Mocking the module rather than editing `client.ts` keeps the production file
 * untouched. It does NOT reproduce "deleting `scrub()`": neutralising
 * `redactSecrets` and removing the `scrub()` call are two distinct mutations, and
 * this arm covers only the first. Two probes separate them, and both are reproducible
 * by hand against a scratch copy of the repository:
 *
 * - **M1 — `redactSecrets` made identity.** Arm A goes red (its two leak assertions
 *   fail) and Arm B stays green, because Arm B *is* that mutation. The separate
 *   value-layer test also goes red, since it exercises the real function.
 * - **M2 — the `scrub()` call deleted from both error paths of `client.ts`** (the
 *   401-body path and the transport-failure path). Arm A goes red for both cases:
 *   the raw message still carries the credential verbatim, so a real redactor that is
 *   never invoked cannot remove it. Arm B stays GREEN under M2 — its client loses the
 *   call too, but its `redactSecrets` is already identity, so its expectation of a
 *   leak is satisfied either way.
 *
 * So the arms cover different faults. Arm A catches BOTH M1 and M2; Arm B catches
 * ONLY broken redaction logic (M1). Arm B's mutation is additionally broader than
 * that single fault, because neutralising the module also disables the URL and
 * header-value redaction performed inside `redactRequestDescriptor` — and this base
 * URL (`http://127.0.0.1:1`) carries no credential for any assertion here to observe
 * that loss.
 *
 * Together the pair excludes both mutations; neither arm alone is sufficient. Arm A
 * alone would stay green if it were asserting on a message that never held a
 * credential, and Arm B alone would stay green with `scrub()` deleted from
 * production.
 *
 * @param fetchImpl - The transport to inject.
 * @returns A client with redaction neutralised.
 */
async function clientWithoutScrub(fetchImpl: JevFetch): Promise<JevDecisionClient> {
  vi.resetModules();
  vi.doMock("./redact.js", async () => {
    const actual = await vi.importActual<typeof import("./redact.js")>("./redact.js");
    return { ...actual, redactSecrets: (text: string): string => text };
  });
  const { createJevHttpClient: unmockedScrub } = await import("./client.js");
  return unmockedScrub({ ...OFFLINE, apiKey: SYNTHETIC_KEY, fetchImpl });
}

describe("Arm A — the real client never reports the credential", () => {
  it("scrubs a credential quoted by a transport failure", async () => {
    const reason = await persistedReason(createJevHttpClient({ ...OFFLINE, apiKey: SYNTHETIC_KEY, fetchImpl: bearerFailure }));
    expect(reason).not.toBe("");
    expect(reason.includes(SYNTHETIC_KEY)).toBe(false);
    expect(reason).not.toMatch(/bearer\s+\S+/i);
  });

  it("scrubs a credential quoted by a 401 body", async () => {
    const reason = await persistedReason(
      createJevHttpClient({ ...OFFLINE, apiKey: SYNTHETIC_KEY, fetchImpl: unauthorizedBody }),
    );
    expect(reason).not.toBe("");
    expect(reason.includes(SYNTHETIC_KEY)).toBe(false);
    expect(reason).not.toMatch(/bearer\s+\S+/i);
  });
});

describe("Arm B — with redaction neutralised, the same text does leak it", () => {
  afterAll(() => {
    vi.doUnmock("./redact.js");
    vi.resetModules();
  });

  it("leaks the credential quoted by a transport failure", async () => {
    const reason = await persistedReason(await clientWithoutScrub(bearerFailure));
    expect(reason.includes(SYNTHETIC_KEY)).toBe(true);
    expect(reason).toMatch(/bearer\s+\S+/i);
  });

  it("leaks the credential quoted by a 401 body", async () => {
    const reason = await persistedReason(await clientWithoutScrub(unauthorizedBody));
    expect(reason.includes(SYNTHETIC_KEY)).toBe(true);
  });
});

describe("the value layer is what removes a key no shape matches", () => {
  it("leaks the key without the secret listed and redacts it with the secret listed", async () => {
    const real = await vi.importActual<typeof import("./redact.js")>("./redact.js");
    const body = JSON.stringify({ detail: { error_type: "authentication_error", message: `bad ${SYNTHETIC_KEY}` } });
    expect(real.redactSecrets(body, []).includes(SYNTHETIC_KEY)).toBe(true);
    expect(real.redactSecrets(body, [SYNTHETIC_KEY]).includes(SYNTHETIC_KEY)).toBe(false);
  });
});
