/**
 * @file packages/llmwiki-kg/ts/src/core/llm/tool-call.ts
 * @description Structured extraction: forcing a required tool call per provider.
 *
 * Split out of `core/llm_clients.ts` as its own unit because the two provider
 * bodies here are the most measurement-sensitive payloads in the port — every
 * field is LlamaIndex's default for the call `SchemaLLMPathExtractor` makes, and
 * changing any of them changes what the model returns.
 */

import { config } from "../../config.js";
import { ANTHROPIC_VERSION, EXTRACTION_MAX_TOKENS, EXTRACTION_TEMPERATURE } from "./constants.js";
import { extractionEndpoint } from "./endpoints.js";
import { LlmError } from "./errors.js";
import { asArray, asRecord, asString, postJson } from "./json.js";

/** A tool the model is required to call. */
export interface ToolDefinition {
  /** Function name, e.g. `KGSchema`. */
  readonly name: string;
  /** Function description. */
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly parameters: Record<string, unknown>;
}

/** The Anthropic request body: `input_schema`, not `parameters`. */
function anthropicToolPayload(prompt: string, tool: ToolDefinition, maxTokens: number): unknown {
  return {
    model: config.EXTRACTION_MODEL,
    max_tokens: maxTokens,
    temperature: EXTRACTION_TEMPERATURE,
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  };
}

/**
 * The OpenAI-compatible request body: `tool_choice: "required"`, no streaming.
 *
 * ## Why `strict` is conditional on the provider
 *
 * `strict: true` is what makes the schema binding rather than advisory: without
 * it, an `enum` on a field is a hint the model can ignore, and structured outputs
 * are not enforced. It is set only for `openai` because the flag is an OpenAI
 * extension to the chat-completions format, and the two other backends differ:
 *
 * - `gateway` is any OpenAI-compatible server. A server that does not implement
 *   the flag may reject the whole request, and this package cannot verify every
 *   gateway's support. Sending it unconditionally would trade a schema hint for
 *   an outage on an unknown backend.
 * - `anthropic` has no such field at all; its tool schema is always enforced, so
 *   there is nothing to opt into.
 *
 * The cost of the conditional is that `gateway` still gets advisory-only typing.
 * That is the honest position: the schema constraints in `graph-prompt.ts` are
 * shaped to satisfy strict mode, so enabling it on a gateway that supports the
 * flag is a config change rather than a code change.
 */
function openAiToolPayload(prompt: string, tool: ToolDefinition, maxTokens: number): unknown {
  const strictSchema = config.EXTRACTION_PROVIDER === "openai";
  return {
    messages: [{ role: "user", content: prompt }],
    stream: false,
    model: config.EXTRACTION_MODEL,
    temperature: EXTRACTION_TEMPERATURE,
    tools: [
      {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(strictSchema ? { strict: true } : {}),
        },
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    max_tokens: maxTokens,
  };
}

/** Finds the `tool_use` block's `input` in an Anthropic message response. */
function anthropicToolArguments(body: unknown, endpoint: string): string {
  const content = asArray(asRecord(body)?.["content"]);
  for (const block of content ?? []) {
    const record = asRecord(block);
    if (record?.["type"] === "tool_use") {
      return JSON.stringify(record["input"] ?? {});
    }
  }
  throw new LlmError(`${endpoint} response has no tool_use block`, endpoint);
}

/** Reads `choices[0].message.tool_calls[0].function.arguments`. */
function openAiToolArguments(body: unknown, endpoint: string): string {
  const choices = asArray(asRecord(body)?.["choices"]);
  const message = asRecord(asRecord(choices?.[0])?.["message"]);
  const toolCalls = asArray(message?.["tool_calls"]);
  const firstCall = asRecord(toolCalls?.[0]);
  const args = asString(asRecord(firstCall?.["function"])?.["arguments"]);
  if (args === undefined) {
    // `error_on_no_tool_call=True` in Python. The extractor treats this as an
    // empty extraction for the chunk rather than failing the document.
    throw new LlmError(`${endpoint} response contains no tool call`, endpoint);
  }
  return args;
}

/**
 * Forces the model to answer by calling `tool`, and returns the raw
 * `function.arguments` string.
 *
 * This reproduces the exact request `SchemaLLMPathExtractor` makes through
 * LlamaIndex's `FunctionCallingProgram`: one user message, one tool,
 * `tool_choice: "required"`, `parallel_tool_calls: false`, `temperature: 0.1`,
 * `max_tokens: 4096`, `stream: false`.
 *
 * ## Why the arguments come back as a string
 *
 * OpenAI-compatible providers send `arguments` as a JSON *string*, and some send
 * it truncated or with a wrapper sentence. Parsing is the extractor's job, in
 * `extraction.ts`, because a parse failure there is recoverable per chunk (the
 * oracle treats it as "no triplets for this chunk"), while a parse failure here
 * would take down the whole document.
 *
 * @returns the JSON text the model put in the tool call.
 * @throws {LlmError} when the model answered without a tool call. Python's
 *   `error_on_no_tool_call=True` raises the same condition; the extractor
 *   catches it and yields an empty result for that chunk.
 */
export async function callTool(
  prompt: string,
  tool: ToolDefinition,
  maxTokens: number = EXTRACTION_MAX_TOKENS,
): Promise<string> {
  const { endpoint, apiKey } = extractionEndpoint();

  if (config.EXTRACTION_PROVIDER === "anthropic") {
    const { body } = await postJson(
      endpoint,
      { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      anthropicToolPayload(prompt, tool, maxTokens),
    );
    return anthropicToolArguments(body, endpoint);
  }

  const { body } = await postJson(
    endpoint,
    { authorization: `Bearer ${apiKey}` },
    openAiToolPayload(prompt, tool, maxTokens),
  );
  return openAiToolArguments(body, endpoint);
}
