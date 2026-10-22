/**
 * @file packages/llmwiki-kg/ts/src/core/llm/constants.ts
 * @description Sampling constants and provider base URLs for the LLM clients.
 *
 * Split out of `core/llm_clients.ts` as its own unit because these are measured
 * wire values — LlamaIndex's defaults for the calls the Python oracle makes —
 * not tunables, and the request builders in every sibling module read them.
 */

/** Default `max_tokens` for a plain completion. Mirrors `complete()`'s default. */
export const DEFAULT_MAX_TOKENS = 1024;

/**
 * `max_tokens` LlamaIndex's `OpenAI` wrapper sends, from
 * `Settings.llm = LIOpenAI(..., max_tokens=4096)` in `extraction.py`.
 *
 * Sent verbatim: a smaller budget truncates the tool call and the response
 * becomes unparseable, which the oracle would then treat as "no triplets".
 */
export const EXTRACTION_MAX_TOKENS = 4096;

/**
 * Sampling temperature LlamaIndex applies when the caller does not set one.
 *
 * Part of the request, therefore part of the contract: raising it makes the
 * same document yield different entity sets between runs.
 */
export const EXTRACTION_TEMPERATURE = 0.1;

/** Base URL of the OpenAI API, used when `*_PROVIDER=openai`. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Base URL of the Anthropic API, used when `EXTRACTION_PROVIDER=anthropic`. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Anthropic API version header, as the SDK sends it. */
export const ANTHROPIC_VERSION = "2023-06-01";
