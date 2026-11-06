/**
 * @file packages/llmwiki-kg/ts/src/core/jev/redaction.test.ts
 * @description The credential never reaches a message, a stack, a stored reason or
 * a response body.
 *
 * WHY THIS FILE EXISTS. `TYPESAFE_API_KEY` is a billable credential, and the code
 * that spends it builds messages out of three things it does not control: the
 * vendor's error body, the transport's exception text, and the configured base URL.
 * A vendor that echoes the refused `Authorization` value, a proxy that quotes the
 * request it failed to forward, or an operator who pasted the key into the URL all
 * end up in the same place — `JevFailed.reason`, which the pipeline PERSISTS in
 * `kg_classification_log.reason` and on the row's own classification reason. A leak
 * there is not a log line; it is a stored, returned secret.
 *
 * The sentinel below is deliberately unmistakable. A leak cannot pass by
 * coincidence, and a test that redacted the wrong string would still fail.
 *
 * The second leak this file pins is the one a helper that only knew about headers
 * could not close: credentials INSIDE the configured base URL — `user:pass@` and
 * `?token=` — which travelled with the endpoint into the audit blob and the eval
 * report. Those are redacted by shape, so the caller needs no secret to compare.
 *
 * NO NETWORK, NO CREDENTIAL. Every client is built with an injected `fetchImpl`;
 * the eval command, which builds its own client, runs against a stubbed `fetch`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runEvalCli } from "../eval/main.js";
import type { EvalSet } from "../eval/types.js";
import { TRANSIENT_ATTEMPTS } from "../llm/retry.js";
import { buildClassificationAudit } from "../../routes/ingest/audit.js";
import type { ClassificationRuntime } from "../../routes/ingest/classify-stage.js";
import { createJevHttpClient, createJevHttpClientFromEnv, requestDecision } from "./client.js";
import type { JevFetch } from "./client.js";
import { JevConfigError, parseJevConfig } from "./config.js";
import { REDACTED, redactRequestDescriptor, redactSecrets, reportedBaseUrl } from "./redact.js";
import type { JevDecisionRequest } from "./types.js";

/** A value that cannot appear in a message unless it leaked from the credential. */
const SENTINEL = "sk-THE-SECRET-SENTINEL";

/** An inline password and token that are NOT the API key, so only their SHAPE can scrub them. */
const URL_PASSWORD = "url-pass-9F3";
const URL_TOKEN = "url-token-7A1";

/** A base URL carrying both credential forms an operator produces by pasting a proxy DSN. */
const CREDENTIALED_URL = `https://operator:${URL_PASSWORD}@jev.proxy/v1?token=${URL_TOKEN}`;

const REQUEST: JevDecisionRequest = {
  model: "jev-test",
  state: "candidate block",
  questions: {
    fits: { type: "noul", instructions: "Does it fit?", criteria: { true: "yes", false: "no" } },
  },
};

/**
 * Asserts that nothing a caller can read off `error` carries the credential.
 *
 * `message`, `stack` and both stringified forms are checked together, because a
 * redaction applied to one of them is what a later refactor breaks first.
 *
 * @param error - The thrown value.
 */
function expectNoSecret(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const failure = error as Error;
  for (const surface of [failure.message, failure.stack ?? "", String(failure), JSON.stringify(failure)]) {
    expect(surface).not.toContain(SENTINEL);
  }
}

/** A client over a fixed response factory, with the sentinel as its credential. */
function clientWith(fetchImpl: JevFetch, baseUrl = "https://jev.test") {
  return createJevHttpClient({ baseUrl, apiKey: SENTINEL, timeoutMs: 500, fetchImpl, sleep: async () => undefined });
}

/** A factory that always answers the same status and body. */
function answering(status: number, body: unknown): JevFetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("redactSecrets", () => {
  it("replaces the configured value and any bearer credential, keeping the rest readable", () => {
    const text = `POST https://jev.test/v1/systemone with authorization: Bearer ${SENTINEL} and key ${SENTINEL}`;

    const redacted = redactSecrets(text, [SENTINEL]);

    expect(redacted).not.toContain(SENTINEL);
    expect(redacted).toContain(REDACTED);
    expect(redacted).toContain("https://jev.test/v1/systemone");
  });

  it("redacts a bearer credential it was not told about, and leaves prose alone", () => {
    // A header value can reach a message through a transport error even when the
    // caller has no secret to compare against; the shape alone is enough to scrub.
    const redacted = redactSecrets("refused: authorization: Bearer abc.def-123", []);

    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain("abc.def-123");
    expect(redactSecrets("the vendor was unavailable", [SENTINEL])).toBe("the vendor was unavailable");
  });

  it("ignores a blank secret instead of matching everywhere", () => {
    expect(redactSecrets("plain text", ["", "   "])).toBe("plain text");
  });
});

describe("redactRequestDescriptor", () => {
  it("returns a stringifiable descriptor whose credential is replaced", () => {
    const descriptor = redactRequestDescriptor({
      method: "POST",
      url: `https://jev.test/v1/systemone?key=${SENTINEL}`,
      headers: { authorization: `Bearer ${SENTINEL}`, "content-type": "application/json" },
    });

    for (const surface of [JSON.stringify(descriptor), String(descriptor.url)]) {
      expect(surface).not.toContain(SENTINEL);
    }
    expect(descriptor.headers["authorization"]).toBe(REDACTED);
    expect(descriptor.headers["content-type"]).toBe("application/json");
  });
});

describe("a credential carried inside the base URL never reaches a stored reason", () => {
  it("strips the userinfo and the query value, keeping the host and the path", () => {
    const descriptor = redactRequestDescriptor({ method: "POST", url: CREDENTIALED_URL, headers: {} });

    for (const secret of [URL_PASSWORD, URL_TOKEN, "operator"]) {
      expect(descriptor.url).not.toContain(secret);
    }
    expect(descriptor.url).toContain(REDACTED);
    // Diagnosis needs the endpoint, so redaction must not hide which host was called.
    expect(descriptor.url).toContain("jev.proxy");
    expect(descriptor.url).toContain("/v1");
  });

  it("keeps JevFailed.reason clean, because the pipeline persists it", async () => {
    const outcome = await requestDecision(
      clientWith(answering(401, { error: { message: "unauthorized" } }), CREDENTIALED_URL),
      REQUEST,
    );

    expect(outcome.status).toBe("provider_failure");
    for (const surface of [JSON.stringify(outcome), String(outcome)]) {
      expect(surface).not.toContain(URL_PASSWORD);
      expect(surface).not.toContain(URL_TOKEN);
    }
    expect(JSON.stringify(outcome)).toContain("jev.proxy");
  });
});

/** One extracted example, so the real evaluation has a candidate to decide on. */
const ONE_EXAMPLE: EvalSet = {
  version: "redaction-test/1",
  examples: [
    {
      id: "e1",
      kind: "entity",
      language: "en",
      source: "Acme employs Ada Lovelace.",
      quote: "Acme employs Ada Lovelace.",
      claim: "Acme employs Ada Lovelace.",
      extracted: true,
      candidate: { name: "Acme", proposedType: "Role" },
      labels: { canonical: "Role", support: "supported" },
    },
  ],
};

describe("the eval report never publishes a base-URL credential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints the redacted endpoint in the text and in the JSON", async () => {
    // The evaluator builds its own client, so the transport is stubbed at the global.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 })),
    );
    const out: string[] = [];
    const err: string[] = [];

    const code = await runEvalCli(["--real"], {
      env: { TYPESAFE_API_KEY: SENTINEL, LLMWIKI_JEV_BASE_URL: CREDENTIALED_URL },
      loadSet: () => ONE_EXAMPLE,
      write: (text) => out.push(text),
      writeError: (text) => err.push(text),
    });

    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    for (const secret of [URL_PASSWORD, URL_TOKEN]) {
      expect(out.join("")).not.toContain(secret);
    }
    expect(out.join("")).toContain("jev.proxy");
  });
});

describe("the audit base URL is redacted in the fallback path too", () => {
  it("redacts a configured URL when the injected runtime supplies no redacted form", () => {
    const runtime: ClassificationRuntime = {
      client: { decide: () => Promise.reject(new Error("the audit never calls the vendor")) },
      config: parseJevConfig({ LLMWIKI_JEV_BASE_URL: CREDENTIALED_URL }),
    };

    const audit = buildClassificationAudit({
      states: { classified: 0 },
      model: "jev-test",
      baseUrl: reportedBaseUrl(runtime.redactedBaseUrl, runtime.config.baseUrl),
      catalogVersion: "c1",
      classifierVersion: "v1",
    });

    for (const secret of [URL_PASSWORD, URL_TOKEN]) {
      expect(audit.base_url).not.toContain(secret);
    }
    expect(audit.base_url).toContain("jev.proxy");
  });
});

describe("a refused request never reports the credential", () => {
  it("scrubs a 401 whose body echoes the refused Authorization value", async () => {
    // This is the realistic shape: the vendor rejects the key and quotes it back.
    const echo = answering(401, { error: { message: `invalid api key ${SENTINEL}` } });

    const error = await clientWith(echo)
      .decide(REQUEST)
      .catch((thrown: unknown) => thrown);

    expectNoSecret(error);
    const failure = error as { message: string };
    expect(failure.message).toContain("401");
    expect(failure.message).toContain(REDACTED);
  });

  it("scrubs a 403 whose body echoes the credential", async () => {
    const echo = answering(403, { error: { message: `forbidden for ${SENTINEL}` } });

    const error = await clientWith(echo)
      .decide(REQUEST)
      .catch((thrown: unknown) => thrown);

    expectNoSecret(error);
  });
});

describe("an exhausted retry run never reports the credential", () => {
  it("keeps every attempt's message clean after the budget is spent", async () => {
    const echo = answering(503, { error: { message: `upstream refused ${SENTINEL}` } });

    const error = await clientWith(echo)
      .decide(REQUEST)
      .catch((thrown: unknown) => thrown);

    expectNoSecret(error);
    const failure = error as { message: string; failures?: readonly unknown[] };
    expect(failure.message).toContain(String(TRANSIENT_ATTEMPTS));
    expect(JSON.stringify(failure.failures ?? [])).not.toContain(SENTINEL);
  });

  it("scrubs a transport failure whose text quotes the request headers", async () => {
    const quoting: JevFetch = () =>
      Promise.reject(new Error(`fetch failed: {"headers":{"authorization":"Bearer ${SENTINEL}"}}`));

    const error = await clientWith(quoting)
      .decide(REQUEST)
      .catch((thrown: unknown) => thrown);

    expectNoSecret(error);
  });
});

describe("the persisted failure reason never carries the credential", () => {
  it("keeps JevFailed.reason clean, because the pipeline stores it", async () => {
    // `reason` is not a log line: it is written to `kg_classification_log.reason`
    // and returned by the graph read path, so it is the most damaging leak surface.
    const outcome = await requestDecision(clientWith(answering(401, { error: { message: SENTINEL } })), REQUEST);

    expect(outcome.status).toBe("provider_failure");
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });

  it("scrubs a transport failure that never got an answer at all", async () => {
    const quoting: JevFetch = () => Promise.reject(new Error(`connect failed for Bearer ${SENTINEL}`));

    const outcome = await requestDecision(clientWith(quoting), REQUEST);

    expect(outcome.status).toBe("provider_failure");
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
  });
});

describe("configuration errors never carry the credential", () => {
  it("names the missing variable without inventing a value", () => {
    let error: unknown;
    try {
      createJevHttpClientFromEnv({});
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(JevConfigError);
    expect((error as Error).message).toContain("TYPESAFE_API_KEY");
    expectNoSecret(error);
  });

  it("scrubs a credential that was pasted into the configured base URL", async () => {
    // Nothing here is hypothetical: a pasted key in the URL lands in every message
    // this adapter builds, because the endpoint is part of all of them.
    const client = createJevHttpClientFromEnv(
      { TYPESAFE_API_KEY: SENTINEL, LLMWIKI_JEV_BASE_URL: `https://jev.test/${SENTINEL}` },
      answering(401, { error: { message: "unauthorized" } }),
    );

    const error = await client
      .decide(REQUEST)
      .catch((thrown: unknown) => thrown);

    expectNoSecret(error);
  });
});
