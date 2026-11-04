/**
 * @file src/dimensions/kg/embedding-model-bridge.test.ts
 * @description Proves the kg dimension's embedding MODEL reaches it from the
 * wiki side, and that a model nobody chose is refused before any request.
 *
 * The environment below is the shape an OpenAI-compatible deployment actually
 * has: the chat host and the embeddings host are DIFFERENT, the wiki names the
 * embedding model, and the operator sets no kg-side variable at all. Resolution
 * is observed through the parsed KG config, which is the object the vendored
 * request path reads.
 *
 * No socket is opened, no database is touched, and every credential is fake.
 */

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../packages/llmwiki-kg/ts/src/config.js";
import {
  bridgeEnvWithWikiCredentials,
  findEmbeddingModelProblem,
} from "../../../packages/llmwiki-kg/ts/src/wiki-credential-fallback.js";

/** The wiki-side embedding model, 768-wide on the host that serves it. */
const WIKI_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** The chat host, which must never receive an embeddings request. */
const CHAT_ENDPOINT = "https://chat.invalid/api/v1";
/** The embeddings host, which is what the kg dimension has to reach. */
const EMBEDDINGS_ENDPOINT = "https://embed.invalid/openai/v1";

/** The deployment this feature serves: wiki configured, kg configured by nobody. */
const WIKI_ONLY_ENV: NodeJS.ProcessEnv = {
  LLMWIKI_PROVIDER: "openai",
  OPENAI_BASE_URL: CHAT_ENDPOINT,
  OPENAI_EMBEDDINGS_BASE_URL: EMBEDDINGS_ENDPOINT,
  OPENAI_API_KEY: "test-key-not-real-chat",
  OPENAI_EMBEDDINGS_API_KEY: "test-key-not-real-embed",
  LLMWIKI_EMBEDDING_MODEL: WIKI_MODEL,
};

/** The KG config this environment resolves to. */
function resolvedKgConfig(env: NodeJS.ProcessEnv = WIKI_ONLY_ENV) {
  return parseConfig(bridgeEnvWithWikiCredentials(env));
}

describe("the embedding model reaches the kg dimension from the wiki side (S2)", () => {
  it("resolves the wiki's embedding model with no kg-side variable set", () => {
    expect(resolvedKgConfig().EMBEDDING_MODEL).toBe(WIKI_MODEL);
  });

  it("reaches the embeddings endpoint rather than the chat one", () => {
    const config = resolvedKgConfig();

    expect(config.GATEWAY_URL).toBe(EMBEDDINGS_ENDPOINT);
    expect(config.GATEWAY_URL).not.toBe(CHAT_ENDPOINT);
  });

  it("inherits no model at all when the wiki never named one", () => {
    const { LLMWIKI_EMBEDDING_MODEL: _omitted, ...withoutModel } = WIKI_ONLY_ENV;
    const config = resolvedKgConfig(withoutModel);

    // The wiki's DEFAULT model is never mirrored: its width is the wiki's
    // business, and the kg column is 768 wide. So the run is refused instead.
    expect(findEmbeddingModelProblem(config.EMBEDDING_MODEL, withoutModel)).toContain("768");
    expect(config.EMBEDDING_MODEL).not.toBe(WIKI_MODEL);
  });
});
