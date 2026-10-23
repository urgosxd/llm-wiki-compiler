/**
 * @file packages/llmwiki-kg/ts/src/core/llm_clients.ts
 * @description LLM client factory and uniform completion interface — public surface.
 *
 * TypeScript port of `app/core/llm_clients.py`. Every LLM call in the server
 * goes through this module, so adding a provider is a one-file change here —
 * the same guarantee the Python module documents.
 *
 * The module was split into `src/core/llm/` to keep each file under the
 * project's size limits. It remains the single import site, so `extraction.ts`,
 * the page generator and the routes import `core/llm_clients.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Sampling constants + base URLs | `llm/constants.ts` |
 * | The provider failure type | `llm/errors.ts` |
 * | Endpoint + credential resolution | `llm/endpoints.ts` |
 * | JSON narrowing + POST transport | `llm/json.ts` |
 * | Plain text completion | `llm/complete.ts` |
 * | Batched embeddings | `llm/embeddings.ts` |
 * | Required tool calls | `llm/tool-call.ts` |
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

export {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_TEMPERATURE,
} from "./llm/constants.js";

export { LlmError } from "./llm/errors.js";

export { complete } from "./llm/complete.js";
export { embedTexts, embedQuery } from "./llm/embeddings.js";
export { callTool } from "./llm/tool-call.js";
export type { ToolDefinition } from "./llm/tool-call.js";
