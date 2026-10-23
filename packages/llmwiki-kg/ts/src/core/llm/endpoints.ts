/**
 * @file packages/llmwiki-kg/ts/src/core/llm/endpoints.ts
 * @description Resolving the provider endpoint and credentials from config.
 *
 * Split out of `core/llm_clients.ts` as its own unit because provider selection
 * is a config concern, divorced from what the request body looks like — and the
 * Anthropic/OpenAI split it encodes is the same one the request builders branch
 * on.
 */

import { config } from "../../config.js";
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

export function extractionEndpoint(): ExtractionEndpoint {
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

/** Embeddings endpoint for the configured embedding provider, plus its key. */
export function embeddingEndpoint(): ExtractionEndpoint {
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
