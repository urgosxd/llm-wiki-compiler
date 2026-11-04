/**
 * @file packages/llmwiki-kg/ts/src/core/llm/endpoints.ts
 * @description Resolving the provider endpoint, credential and model from config.
 *
 * Split out of `core/llm_clients.ts` as its own unit because provider selection
 * is a config concern, divorced from what the request body looks like — and the
 * Anthropic/OpenAI split it encodes is the same one the request builders branch
 * on.
 *
 * ## Two overrides, two sides, never crossed
 *
 * A host that already resolved a backend can hand it over for the ONE call it
 * belongs to: `chat-backend.ts` for extraction, `embedding-backend.ts` for
 * vectors. Each reader consults its own override and nothing else, so an
 * embedding descriptor can never decide an extraction request (or the reverse)
 * even in a deployment whose two services live on different hosts.
 */

import { config } from "../../config.js";
import { injectedEmbeddingEndpoint } from "../../embedding-backend.js";
import { injectedChatEndpoint, injectedChatModel, isChatBackendInjected } from "../../chat-backend.js";
import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL } from "./constants.js";

// ---------------------------------------------------------------------------
// Endpoint and credential resolution
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible chat-completions endpoint for the configured extraction
 * provider, with the credentials that endpoint expects.
 *
 * `gateway` and `openai` differ only in base URL and key, which is the whole
 * reason the Python module could treat them as one code path.
 */
export interface ExtractionEndpoint {
  readonly endpoint: string;
  readonly apiKey: string;
}

/**
 * The endpoint and credential of the extraction request.
 *
 * An injected CHAT backend wins when one is installed for this call: a host that
 * already resolved an OpenAI-compatible endpoint hands over the endpoint and
 * credential it will actually use, so the kg dimension reaches the same service
 * the wiki dimension talks to instead of a second, separately-derived one. The
 * embedding override is deliberately not consulted here.
 *
 * @returns The URL to POST and the credential to send.
 */
export function extractionEndpoint(): ExtractionEndpoint {
  const injected = injectedChatEndpoint();
  if (injected !== undefined) return injected;
  switch (config.EXTRACTION_PROVIDER) {
    case "gateway":
      return {
        endpoint: `${config.GATEWAY_URL}/chat/completions`,
        apiKey: config.GATEWAY_API_KEY,
      };
    case "openai":
      return {
        endpoint: `${OPENAI_BASE_URL}/chat/completions`,
        apiKey: config.OPENAI_API_KEY,
      };
    case "anthropic":
      // Anthropic is not OpenAI-compatible; the endpoint is resolved separately
      // because both the path and the body shape differ.
      return { endpoint: `${ANTHROPIC_BASE_URL}/v1/messages`, apiKey: config.ANTHROPIC_API_KEY };
  }
}

/**
 * The model the extraction request asks for.
 *
 * An injected chat backend supplies the model the wiki dimension's chat client
 * was configured with, unless the operator named `EXTRACTION_MODEL` themselves.
 *
 * @returns The model id to put in the request body.
 */
export function extractionModel(): string {
  return injectedChatModel() ?? config.EXTRACTION_MODEL;
}

/**
 * Whether the extraction request must use the Anthropic body and headers.
 *
 * A descriptor is an OpenAI-compatible backend by construction, so its presence
 * settles the question: whatever `EXTRACTION_PROVIDER` says, an injected backend
 * is never called with an Anthropic payload.
 *
 * @returns True only for the env-derived `anthropic` provider.
 */
export function extractionUsesAnthropicScheme(): boolean {
  if (isChatBackendInjected()) return false;
  return config.EXTRACTION_PROVIDER === "anthropic";
}

/**
 * Embeddings endpoint for the configured embedding provider, plus its key.
 *
 * An injected backend wins when one is installed for this call: a host that
 * already resolved an OpenAI-compatible endpoint hands over the endpoint and
 * credential it will actually use, so the kg dimension reaches the same service
 * instead of a second, separately-derived one.
 */
export function embeddingEndpoint(): ExtractionEndpoint {
  const injected = injectedEmbeddingEndpoint();
  if (injected !== undefined) return injected;
  switch (config.EMBEDDING_PROVIDER) {
    case "gateway":
      return {
        endpoint: `${config.GATEWAY_URL}/embeddings`,
        apiKey: config.GATEWAY_API_KEY,
      };
    case "openai":
      return { endpoint: `${OPENAI_BASE_URL}/embeddings`, apiKey: config.OPENAI_API_KEY };
  }
}
