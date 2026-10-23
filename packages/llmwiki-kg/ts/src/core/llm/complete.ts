/**
 * @file packages/llmwiki-kg/ts/src/core/llm/complete.ts
 * @description Single-prompt text completion, with provider differences hidden.
 *
 * Split out of `core/llm_clients.ts` as its own unit because it is the only path
 * that returns free text rather than structured data, and it carries the two
 * response readers (`choices[0].message.content`, Anthropic `text` blocks) that
 * nothing else needs.
 */

import { config } from "../../config.js";
import {
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
} from "./constants.js";
import { extractionEndpoint } from "./endpoints.js";
import { LlmError } from "./errors.js";
import { asArray, asRecord, asString, postJson } from "./json.js";

// ---------------------------------------------------------------------------
// Plain text completion
// ---------------------------------------------------------------------------

/**
 * Single-prompt text completion, provider differences hidden from callers.
 *
 * Returns the model's answer as a plain string, trimmed — Python does the same
 * (`.strip()`) so a description written straight to the database has no
 * incidental leading or trailing whitespace.
 *
 * Used by {@link synthesizeEntityDescriptions} in `extraction.ts`, and by the
 * `/context`, page-generation and synthesis endpoints of later slices, exactly
 * as `complete()` is used in Python.
 *
 * @param prompt the complete prompt; there is no separate system message,
 *   matching the Python callers, which all pass a single user message.
 * @param maxTokens response budget. `300` for description synthesis.
 */
export async function complete(
  prompt: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Promise<string> {
  const { endpoint, apiKey } = extractionEndpoint();

  if (config.EXTRACTION_PROVIDER === "anthropic") {
    const { body } = await postJson(
      endpoint,
      { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      {
        model: config.EXTRACTION_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      },
    );
    return anthropicText(body, endpoint).trim();
  }

  const { body } = await postJson(
    endpoint,
    { authorization: `Bearer ${apiKey}` },
    {
      model: config.EXTRACTION_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
  );
  return chatMessageContent(body, endpoint).trim();
}

/**
 * `response.choices[0].message.content` from an OpenAI-compatible body.
 *
 * Python reads the same path and would raise `IndexError`/`AttributeError` on a
 * missing one; here it is a typed {@link LlmError}, which the route turns into a
 * 500 instead of an unhandled rejection.
 */
export function chatMessageContent(body: unknown, endpoint: string): string {
  const choices = asArray(asRecord(body)?.["choices"]);
  const message = asRecord(asRecord(choices?.[0])?.["message"]);
  const content = asString(message?.["content"]);
  if (content === undefined) {
    throw new LlmError(
      `${endpoint} response has no choices[0].message.content`,
      endpoint,
    );
  }
  return content;
}

/** Joins the `text` blocks of an Anthropic message response. */
export function anthropicText(body: unknown, endpoint: string): string {
  const content = asArray(asRecord(body)?.["content"]);
  if (content === undefined) {
    throw new LlmError(`${endpoint} response has no content array`, endpoint);
  }
  const parts: string[] = [];
  for (const block of content) {
    const text = asString(asRecord(block)?.["text"]);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts.join("");
}
