/**
 * @file packages/llmwiki-kg/ts/src/extraction-model-bridge.pins.test.ts
 * @description Pins the two asymmetries the extraction-model bridge must never
 * grow past: the explicit `EXTRACTION_MODEL` never passes through the `hf:`
 * normalisation, the embedding model bridge stays a verbatim pass-through, and
 * the storage DSN stays un-bridged.
 *
 * These are PINS, not new behaviour: every assertion below holds on the tree that
 * introduced the bridge, and they exist so a later edit cannot quietly move the
 * normalisation onto a path that today reaches the provider unchanged.
 *
 * WHY THE EMBEDDING PIN IS NOT REDUNDANT. Every pre-existing embedding fixture is
 * spelled `"hf:nomic-ai/..."` — already prefixed — so a conditional `hf:` leak
 * into the embedding bridge produces an identical string and passes every
 * committed test. Only an uncommitted scratch differential caught it. The fixture
 * here is deliberately UNPREFIXED, which is the only shape that observes the leak.
 *
 * Every assertion goes through the public interface: the value
 * `parseConfig(bridgeEnvWithWikiCredentials(env))` resolves, or the bridged copy
 * itself. Nothing reads or writes `process.env`, no socket is opened, and every
 * id below is a fixture rather than a value from any live deployment.
 */

import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";
import { bridgeEnvWithWikiCredentials } from "./wiki-credential-fallback.js";

/** The wiki-side chat model an OpenAI-compatible gateway is configured with. */
const WIKI_CHAT_MODEL = "qwen/qwen3.5-35b-a3b";
/** An unprefixed embedding model: the only shape that can expose an `hf:` leak. */
const UNPREFIXED_EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
/** A KG-side model padded the way a copied `.env` line arrives, spaces and all. */
const PADDED_KG_MODEL = "  claude-sonnet-4-6  ";

/**
 * The config the KG resolves from `env`, bridged exactly as the singleton does.
 *
 * @param env - A complete, explicit environment; never modified.
 * @returns The parsed config, after the bridge.
 */
function resolvedConfig(env: NodeJS.ProcessEnv) {
  return parseConfig(bridgeEnvWithWikiCredentials(env));
}

describe("an explicit EXTRACTION_MODEL keeps its padding (S2a)", () => {
  it("resolves the operator's value byte for byte, untrimmed and unprefixed", () => {
    const env: NodeJS.ProcessEnv = {
      EXTRACTION_MODEL: PADDED_KG_MODEL,
      LLMWIKI_MODEL: WIKI_CHAT_MODEL,
    };

    expect(resolvedConfig(env).EXTRACTION_MODEL).toBe(PADDED_KG_MODEL);
  });
});

describe("the embedding model bridge stays verbatim (S5)", () => {
  it("resolves an unprefixed LLMWIKI_EMBEDDING_MODEL with no hf: applied", () => {
    const env: NodeJS.ProcessEnv = {
      LLMWIKI_EMBEDDING_MODEL: UNPREFIXED_EMBEDDING_MODEL,
      LLMWIKI_MODEL: WIKI_CHAT_MODEL,
    };

    expect(resolvedConfig(env).EMBEDDING_MODEL).toBe(UNPREFIXED_EMBEDDING_MODEL);
  });
});

describe("the storage DSN is never bridged (S5)", () => {
  it("leaves DATABASE_URL out of the bridged copy, so the schema default resolves", () => {
    const env: NodeJS.ProcessEnv = { LLMWIKI_MODEL: WIKI_CHAT_MODEL };
    const bridged = bridgeEnvWithWikiCredentials(env);

    expect(bridged.DATABASE_URL).toBeUndefined();
    expect(parseConfig(bridged).DATABASE_URL).toBe(parseConfig({}).DATABASE_URL);
  });
});
