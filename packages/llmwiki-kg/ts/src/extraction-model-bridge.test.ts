/**
 * @file packages/llmwiki-kg/ts/src/extraction-model-bridge.test.ts
 * @description Proves the kg dimension's EXTRACTION model reaches it from the
 * wiki's own `LLMWIKI_MODEL`, and that which variable supplied it is visible at
 * startup without a model id ever reaching a log.
 *
 * Kept apart from `wiki-credential-fallback.test.ts` on purpose: that file is
 * already at the size limit, and this is a second contract — the chat half of
 * the provider configuration, not the embedding half.
 *
 * Every rule is observed through the public interface: the value
 * `parseConfig(bridgeEnvWithWikiCredentials(env))` resolves, and the exact
 * startup line. Nothing reads `process.env`, no socket is opened, no database is
 * touched, and every id below is a fixture rather than a value from any live
 * deployment.
 */

import { describe, expect, it } from "vitest";

import { extractionModelSourceLine, parseConfig } from "./config.js";
import { bridgeEnvWithWikiCredentials } from "./wiki-credential-fallback.js";

/** The wiki-side chat model an OpenAI-compatible gateway is configured with. */
const WIKI_CHAT_MODEL = "qwen/qwen3.5-35b-a3b";
/** The same model as an operator who already knows the gateway's rule names it. */
const WIKI_CHAT_MODEL_PREFIXED = `hf:${WIKI_CHAT_MODEL}`;
/** The KG-side model an existing deployment pins for itself. */
const KG_OWN_MODEL = "claude-sonnet-4-6";
/** The model the KG schema has applied on its own while nobody named one. */
const SCHEMA_DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * The extraction model the KG config resolves from `env`.
 *
 * @param env - A complete, explicit environment; never modified.
 * @returns The model the extraction request would ask for.
 */
function resolvedExtractionModel(env: NodeJS.ProcessEnv): string {
  return parseConfig(bridgeEnvWithWikiCredentials(env)).EXTRACTION_MODEL;
}

describe("the extraction model is bridged from LLMWIKI_MODEL (S6.1)", () => {
  it("resolves the wiki's model with the gateway prefix applied", () => {
    expect(resolvedExtractionModel({ LLMWIKI_MODEL: WIKI_CHAT_MODEL })).toBe(
      WIKI_CHAT_MODEL_PREFIXED,
    );
  });
});

describe("a blank KG-side model counts as absent (S1, S2)", () => {
  it("fills a whitespace-only EXTRACTION_MODEL from the wiki side", () => {
    expect(
      resolvedExtractionModel({ EXTRACTION_MODEL: "   ", LLMWIKI_MODEL: WIKI_CHAT_MODEL }),
    ).toBe(WIKI_CHAT_MODEL_PREFIXED);
  });

  it("bridges nothing when the wiki value is blank, keeping the default", () => {
    expect(resolvedExtractionModel({ LLMWIKI_MODEL: "   " })).toBe(SCHEMA_DEFAULT_MODEL);
  });
});

describe("an explicit EXTRACTION_MODEL still wins, unchanged (S6.2)", () => {
  it("keeps the KG-side value byte for byte, with no prefix added", () => {
    const env: NodeJS.ProcessEnv = {
      EXTRACTION_MODEL: KG_OWN_MODEL,
      LLMWIKI_MODEL: WIKI_CHAT_MODEL,
    };

    expect(resolvedExtractionModel(env)).toBe(KG_OWN_MODEL);
  });
});

describe("the schema default still applies when nobody names a model (S6.3)", () => {
  it("resolves the unchanged default", () => {
    expect(resolvedExtractionModel({})).toBe(SCHEMA_DEFAULT_MODEL);
  });
});

describe("a wiki value carrying the prefix already is not prefixed twice (S6.4)", () => {
  it("resolves the wiki value exactly as written", () => {
    expect(resolvedExtractionModel({ LLMWIKI_MODEL: WIKI_CHAT_MODEL_PREFIXED })).toBe(
      WIKI_CHAT_MODEL_PREFIXED,
    );
  });
});

describe("the startup line names the source, never a value (S6.5)", () => {
  it("names EXTRACTION_MODEL when the operator set it", () => {
    expect(
      extractionModelSourceLine({
        EXTRACTION_MODEL: KG_OWN_MODEL,
        LLMWIKI_MODEL: WIKI_CHAT_MODEL,
      }),
    ).toBe("[AKS] Extraction model configuration source: EXTRACTION_MODEL");
  });

  it("names LLMWIKI_MODEL and that the prefix was applied", () => {
    expect(extractionModelSourceLine({ LLMWIKI_MODEL: WIKI_CHAT_MODEL })).toBe(
      "[AKS] Extraction model configuration source: LLMWIKI_MODEL, hf: prefix applied",
    );
  });

  it("names LLMWIKI_MODEL and that the prefix was already present", () => {
    expect(extractionModelSourceLine({ LLMWIKI_MODEL: WIKI_CHAT_MODEL_PREFIXED })).toBe(
      "[AKS] Extraction model configuration source: LLMWIKI_MODEL, hf: prefix already present",
    );
  });

  it("names the built-in default when nobody named a model", () => {
    expect(extractionModelSourceLine({})).toBe(
      "[AKS] Extraction model configuration source: built-in default",
    );
  });

  it("never contains a model id", () => {
    const lines = [
      extractionModelSourceLine({ EXTRACTION_MODEL: KG_OWN_MODEL }),
      extractionModelSourceLine({ LLMWIKI_MODEL: WIKI_CHAT_MODEL }),
      extractionModelSourceLine({ LLMWIKI_MODEL: WIKI_CHAT_MODEL_PREFIXED }),
      extractionModelSourceLine({}),
    ];

    for (const line of lines) {
      expect(line).not.toContain(WIKI_CHAT_MODEL);
      expect(line).not.toContain(KG_OWN_MODEL);
      expect(line).not.toContain(SCHEMA_DEFAULT_MODEL);
    }
  });
});
