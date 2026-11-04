/**
 * @file packages/llmwiki-kg/ts/src/wiki-credential-fallback.test.ts
 * @description Unit tests for the wiki-to-KG embedding credential bridge.
 *
 * The bridge is a pure function over an environment object, so every rule of
 * S2 (the derivation table), S3 (an explicit KG-side value wins) and S4 (the
 * four fail-closed messages) is observable directly: the bridged variables, the
 * input object left untouched, and the exact problem string.
 *
 * Nothing here reads `process.env`, opens a socket, or touches a database, and
 * every credential is obviously fake so a leak would be visible in any output.
 */

import { describe, expect, it } from "vitest";

import {
  bridgeEnvWithWikiCredentials,
  findEmbeddingCredentialProblem,
  resolveWikiEmbeddingEndpoint,
  resolveWikiEmbeddingKey,
  resolveWikiEmbeddingProvider,
  type EmbeddingCredentialConfig,
} from "./wiki-credential-fallback.js";
import { parseConfig } from "./config.js";

/** A fake credential, chosen so a leak is unmistakable in any message. */
const FAKE_KEY = "test-key-not-real";
/** A fake gateway endpoint; the `.invalid` TLD can never resolve. */
const FAKE_ENDPOINT = "https://gateway.invalid/v1";
/** A second endpoint, to prove which override wins. */
const OTHER_ENDPOINT = "https://other.invalid/v1";

/** A KG-side config carrying exactly the four variables the check reads. */
function kgConfig(
  overrides: Partial<EmbeddingCredentialConfig> = {},
): EmbeddingCredentialConfig {
  return {
    EMBEDDING_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    GATEWAY_URL: "",
    GATEWAY_API_KEY: "",
    ...overrides,
  };
}

describe("resolveWikiEmbeddingProvider", () => {
  it("prefers LLMWIKI_EMBEDDING_PROVIDER, trimmed and lowercased", () => {
    expect(
      resolveWikiEmbeddingProvider({
        LLMWIKI_EMBEDDING_PROVIDER: "  OpenAI ",
        LLMWIKI_PROVIDER: "ollama",
      }),
    ).toBe("openai");
  });

  it("falls back to LLMWIKI_PROVIDER, then to anthropic", () => {
    expect(resolveWikiEmbeddingProvider({ LLMWIKI_PROVIDER: "Ollama" })).toBe("ollama");
    expect(resolveWikiEmbeddingProvider({})).toBe("anthropic");
  });

  it("treats a whitespace-only value as absent", () => {
    expect(
      resolveWikiEmbeddingProvider({
        LLMWIKI_EMBEDDING_PROVIDER: "   ",
        LLMWIKI_PROVIDER: "openai",
      }),
    ).toBe("openai");
  });
});

describe("resolveWikiEmbeddingEndpoint and resolveWikiEmbeddingKey", () => {
  it("reads the embeddings override before the shared one", () => {
    const env = {
      OPENAI_EMBEDDINGS_BASE_URL: FAKE_ENDPOINT,
      OPENAI_BASE_URL: OTHER_ENDPOINT,
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
      OPENAI_API_KEY: "other-not-real",
    };
    expect(resolveWikiEmbeddingEndpoint(env)).toBe(FAKE_ENDPOINT);
    expect(resolveWikiEmbeddingKey(env)).toBe(FAKE_KEY);
  });

  it("falls back to the shared variable, then to nothing", () => {
    expect(resolveWikiEmbeddingEndpoint({ OPENAI_BASE_URL: OTHER_ENDPOINT })).toBe(
      OTHER_ENDPOINT,
    );
    expect(resolveWikiEmbeddingKey({ OPENAI_API_KEY: "other-not-real" })).toBe(
      "other-not-real",
    );
    expect(resolveWikiEmbeddingEndpoint({ OPENAI_BASE_URL: "  " })).toBeUndefined();
    expect(resolveWikiEmbeddingKey({})).toBeUndefined();
  });
});

describe("bridgeEnvWithWikiCredentials (S2)", () => {
  it("derives EMBEDDING_PROVIDER=openai from a wiki openai provider", () => {
    const bridged = bridgeEnvWithWikiCredentials({ LLMWIKI_EMBEDDING_PROVIDER: "openai" });
    expect(bridged.EMBEDDING_PROVIDER).toBe("openai");
  });

  it("derives gateway when the wiki openai provider has an endpoint override", () => {
    const viaEmbeddings = bridgeEnvWithWikiCredentials({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: FAKE_ENDPOINT,
    });
    const viaShared = bridgeEnvWithWikiCredentials({
      LLMWIKI_PROVIDER: "openai",
      OPENAI_BASE_URL: OTHER_ENDPOINT,
    });
    expect(viaEmbeddings.EMBEDDING_PROVIDER).toBe("gateway");
    expect(viaShared.EMBEDDING_PROVIDER).toBe("gateway");
  });

  it("derives no provider when the wiki provider has no kg equivalent", () => {
    const bridged = bridgeEnvWithWikiCredentials({ LLMWIKI_EMBEDDING_PROVIDER: "anthropic" });
    expect(bridged).not.toHaveProperty("EMBEDDING_PROVIDER");
  });

  it("derives OPENAI_API_KEY from the wiki embedding key for openai", () => {
    const bridged = bridgeEnvWithWikiCredentials({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
    });
    expect(bridged.OPENAI_API_KEY).toBe(FAKE_KEY);
  });

  it("derives GATEWAY_URL and GATEWAY_API_KEY for the derived gateway", () => {
    const bridged = bridgeEnvWithWikiCredentials({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: FAKE_ENDPOINT,
      OPENAI_BASE_URL: OTHER_ENDPOINT,
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
      OPENAI_API_KEY: "other-not-real",
    });
    expect(bridged.GATEWAY_URL).toBe(FAKE_ENDPOINT);
    expect(bridged.GATEWAY_API_KEY).toBe(FAKE_KEY);
  });

  it("copies unrelated variables through and never mutates its input", () => {
    const env: NodeJS.ProcessEnv = {
      EMBEDDING_MODEL: "text-embedding-3-small",
      DATABASE_URL: "postgresql://aks:aks@localhost:5432/aks",
      ANTHROPIC_API_KEY: FAKE_KEY,
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
    };
    const before = { ...env };
    const bridged = bridgeEnvWithWikiCredentials(env);

    expect(bridged.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(bridged.DATABASE_URL).toBe("postgresql://aks:aks@localhost:5432/aks");
    expect(bridged.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(bridged).not.toBe(env);
    expect(env).toEqual(before);
  });
});

describe("an explicit KG-side value still wins (S3)", () => {
  it("keeps every explicitly set KG variable, whatever the wiki side says", () => {
    const env: NodeJS.ProcessEnv = {
      EMBEDDING_PROVIDER: "gateway",
      OPENAI_API_KEY: "kg-own-openai-not-real",
      GATEWAY_URL: "https://kg-own.invalid/v1",
      GATEWAY_API_KEY: "kg-own-gateway-not-real",
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: FAKE_ENDPOINT,
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
    };
    const bridged = bridgeEnvWithWikiCredentials(env);

    expect(bridged.EMBEDDING_PROVIDER).toBe("gateway");
    expect(bridged.OPENAI_API_KEY).toBe("kg-own-openai-not-real");
    expect(bridged.GATEWAY_URL).toBe("https://kg-own.invalid/v1");
    expect(bridged.GATEWAY_API_KEY).toBe("kg-own-gateway-not-real");
  });

  it("counts a whitespace-only KG value as absent and fills it", () => {
    const bridged = bridgeEnvWithWikiCredentials({
      EMBEDDING_PROVIDER: "   ",
      OPENAI_API_KEY: "  ",
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
    });
    expect(bridged.EMBEDDING_PROVIDER).toBe("openai");
    expect(bridged.OPENAI_API_KEY).toBe(FAKE_KEY);
  });
});

describe("findEmbeddingCredentialProblem (S4)", () => {
  it("reports openai without an API key", () => {
    expect(
      findEmbeddingCredentialProblem(kgConfig(), { LLMWIKI_EMBEDDING_PROVIDER: "openai" }),
    ).toBe(
      "EMBEDDING_PROVIDER=openai but no API key is configured. Set OPENAI_API_KEY, " +
        "or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.",
    );
  });

  it("reports gateway without a URL", () => {
    const cfg = kgConfig({ EMBEDDING_PROVIDER: "gateway", GATEWAY_API_KEY: FAKE_KEY });
    expect(
      findEmbeddingCredentialProblem(cfg, { LLMWIKI_EMBEDDING_PROVIDER: "openai" }),
    ).toBe(
      "EMBEDDING_PROVIDER=gateway but GATEWAY_URL is not set. Set GATEWAY_URL, " +
        "or OPENAI_EMBEDDINGS_BASE_URL to reuse the wiki dimension's endpoint.",
    );
  });

  it("reports gateway with a URL but no key", () => {
    const cfg = kgConfig({ EMBEDDING_PROVIDER: "gateway", GATEWAY_URL: FAKE_ENDPOINT });
    expect(
      findEmbeddingCredentialProblem(cfg, { LLMWIKI_EMBEDDING_PROVIDER: "openai" }),
    ).toBe(
      "EMBEDDING_PROVIDER=gateway but GATEWAY_API_KEY is not set. Set GATEWAY_API_KEY, " +
        "or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.",
    );
  });

  it("reports a wiki provider that has no kg equivalent", () => {
    expect(
      findEmbeddingCredentialProblem(kgConfig(), { LLMWIKI_EMBEDDING_PROVIDER: "anthropic" }),
    ).toBe(
      'LLMWIKI_EMBEDDING_PROVIDER="anthropic" has no kg-dimension equivalent. ' +
        "The kg dimension embeds through EMBEDDING_PROVIDER=openai or gateway; " +
        "set one of those with its credential.",
    );
  });

  it("accepts the wiki credential once it has been bridged", () => {
    const env: NodeJS.ProcessEnv = {
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
    };
    const cfg = parseConfig(bridgeEnvWithWikiCredentials(env));
    expect(findEmbeddingCredentialProblem(cfg, env)).toBeNull();
  });

  it("keeps a working openai default when the wiki provider has no equivalent", () => {
    // Backward compatibility: a KG-side OPENAI_API_KEY with no EMBEDDING_PROVIDER
    // works today on the schema default, so a wiki setting with no kg equivalent
    // must not turn that into a failure.
    const cfg = kgConfig({ OPENAI_API_KEY: FAKE_KEY });
    expect(
      findEmbeddingCredentialProblem(cfg, { LLMWIKI_EMBEDDING_PROVIDER: "anthropic" }),
    ).toBeNull();
  });
});

describe("no secret exposure (S5)", () => {
  it("never puts a credential value in a problem message", () => {
    const env: NodeJS.ProcessEnv = {
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
    };
    const messages = [
      findEmbeddingCredentialProblem(kgConfig(), env),
      findEmbeddingCredentialProblem(
        kgConfig({ EMBEDDING_PROVIDER: "gateway", GATEWAY_API_KEY: FAKE_KEY }),
        env,
      ),
      findEmbeddingCredentialProblem(
        kgConfig({ EMBEDDING_PROVIDER: "gateway", GATEWAY_URL: FAKE_ENDPOINT }),
        env,
      ),
      findEmbeddingCredentialProblem(kgConfig(), {
        LLMWIKI_EMBEDDING_PROVIDER: "anthropic",
        OPENAI_EMBEDDINGS_API_KEY: FAKE_KEY,
      }),
    ];
    for (const message of messages) {
      expect(message).not.toBeNull();
      expect(message).not.toContain(FAKE_KEY);
    }
  });
});
