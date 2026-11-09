/**
 * @file test/dimensions/kg-provider-identity-invariants.test.ts
 * @description Pins the two invariants the product owner stated for extraction,
 * verbatim: "la extracion debe ser con las credencioles de .env no con antropci
 * ni openai". The destination must come from the RESOLVED CLIENT's base URL and
 * never from the provider's NAME, and the credential must be the one that client
 * carries.
 *
 * WHY THE NAME IS THE TRAP. A wiki deployment names its chat provider `openai`
 * while `OPENAI_BASE_URL` points at an OpenAI-COMPATIBLE host that is not
 * OpenAI — `https://openrouter.ai/api/v1` for the deployment this feature
 * exists for. A bridge that maps the provider NAME to a built-in backend
 * therefore builds a perfectly well-formed request to `api.openai.com`, and
 * nothing in the configuration, the logs or the response says so until that
 * host answers. The same trap sits on the embeddings side, and on the built-in
 * `anthropic` identity: the vendored `EXTRACTION_PROVIDER` default IS
 * `anthropic`, so an extraction that falls back to its own provider identity
 * reaches `api.anthropic.com`.
 *
 * WHY THE DEFAULT-HOST CASE. A "does not contain api.openai.com" assertion is
 * evidence only if that host is what the name would otherwise produce, so one
 * case resolves the SAME provider with the override absent and shows the client
 * then reports the built-in OpenAI host. The pair is the proof; a lone absence
 * could equally be a typo in an override.
 *
 * WHY THE NO-DESCRIPTOR CASE. The anthropic refusal is only meaningful against
 * an environment where an anthropic request WOULD have been well formed. That
 * case runs the very same environment without a descriptor installed and shows
 * the vendored path answering `api.anthropic.com`; the descriptor-installed case
 * then shows it cannot.
 *
 * No socket is opened — these cases read the endpoint a request WOULD use — and
 * every credential is obviously fake, so a leak is unmistakable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildProvider,
  getProvider,
  type ChatBackendDescriptor,
  type EmbeddingBackendDescriptor,
} from "../../src/utils/provider.js";
import { getEmbeddingProvider } from "../../src/utils/embedding-provider.js";
import { withChatBackend, injectedChatModel } from "@repo/kg/chat-backend";
import {
  withEmbeddingBackend,
  injectedEmbeddingModel,
} from "@repo/kg/embedding-backend";
import {
  embeddingEndpoint,
  extractionEndpoint,
  extractionUsesAnthropicScheme,
} from "@repo/kg/core/llm/endpoints";

/** The chat host the owner's `.env` points at — not an OpenAI host. */
const CHAT_HOST = "https://openrouter.ai/api/v1";
/** The embeddings host the owner's `.env` points at — not an OpenAI host either. */
const EMBEDDINGS_HOST = "https://api.synthetic.new/openai/v1";
/** The model each side must ask for, read from the wiki side's own variables. */
const CHAT_MODEL = "deepseek/deepseek-v4-flash";
const EMBEDDING_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** The host a name-based bridge would reach, and the one forbidden here. */
const BUILT_IN_OPENAI_HOST = "api.openai.com";
/** The vendor a fallback to the kg dimension's own identity would reach. */
const ANTHROPIC = "anthropic";

/** Distinct fakes, one per credential variable, so a swap shows in the value. */
const OPENAI_KEY = "test-key-not-real-openai";
const ORCAROUTER_KEY = "test-key-not-real-orcarouter";
const ANTHROPIC_KEY = "test-key-not-real-anthropic";
const EMBEDDINGS_KEY = "test-key-not-real-embed";

/**
 * The owner's deployment shape: the chat provider is NAMED `openai`, both of its
 * hosts are overrides, and both candidate credentials are present.
 *
 * `EXTRACTION_PROVIDER` is `undefined` rather than `""`: an explicitly empty
 * provider is an invalid value the vendored schema rejects, while an absent one
 * is what lets the descriptor drive extraction at all.
 */
const DEPLOYMENT_ENV: Record<string, string | undefined> = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_MODEL: CHAT_MODEL,
  OPENAI_BASE_URL: CHAT_HOST,
  OPENAI_API_KEY: OPENAI_KEY,
  LLMWIKI_EMBEDDING_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_MODEL: EMBEDDING_MODEL,
  OPENAI_EMBEDDINGS_BASE_URL: EMBEDDINGS_HOST,
  OPENAI_EMBEDDINGS_API_KEY: EMBEDDINGS_KEY,
  ORCAROUTER_API_KEY: ORCAROUTER_KEY,
  // Set so an anthropic fallback would be a COMPLETE, sendable request: the
  // refusal below is then about reaching that host, never about a missing key.
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  EXTRACTION_PROVIDER: undefined,
  EXTRACTION_MODEL: "",
  EMBEDDING_PROVIDER: undefined,
  EMBEDDING_MODEL: "",
  GATEWAY_URL: "",
  GATEWAY_API_KEY: "",
};

/** The chat descriptor the wiki's own chat provider reports, or a loud failure. */
function chatDescriptor(): ChatBackendDescriptor {
  const descriptor = getProvider().describeChatBackend?.();
  if (descriptor === undefined) throw new Error("the wiki chat provider reported no descriptor");
  return descriptor;
}

/** The embeddings descriptor the wiki's own provider reports, or a loud failure. */
function embeddingsDescriptor(): EmbeddingBackendDescriptor {
  const descriptor = getEmbeddingProvider().describeEmbeddingBackend?.();
  if (descriptor === undefined) throw new Error("the wiki embeddings provider reported no descriptor");
  return descriptor;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(DEPLOYMENT_ENV)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the extraction host comes from the resolved chat client, never from the provider's name", () => {
  it("sends extraction to the base URL the chat client resolved, with the name saying openai", async () => {
    // The provider is NAMED `openai` (DEPLOYMENT_ENV) and its client points
    // elsewhere: this case is the trap itself, stated as one environment.
    const descriptor = chatDescriptor();
    expect(descriptor.baseURL).toBe(CHAT_HOST);

    const endpoint = await withChatBackend(descriptor, () => extractionEndpoint());

    expect(endpoint.endpoint).toBe(`${CHAT_HOST}/chat/completions`);
    // Both directions of the same fact: the client's host is present ...
    expect(new URL(endpoint.endpoint).hostname).toBe(new URL(CHAT_HOST).hostname);
    expect(endpoint.endpoint).toContain("openrouter.ai");
    // ... and the host the NAME implies is absent.
    expect(endpoint.endpoint).not.toContain(BUILT_IN_OPENAI_HOST);
    expect(endpoint.endpoint).not.toContain("openai.com");
  });

  it("shows that name alone WOULD have meant the built-in OpenAI host", async () => {
    // No override: whatever the client resolves now is what a bridge that read
    // the name instead of the client would have used all along.
    vi.stubEnv("OPENAI_BASE_URL", undefined);

    const descriptor = chatDescriptor();
    const endpoint = await withChatBackend(descriptor, () => extractionEndpoint());

    expect(descriptor.baseURL).toContain(BUILT_IN_OPENAI_HOST);
    expect(endpoint.endpoint).toContain(BUILT_IN_OPENAI_HOST);
  });

  it("never sends extraction to a built-in anthropic host while a descriptor is installed", async () => {
    const descriptor = chatDescriptor();

    const observed = await withChatBackend(descriptor, () => ({
      endpoint: extractionEndpoint(),
      anthropicScheme: extractionUsesAnthropicScheme(),
    }));

    expect(observed.endpoint.endpoint).toBe(`${CHAT_HOST}/chat/completions`);
    expect(observed.endpoint.endpoint).not.toMatch(/anthropic/i);
    // The Anthropic body and headers never apply to an OpenAI-compatible
    // descriptor, whatever the vendored provider default says.
    expect(observed.anthropicScheme).toBe(false);
  });

  it("needs the descriptor, not the environment: the same env without one answers api.anthropic.com", async () => {
    // A fresh module graph, so the vendored config singleton resolves from THIS
    // case's environment and the comparison cannot be inherited from a sibling.
    vi.resetModules();
    const [chatBackend, endpoints] = await Promise.all([
      import("@repo/kg/chat-backend"),
      import("@repo/kg/core/llm/endpoints"),
    ]);

    // Nothing installed: the vendored default provider identity decides, which
    // is exactly the request the owner forbids — and the one the installed
    // descriptor above replaces.
    expect(chatBackend.injectedChatEndpoint()).toBeUndefined();
    expect(endpoints.extractionEndpoint().endpoint).toContain(ANTHROPIC);
    expect(endpoints.extractionUsesAnthropicScheme()).toBe(true);
  });
});

describe("the embeddings host comes from the resolved embeddings client, never from the name", () => {
  it("sends embeddings to the base URL the embeddings client resolved", async () => {
    const descriptor = embeddingsDescriptor();
    expect(descriptor.baseURL).toBe(EMBEDDINGS_HOST);

    const endpoint = await withEmbeddingBackend(descriptor, () => embeddingEndpoint());

    expect(endpoint.endpoint).toBe(`${EMBEDDINGS_HOST}/embeddings`);
    expect(endpoint.endpoint).toContain("api.synthetic.new");
    expect(endpoint.endpoint).not.toContain(BUILT_IN_OPENAI_HOST);
  });

  it("asks for the model the wiki side named, never a kg-side constant", async () => {
    const descriptor = embeddingsDescriptor();

    const model = await withEmbeddingBackend(descriptor, () => injectedEmbeddingModel());

    expect(descriptor.model).toBe(EMBEDDING_MODEL);
    expect(model).toBe(EMBEDDING_MODEL);
  });
});

describe("the credential is the one the resolved chat client carries", () => {
  it("reports OPENAI_API_KEY, the variable the OpenAI client resolves, not ORCAROUTER_API_KEY", async () => {
    const descriptor = chatDescriptor();

    expect(descriptor.apiKey).toBe(OPENAI_KEY);
    expect(descriptor.apiKey).not.toBe(ORCAROUTER_KEY);

    const endpoint = await withChatBackend(descriptor, () => extractionEndpoint());

    expect(endpoint.apiKey).toBe(OPENAI_KEY);
    expect(endpoint.apiKey).not.toBe(ORCAROUTER_KEY);
  });

  it("shows ORCAROUTER_API_KEY belonging to the orcarouter client alone", () => {
    // The contrast that makes the assertion above specific: the gateway client
    // reads its OWN variable, so finding the OpenAI key on the OpenAI client is
    // a fact about that client, not about which variable happened to be set.
    const gateway = buildProvider("orcarouter").describeChatBackend?.();
    if (gateway === undefined) throw new Error("the orcarouter provider reported no descriptor");

    expect(gateway.apiKey).toBe(ORCAROUTER_KEY);
    expect(gateway.apiKey).not.toBe(OPENAI_KEY);
  });

  it("asks for the chat model the wiki side named, never a kg-side constant", async () => {
    const descriptor = chatDescriptor();

    const model = await withChatBackend(descriptor, () => injectedChatModel());

    expect(descriptor.model).toBe(CHAT_MODEL);
    expect(model).toBe(CHAT_MODEL);
  });
});
