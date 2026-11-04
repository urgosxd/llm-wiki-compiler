/**
 * @file src/dimensions/kg/provider-credentials.test.ts
 * @description Proves the kg dimension refuses a missing embedding credential
 * BEFORE it reads an ontology, calls a provider, or touches Postgres (S4, S5).
 *
 * WHY THE ADAPTER IS DRIVEN WITH A MOCKED BARREL. The rule under test is
 * sequencing, not extraction: the check has to run first, so every later step is
 * replaced by a spy that would record a call. `globalThis.fetch` is spied as
 * well, because the defect this feature removes was a raw 401 from the provider:
 * a rejected configuration must perform no HTTP request at all.
 *
 * Every credential here is obviously fake, so any leak into a message is visible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake credential, chosen so a leak is unmistakable in any output. */
const FAKE_KEY = "test-key-not-real";
/** A fake gateway endpoint; the `.invalid` TLD can never resolve. */
const FAKE_ENDPOINT = "https://gateway.invalid/v1";

const chunkAndEmbed = vi.fn();
const extractGraphFromChunks = vi.fn();
const loadOntology = vi.fn();

/** Mutable so each case states the resolved KG config it is testing. */
const state: { config: Record<string, string> } = {
  config: { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" },
};

vi.mock("llmwiki-kg", async () => {
  // The bridge and the error class stay REAL: the check under test is theirs.
  const core = await import("../../../packages/llmwiki-kg/ts/src/core-index.js");
  return {
    ...core,
    chunkAndEmbed,
    extractGraphFromChunks,
    get kgConfig() {
      return state.config;
    },
  };
});

const { createKgDimension } = await import("../../../src/dimensions/kg/index.js");
const { ConfigValidationError } = await import("llmwiki-kg");
// The injected wiring itself, read through the real modules so the assertions
// observe the endpoint a request would actually use.
const { injectedEmbeddingEndpoint } = await import(
  "../../../packages/llmwiki-kg/ts/src/embedding-backend.js"
);
const { embeddingEndpoint } = await import(
  "../../../packages/llmwiki-kg/ts/src/core/llm/endpoints.js"
);

/** The backend the wiki dimension reports for the injected cases below. */
const INJECTED_BACKEND = {
  baseURL: "https://wiki-embed.invalid/v1",
  apiKey: FAKE_KEY,
  model: "wiki-embed-768",
};

/**
 * Build the dimension under test with a stable stack binding.
 *
 * `describeEmbeddingBackend` is the injected resolver the compiler supplies in
 * production; `undefined` stands for a provider that does not implement it.
 */
function dimension(
  describeEmbeddingBackend?: () => typeof INJECTED_BACKEND | undefined,
) {
  return createKgDimension({
    stackId: "stack-1",
    stackName: "Stack One",
    loadOntology,
    ...(describeEmbeddingBackend === undefined ? {} : { describeEmbeddingBackend }),
  });
}

/** A dimension input, as an ingest would supply it. */
const INPUT = {
  source: "https://example.test/a",
  title: "A",
  document: "# A\nbody",
  body: "body",
};

/** Run `prepare` and return the message it rejected with. */
async function rejectionMessage(
  describeEmbeddingBackend?: () => typeof INJECTED_BACKEND | undefined,
): Promise<string> {
  try {
    await dimension(describeEmbeddingBackend).prepare(INPUT);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as Error).message;
  }
  throw new Error("expected prepare to reject");
}

/** The four rejections S4 names, with the exact text each must produce. */
const REJECTIONS = [
  {
    name: "openai without an API key",
    wikiProvider: "openai",
    config: { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" },
    message:
      "EMBEDDING_PROVIDER=openai but no API key is configured. Set OPENAI_API_KEY, " +
      "or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.",
  },
  {
    name: "gateway without a URL",
    wikiProvider: "openai",
    config: { EMBEDDING_PROVIDER: "gateway", OPENAI_API_KEY: FAKE_KEY, GATEWAY_URL: "", GATEWAY_API_KEY: FAKE_KEY },
    message:
      "EMBEDDING_PROVIDER=gateway but GATEWAY_URL is not set. Set GATEWAY_URL, " +
      "or OPENAI_EMBEDDINGS_BASE_URL to reuse the wiki dimension's endpoint.",
  },
  {
    name: "gateway with a URL but no key",
    wikiProvider: "openai",
    config: { EMBEDDING_PROVIDER: "gateway", OPENAI_API_KEY: FAKE_KEY, GATEWAY_URL: FAKE_ENDPOINT, GATEWAY_API_KEY: "" },
    message:
      "EMBEDDING_PROVIDER=gateway but GATEWAY_API_KEY is not set. Set GATEWAY_API_KEY, " +
      "or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.",
  },
  {
    name: "a wiki provider with no kg equivalent",
    wikiProvider: "anthropic",
    config: { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" },
    message:
      'LLMWIKI_EMBEDDING_PROVIDER="anthropic" has no kg-dimension equivalent. ' +
      "The kg dimension embeds through EMBEDDING_PROVIDER=openai or gateway; " +
      "set one of those with its credential.",
  },
];

/**
 * Spy on the global fetch: a rejected configuration must never call out.
 *
 * Typed through the call itself, so the spy's type never has to be re-declared
 * by hand (and cannot drift from what `vi.spyOn` actually returns).
 */
function spyOnFetch() {
  return vi.spyOn(globalThis, "fetch");
}

let fetchSpy: ReturnType<typeof spyOnFetch>;

beforeEach(() => {
  vi.clearAllMocks();
  // The worker environment must not decide the outcome: the wiki side and the
  // explicit KG provider are stated per case.
  vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "");
  vi.stubEnv("LLMWIKI_PROVIDER", "");
  vi.stubEnv("EMBEDDING_PROVIDER", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GATEWAY_URL", "");
  vi.stubEnv("GATEWAY_API_KEY", "");
  vi.stubEnv("EMBEDDING_MODEL", "");
  vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "");
  chunkAndEmbed.mockResolvedValue([{ text: "body", embedding: [0.1], index: 0 }]);
  extractGraphFromChunks.mockResolvedValue({ entities: [], relationships: [] });
  fetchSpy = spyOnFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("prepare refuses an unusable embedding credential (S4)", () => {
  it.each(REJECTIONS)(
    "rejects $name with the exact message and no HTTP request",
    async ({ wikiProvider, config, message }) => {
      vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", wikiProvider);
      state.config = config;

      expect(await rejectionMessage()).toBe(message);
      // The whole point of failing closed: no provider was asked, so no 401.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(chunkAndEmbed).not.toHaveBeenCalled();
      expect(extractGraphFromChunks).not.toHaveBeenCalled();
    },
  );

  it("rejects before the Stack's ontology is read", async () => {
    state.config = { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" };
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");

    await expect(dimension().prepare(INPUT)).rejects.toBeInstanceOf(ConfigValidationError);
    expect(loadOntology).not.toHaveBeenCalled();
  });

  it("still prepares a document when the credential is complete", async () => {
    state.config = { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: FAKE_KEY, GATEWAY_URL: "", GATEWAY_API_KEY: "" };
    // The credential the parsed config carries is the one the environment holds:
    // an explicit KG-side key, which is exactly the deployment that must keep
    // working and therefore never has its backend re-derived. The operator also
    // named the model, so the 768-width door stays shut.
    vi.stubEnv("OPENAI_API_KEY", FAKE_KEY);
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "operator-chosen-768");
    loadOntology.mockResolvedValue(undefined);

    const prepared = await dimension().prepare(INPUT);

    expect(prepared.handle).toBeDefined();
    expect(chunkAndEmbed).toHaveBeenCalled();
  });

  it("keeps the credential out of the rejection message (S5)", async () => {
    state.config = { EMBEDDING_PROVIDER: "gateway", OPENAI_API_KEY: FAKE_KEY, GATEWAY_URL: FAKE_ENDPOINT, GATEWAY_API_KEY: "" };
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");

    expect(await rejectionMessage()).not.toContain(FAKE_KEY);
  });
});

/** The message the descriptor path adds when the wiki side resolved no key. */
const NO_CREDENTIAL_MESSAGE =
  "The wiki dimension's embedding backend resolved with no API key. " +
  "Set the wiki dimension's embedding credential (OPENAI_EMBEDDINGS_API_KEY) " +
  "or GATEWAY_API_KEY to reuse that backend in the kg dimension.";

describe("the backend the wiki dimension resolved drives the kg dimension (S2, S4)", () => {
  it("refuses a resolved backend that carries no credential, before any request", async () => {
    const credentialless = { ...INJECTED_BACKEND, apiKey: "" };

    expect(await rejectionMessage(() => credentialless)).toBe(NO_CREDENTIAL_MESSAGE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chunkAndEmbed).not.toHaveBeenCalled();
  });

  it("refuses a resolved model the operator did not choose, naming the 768 column", async () => {
    const message = await rejectionMessage(() => INJECTED_BACKEND);

    expect(message).toContain(INJECTED_BACKEND.model);
    expect(message).toContain("768");
    expect(message).toContain("LLMWIKI_EMBEDDING_MODEL");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chunkAndEmbed).not.toHaveBeenCalled();
  });

  it("keeps the named refusal when the provider does not implement the member", async () => {
    state.config = { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" };
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "anthropic");

    const message = await rejectionMessage(() => undefined);

    expect(message).toBe(
      'LLMWIKI_EMBEDDING_PROVIDER="anthropic" has no kg-dimension equivalent. ' +
        "The kg dimension embeds through EMBEDDING_PROVIDER=openai or gateway; " +
        "set one of those with its credential.",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a resolver failure as its message, never a stack trace", async () => {
    state.config = { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: FAKE_KEY, GATEWAY_URL: "", GATEWAY_API_KEY: "" };
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    const failing = () => {
      throw new Error('LLMWIKI_EMBEDDING_PROVIDER="x" cannot serve embeddings.');
    };

    const message = await rejectionMessage(failing);

    expect(message).toBe('LLMWIKI_EMBEDDING_PROVIDER="x" cannot serve embeddings.');
    expect(message).not.toContain("    at ");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("installs the resolved backend for the embedding call and clears it afterwards", async () => {
    state.config = { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "", GATEWAY_URL: "", GATEWAY_API_KEY: "" };
    vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "operator-chosen-768");
    loadOntology.mockResolvedValue(undefined);
    let insideEndpoint: unknown;
    chunkAndEmbed.mockImplementationOnce(async () => {
      insideEndpoint = embeddingEndpoint();
      return [{ text: "body", embedding: [0.1], index: 0 }];
    });

    await dimension(() => INJECTED_BACKEND).prepare(INPUT);

    expect(insideEndpoint).toEqual({
      endpoint: `${INJECTED_BACKEND.baseURL}/embeddings`,
      apiKey: FAKE_KEY,
    });
    expect(injectedEmbeddingEndpoint()).toBeUndefined();
  });
});
