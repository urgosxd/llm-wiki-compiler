import { config } from "../config.js";

/**
 * LLM client factory and uniform completion interface.
 *
 * TypeScript port of `app/core/llm_clients.py`. Every LLM call in the server
 * goes through this module, so adding a provider is a one-file change here —
 * the same guarantee the Python module documents.
 *
 * ## What changed, and why
 *
 * Python uses the official `anthropic` and `openai` SDKs. This port calls the
 * HTTP APIs directly with `fetch` instead, because the whole point of the
 * extraction slice is removing the LlamaIndex dependency, and the two SDKs were
 * only ever used from inside LlamaIndex wrappers. Two consequences worth
 * stating:
 *
 * - The LlamaIndex workarounds the Python module had to carry do not exist
 *   here. `_embedding_kwargs_for_model` existed because
 *   `OpenAIEmbedding.__init__` validated `model` against a closed enum and
 *   rejected a gateway name like `hf:nomic-ai/nomic-embed-text-v1.5`, forcing
 *   the real name into a second `model_name` parameter. A direct HTTP call has
 *   no such enum, so {@link embedTexts} sends the configured model name as-is.
 *   Verified: the captured LlamaIndex request carried
 *   `{"input": [...], "model": "hf:nomic-ai/nomic-embed-text-v1.5"}`, and that
 *   is exactly the body this module sends.
 * - `_register_gateway_model` / `_GATEWAY_CONTEXT_WINDOW` existed because
 *   `OpenAILLM` resolved a context window from LlamaIndex's own model table and
 *   raised for unknown gateway names. Nothing here budgets tokens locally, so
 *   there is no table to teach.
 *
 * ## The wire shapes are measurements, not guesses
 *
 * Both request bodies and both response shapes below were captured from the
 * live LlamaIndex calls the Python oracle makes (method patched to record the
 * kwargs, then replayed). The capture is why the extraction request carries
 * `tool_choice: "required"`, `parallel_tool_calls: false`, `temperature: 0.1`
 * and `max_tokens: 4096`: those are LlamaIndex's defaults for the call
 * `SchemaLLMPathExtractor` makes, and changing any of them changes what the
 * model returns.
 */

/** Default `max_tokens` for a plain completion. Mirrors `complete()`'s default. */
const DEFAULT_MAX_TOKENS = 1024;

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
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Base URL of the Anthropic API, used when `EXTRACTION_PROVIDER=anthropic`. */
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Anthropic API version header, as the SDK sends it. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Failure from an LLM provider.
 *
 * Python lets the SDK's own exception escape. A dedicated error type keeps the
 * provider, the endpoint and the status available to the caller while making
 * the failure identifiable, which the route layer needs in order to answer 500
 * rather than crashing the process with an unhandled rejection.
 */
export class LlmError extends Error {
  /** HTTP status the provider answered with, when it answered at all. */
  readonly status: number | undefined;
  /** Endpoint that was called, for the error log. */
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// JSON narrowing helpers
//
// Responses are `unknown` until proven otherwise. These three helpers are the
// only places that inspect an untyped payload, and each returns `undefined`
// instead of asserting, so no path relies on an unchecked cast.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Reads a provider response body as JSON.
 *
 * A body that is not JSON is reported with the text truncated to 200 chars —
 * enough to identify a gateway error page, short enough not to flood a log.
 */
async function readJsonBody(response: Response, endpoint: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError(
      `${endpoint} returned a non-JSON body: ${JSON.stringify(text.slice(0, 200))}`,
      endpoint,
      response.status,
    );
  }
}

/**
 * Extracts the provider's error message from an error body.
 *
 * OpenAI-compatible gateways put it at `error.message`; Anthropic uses the same
 * path. Both are looked up the same way, and the raw body is the fallback.
 */
function providerErrorMessage(body: unknown): string {
  const record = asRecord(body);
  const error = record === undefined ? undefined : asRecord(record["error"]);
  return asString(error?.["message"]) ?? JSON.stringify(body).slice(0, 400);
}

/**
 * Issues a POST and fails loudly on a non-2xx answer.
 *
 * The check is here rather than at each call site so no provider path can
 * silently parse an error envelope as if it were a success payload.
 */
async function postJson(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // Transport failure: DNS, TLS, connection refused, aborted request.
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmError(`${endpoint} request failed: ${reason}`, endpoint);
  }

  const body = await readJsonBody(response, endpoint);
  if (!response.ok) {
    throw new LlmError(
      `${endpoint} answered ${String(response.status)}: ${providerErrorMessage(body)}`,
      endpoint,
      response.status,
    );
  }
  return { response, body };
}

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
interface ExtractionEndpoint {
  readonly endpoint: string;
  readonly apiKey: string;
}

function extractionEndpoint(): ExtractionEndpoint {
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
function embeddingEndpoint(): ExtractionEndpoint {
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
function chatMessageContent(body: unknown, endpoint: string): string {
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
function anthropicText(body: unknown, endpoint: string): string {
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

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Embeds `texts` in one batched request.
 *
 * One HTTP round trip for the whole batch, matching
 * `Settings.embed_model.get_text_embedding_batch(texts)` in Python: per-text
 * requests would multiply both latency and provider cost for a document that
 * chunks into a dozen pieces.
 *
 * The model name is sent verbatim from `config.EMBEDDING_MODEL`
 * (`hf:nomic-ai/nomic-embed-text-v1.5`), which is what the direct HTTP API
 * expects and what the LlamaIndex workaround in Python was working around.
 *
 * @returns one vector per input, in input order. Ordering is restored from each
 *   entry's `index` when the provider supplies it, because the gateway is not
 *   contractually ordered.
 * @throws {LlmError} when the provider fails, returns a count mismatch, or
 *   returns an entry that is not an array of numbers. A short vector is worse
 *   than a failure: it would be stored, and the pgvector column would reject it
 *   only after the transaction had already begun writing chunks.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const { endpoint, apiKey } = embeddingEndpoint();
  const { body } = await postJson(
    endpoint,
    { authorization: `Bearer ${apiKey}` },
    { model: config.EMBEDDING_MODEL, input: [...texts] },
  );

  const data = asArray(asRecord(body)?.["data"]);
  if (data === undefined) {
    throw new LlmError(`${endpoint} response has no data array`, endpoint);
  }
  if (data.length !== texts.length) {
    throw new LlmError(
      `${endpoint} returned ${String(data.length)} embeddings for ${String(texts.length)} inputs`,
      endpoint,
    );
  }

  const ordered = new Array<number[]>(texts.length);
  for (const [position, entry] of data.entries()) {
    const record = asRecord(entry);
    const embedding = asArray(record?.["embedding"]);
    if (embedding === undefined) {
      throw new LlmError(`${endpoint} returned an entry with no embedding`, endpoint);
    }
    const index = record?.["index"];
    const slot = typeof index === "number" ? index : position;
    if (!Number.isInteger(slot) || slot < 0 || slot >= texts.length) {
      throw new LlmError(
        `${endpoint} returned an out-of-range embedding index ${String(index)}`,
        endpoint,
      );
    }
    const vector: number[] = [];
    for (const component of embedding) {
      if (typeof component !== "number") {
        throw new LlmError(`${endpoint} returned a non-numeric embedding component`, endpoint);
      }
      vector.push(component);
    }
    ordered[slot] = vector;
  }

  for (const [position, vector] of ordered.entries()) {
    if (vector === undefined) {
      throw new LlmError(
        `${endpoint} returned no embedding for input ${String(position)}`,
        endpoint,
      );
    }
  }
  return ordered;
}

/**
 * Embeds a single query string.
 *
 * Same model as document chunks, so cosine distances are comparable with the
 * stored chunk vectors — the reason `embed_query` exists separately in Python
 * rather than callers reaching for the embedder themselves.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  if (vector === undefined) {
    throw new LlmError("embedding provider returned no vector for the query", "embeddings");
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Structured extraction via a required tool call
// ---------------------------------------------------------------------------

/** A tool the model is required to call. */
export interface ToolDefinition {
  /** Function name, e.g. `KGSchema`. */
  readonly name: string;
  /** Function description. */
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly parameters: Record<string, unknown>;
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
      {
        model: config.EXTRACTION_MODEL,
        max_tokens: maxTokens,
        temperature: EXTRACTION_TEMPERATURE,
        tools: [
          { name: tool.name, description: tool.description, input_schema: tool.parameters },
        ],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: prompt }],
      },
    );

    const content = asArray(asRecord(body)?.["content"]);
    for (const block of content ?? []) {
      const record = asRecord(block);
      if (record?.["type"] === "tool_use") {
        return JSON.stringify(record["input"] ?? {});
      }
    }
    throw new LlmError(`${endpoint} response has no tool_use block`, endpoint);
  }

  const { body } = await postJson(
    endpoint,
    { authorization: `Bearer ${apiKey}` },
    {
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
          },
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      max_tokens: maxTokens,
    },
  );

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
