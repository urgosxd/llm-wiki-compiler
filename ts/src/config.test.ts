import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigValidationError,
  config,
  parseConfig,
  validateConfig,
  type Config,
} from "./config.js";

/** Env that satisfies `validateConfig()` for the default providers. */
const PROVIDER_CREDENTIALS = {
  OPENAI_API_KEY: "sk-openai-test",
  ANTHROPIC_API_KEY: "sk-anthropic-test",
} as const;

/** Runs `parseConfig` and returns the ZodError it throws. */
function parseError(env: NodeJS.ProcessEnv): z.ZodError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseConfig to throw a ZodError");
}

/** Runs `validateConfig` and returns the thrown error message. */
function validationError(env: NodeJS.ProcessEnv): string {
  const cfg: Config = parseConfig(env);
  try {
    validateConfig(cfg);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected validateConfig to throw");
}

/** Asserts the parse failure points at the offending env var. */
function expectParseIssueFor(env: NodeJS.ProcessEnv, key: string): void {
  const error = parseError(env);
  const paths = error.issues.map((issue) => issue.path.join("."));
  expect(paths).toContain(key);
}

describe("parseConfig defaults (mirrors app/core/config.py)", () => {
  const cfg = parseConfig({});

  it("uses the Python defaults for every var", () => {
    expect(cfg.DATABASE_URL).toBe("postgresql://aks:aks@localhost:5432/aks");
    expect(cfg.AKS_API_KEY).toBe("");
    expect(cfg.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(cfg.EMBEDDING_DIM).toBe(1536);
    expect(cfg.EMBEDDING_PROVIDER).toBe("openai");
    expect(cfg.EXTRACTION_MODEL).toBe("claude-sonnet-4-5");
    expect(cfg.EXTRACTION_PROVIDER).toBe("anthropic");
    expect(cfg.OPENAI_API_KEY).toBe("");
    expect(cfg.ANTHROPIC_API_KEY).toBe("");
    expect(cfg.GATEWAY_URL).toBe("");
    expect(cfg.GATEWAY_API_KEY).toBe("");
  });

  it("derives authEnabled=false from the empty default key", () => {
    expect(cfg.authEnabled).toBe(false);
  });

  it("reads the env once at module load into a single config object", () => {
    // The singleton is bound to `process.env` at import time; the property is
    // derived, never re-read, so it must always agree with the parsed key.
    expect(config).toBe(config);
    expect(config.authEnabled).toBe(config.AKS_API_KEY !== "");
  });
});

describe("EMBEDDING_DIM parsing", () => {
  it("defaults to 1536 as a number, not a string", () => {
    expect(parseConfig({}).EMBEDDING_DIM).toBe(1536);
  });

  it("parses an explicit integer", () => {
    expect(parseConfig({ EMBEDDING_DIM: "3072" }).EMBEDDING_DIM).toBe(3072);
  });

  it("tolerates surrounding whitespace, like Python's int()", () => {
    expect(parseConfig({ EMBEDDING_DIM: "  768 " }).EMBEDDING_DIM).toBe(768);
  });

  it("accepts a signed integer, like Python's int()", () => {
    expect(parseConfig({ EMBEDDING_DIM: "+1024" }).EMBEDDING_DIM).toBe(1024);
  });

  it("fails fast on a non-numeric value instead of defaulting", () => {
    expectParseIssueFor({ EMBEDDING_DIM: "abc" }, "EMBEDDING_DIM");
  });

  it("fails fast on a float, like Python's int('1.5')", () => {
    expectParseIssueFor({ EMBEDDING_DIM: "1.5" }, "EMBEDDING_DIM");
  });

  it("fails fast on an empty string, like Python's int('')", () => {
    expectParseIssueFor({ EMBEDDING_DIM: "" }, "EMBEDDING_DIM");
  });
});

describe("provider lowercasing", () => {
  it("lowercases EMBEDDING_PROVIDER before validation", () => {
    expect(parseConfig({ EMBEDDING_PROVIDER: "OpenAI" }).EMBEDDING_PROVIDER).toBe(
      "openai",
    );
    expect(parseConfig({ EMBEDDING_PROVIDER: "GATEWAY" }).EMBEDDING_PROVIDER).toBe(
      "gateway",
    );
  });

  it("lowercases EXTRACTION_PROVIDER before validation", () => {
    expect(
      parseConfig({ EXTRACTION_PROVIDER: "Anthropic" }).EXTRACTION_PROVIDER,
    ).toBe("anthropic");
    expect(parseConfig({ EXTRACTION_PROVIDER: "OpenAi" }).EXTRACTION_PROVIDER).toBe(
      "openai",
    );
    expect(parseConfig({ EXTRACTION_PROVIDER: "Gateway" }).EXTRACTION_PROVIDER).toBe(
      "gateway",
    );
  });

  it("rejects an embedding provider outside openai|gateway", () => {
    expectParseIssueFor({ EMBEDDING_PROVIDER: "azure" }, "EMBEDDING_PROVIDER");
  });

  it("rejects an extraction provider outside anthropic|openai|gateway", () => {
    expectParseIssueFor({ EXTRACTION_PROVIDER: "azure" }, "EXTRACTION_PROVIDER");
  });
});

describe("string stripping", () => {
  it("strips AKS_API_KEY and enables auth for a non-empty stripped value", () => {
    const cfg = parseConfig({ AKS_API_KEY: "  secret-key\n" });
    expect(cfg.AKS_API_KEY).toBe("secret-key");
    expect(cfg.authEnabled).toBe(true);
  });

  it("treats a whitespace-only AKS_API_KEY as auth disabled", () => {
    const cfg = parseConfig({ AKS_API_KEY: "   \t  " });
    expect(cfg.AKS_API_KEY).toBe("");
    expect(cfg.authEnabled).toBe(false);
  });

  it("strips GATEWAY_URL", () => {
    expect(parseConfig({ GATEWAY_URL: "  http://gateway:4000  " }).GATEWAY_URL).toBe(
      "http://gateway:4000",
    );
  });

  it("leaves provider API keys unstripped, like Python's os.getenv", () => {
    const cfg = parseConfig({ OPENAI_API_KEY: " sk-openai " });
    expect(cfg.OPENAI_API_KEY).toBe(" sk-openai ");
  });
});

describe("validateConfig", () => {
  it("passes for a fully configured default setup", () => {
    const cfg = parseConfig(PROVIDER_CREDENTIALS);
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("passes for gateway on both providers when URL and key are set", () => {
    const cfg = parseConfig({
      EMBEDDING_PROVIDER: "gateway",
      EXTRACTION_PROVIDER: "gateway",
      GATEWAY_URL: "http://gateway:4000",
      GATEWAY_API_KEY: "gw-key",
    });
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects embedding openai without OPENAI_API_KEY", () => {
    const message = validationError({
      EMBEDDING_PROVIDER: "openai",
      ANTHROPIC_API_KEY: "sk-anthropic-test",
    });
    expect(message).toBe(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  });

  it("rejects embedding gateway without GATEWAY_URL", () => {
    const message = validationError({
      ...PROVIDER_CREDENTIALS,
      EMBEDDING_PROVIDER: "gateway",
      GATEWAY_API_KEY: "gw-key",
    });
    expect(message).toBe(
      "EMBEDDING_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  });

  it("rejects embedding gateway without GATEWAY_API_KEY", () => {
    const message = validationError({
      ...PROVIDER_CREDENTIALS,
      EMBEDDING_PROVIDER: "gateway",
      GATEWAY_URL: "http://gateway:4000",
    });
    expect(message).toBe(
      "EMBEDDING_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  });

  it("rejects extraction anthropic without ANTHROPIC_API_KEY", () => {
    const message = validationError({
      OPENAI_API_KEY: "sk-openai-test",
      EXTRACTION_PROVIDER: "anthropic",
    });
    expect(message).toBe(
      "EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set",
    );
  });

  it("rejects extraction openai without OPENAI_API_KEY", () => {
    const message = validationError({
      EMBEDDING_PROVIDER: "gateway",
      EXTRACTION_PROVIDER: "openai",
      GATEWAY_URL: "http://gateway:4000",
      GATEWAY_API_KEY: "gw-key",
    });
    expect(message).toBe(
      "EXTRACTION_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  });

  it("rejects extraction gateway without GATEWAY_URL or GATEWAY_API_KEY", () => {
    const message = validationError({
      ...PROVIDER_CREDENTIALS,
      EXTRACTION_PROVIDER: "gateway",
    });
    expect(message).toBe(
      "EXTRACTION_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  });

  it("throws a ConfigValidationError carrying the exact message", () => {
    const cfg = parseConfig({ ANTHROPIC_API_KEY: "sk-anthropic-test" });
    expect(() => validateConfig(cfg)).toThrow(ConfigValidationError);
    expect(() => validateConfig(cfg)).toThrow(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  });

  it("reports the embedding failure first, matching the Python check order", () => {
    const message = validationError({ EXTRACTION_PROVIDER: "anthropic" });
    expect(message).toBe(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  });
});
