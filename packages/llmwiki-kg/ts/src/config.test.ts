import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigValidationError,
  config,
  gatewayEmbeddingsSourceLine,
  parseConfig,
  resolveGatewayEmbeddings,
  validateConfig,
  type Config,
} from "./config.js";

/** Env that satisfies `validateConfig()` for the default providers. */
const PROVIDER_CREDENTIALS = {
  OPENAI_API_KEY: "sk-openai-test",
  ANTHROPIC_API_KEY: "sk-anthropic-test",
} as const;

/** The exact refusal a blank RESOLVED gateway embeddings pair raises. */
const GATEWAY_EMBEDDINGS_PROBLEM =
  "EMBEDDING_PROVIDER=gateway but GATEWAY_EMBEDDINGS_BASE_URL or GATEWAY_URL is not set, " +
  "or GATEWAY_EMBEDDINGS_API_KEY or GATEWAY_API_KEY is not set";

/**
 * A gateway embeddings config, so a case states only the variable it varies.
 *
 * @param overrides - Variables this case is about.
 * @returns The parsed config for the gateway provider.
 */
function gatewayConfig(overrides: NodeJS.ProcessEnv): Config {
  return parseConfig({
    ...PROVIDER_CREDENTIALS,
    EMBEDDING_PROVIDER: "gateway",
    GATEWAY_URL: "http://gateway:4000",
    GATEWAY_API_KEY: "gw-key",
    ...overrides,
  });
}

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
    expect(cfg.GATEWAY_EMBEDDINGS_BASE_URL).toBe("");
    expect(cfg.GATEWAY_EMBEDDINGS_API_KEY).toBe("");
  });

  it("derives authEnabled=false from the empty default key", () => {
    expect(cfg.authEnabled).toBe(false);
  });

  it("resolves the env once, at first access, into a single config object", () => {
    // The singleton parses the environment on the first property read and keeps
    // the result; the property is derived then, never re-read, so it must always
    // agree with the parsed key.
    expect(config).toBe(config);
    expect(config.authEnabled).toBe(config.AKS_API_KEY !== "");
  });
});

describe("the config singleton and the wiki credential bridge (S2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("bridges a missing KG key from the wiki embedding key before first access", async () => {
    // WHY A RELOAD: the singleton resolves the bridged environment on its first
    // property read, so the only way to observe the bridge on a fresh instance is
    // to import it again with the wiki-side variables in place. A config that
    // ignored the bridge would still report an empty OPENAI_API_KEY here.
    vi.resetModules();
    // Unset, not blanked: the bridge DERIVES `EMBEDDING_PROVIDER` only when the
    // KG side left it absent, and this suite is run with the provider selectors
    // pinned in the caller's shell (a vendor-name provider in a gate command is
    // what once sent a real credential to `api.openai.com`). Without this the
    // ambient `EMBEDDING_PROVIDER` decides what the bridge is allowed to derive.
    vi.stubEnv("EMBEDDING_PROVIDER", undefined);
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_EMBEDDINGS_API_KEY", "test-key-not-real");

    const reloaded = await import("./config.js");
    expect(reloaded.config.OPENAI_API_KEY).toBe("test-key-not-real");
    expect(reloaded.config.EMBEDDING_PROVIDER).toBe("openai");
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

  it("strips GATEWAY_EMBEDDINGS_BASE_URL, so spaces cannot name a host", () => {
    const cfg = parseConfig({
      GATEWAY_EMBEDDINGS_BASE_URL: "  http://embed:4000/v1  ",
    });
    expect(cfg.GATEWAY_EMBEDDINGS_BASE_URL).toBe("http://embed:4000/v1");
  });

  it("strips GATEWAY_EMBEDDINGS_API_KEY, so a blank key inherits", () => {
    // The inherited `GATEWAY_API_KEY` is deliberately NOT stripped (Python reads
    // it with bare `os.getenv`), but the new variable has to answer "is this
    // blank?" the same way its base URL does, or the fallback splits in two.
    const key = (value: string) =>
      parseConfig({ GATEWAY_EMBEDDINGS_API_KEY: value }).GATEWAY_EMBEDDINGS_API_KEY;
    expect(key("  key-not-real  ")).toBe("key-not-real");
    expect(key("   ")).toBe("");
  });

  it("leaves provider API keys unstripped, like Python's os.getenv", () => {
    const cfg = parseConfig({ OPENAI_API_KEY: " sk-openai " });
    expect(cfg.OPENAI_API_KEY).toBe(" sk-openai ");
  });
});

describe("validateConfig judges the RESOLVED gateway embeddings pair (S8)", () => {
  /**
   * Gateway env with BOTH old variables blank.
   *
   * The cases below vary exactly one thing from here, and they are written as
   * environments rather than as parsed configs on purpose: `parseConfig` reads an
   * environment, so handing it a `Config` re-parses `EMBEDDING_DIM` as a number
   * and throws a ZodError before `validateConfig` is ever reached.
   */
  const GATEWAY_BLANK: NodeJS.ProcessEnv = {
    ...PROVIDER_CREDENTIALS,
    EMBEDDING_PROVIDER: "gateway",
    GATEWAY_URL: "",
    GATEWAY_API_KEY: "",
  };

  it("refuses a blank resolved pair, keeping the fail-fast refusal", () => {
    expect(validationError(GATEWAY_BLANK)).toBe(GATEWAY_EMBEDDINGS_PROBLEM);
  });

  it("refuses a resolved endpoint with no credential behind it", () => {
    // Neither variable supplied the key: the URL cannot stand alone, and the
    // refusal has to fire BEFORE the first request rather than as a 401 later.
    const borrowed: NodeJS.ProcessEnv = {
      ...GATEWAY_BLANK,
      GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:4000/v1",
    };
    expect(validationError(borrowed)).toBe(GATEWAY_EMBEDDINGS_PROBLEM);
  });

  it("accepts a pair resolved entirely from the new variables", () => {
    // The old variables are blank on purpose: an upgrade that names only the
    // split pair is configured, and refusing it because `GATEWAY_URL` is unset
    // would undo the split it just made.
    const split: NodeJS.ProcessEnv = {
      ...GATEWAY_BLANK,
      GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:4000/v1",
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    };
    expect(() => validateConfig(parseConfig(split))).not.toThrow();
  });

  it("does not let the new variables satisfy the extraction arm", () => {
    // The chat host is a different service: a credential for the embeddings host
    // does not authenticate a chat request, and a check that accepted it would
    // turn a 401 at the wrong host into a startup that looks healthy.
    const split: NodeJS.ProcessEnv = {
      ...GATEWAY_BLANK,
      EXTRACTION_PROVIDER: "gateway",
      GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:4000/v1",
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    };
    expect(validationError(split)).toBe(
      "EXTRACTION_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  });
});

describe("the startup source line (S5)", () => {
  it("names the old pair when the new variables are unset", () => {
    expect(gatewayEmbeddingsSourceLine(gatewayConfig({}))).toBe(
      "[AKS] Gateway embeddings source: endpoint GATEWAY_URL, credential GATEWAY_API_KEY",
    );
  });

  it("names the new variables when they resolve their half", () => {
    const split = gatewayConfig({
      GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:4000/v1",
      GATEWAY_EMBEDDINGS_API_KEY: "embed-key",
    });
    expect(gatewayEmbeddingsSourceLine(split)).toBe(
      "[AKS] Gateway embeddings source: endpoint GATEWAY_EMBEDDINGS_BASE_URL, " +
        "credential GATEWAY_EMBEDDINGS_API_KEY",
    );
  });

  it("names each half independently, and no value ever", () => {
    const line = gatewayEmbeddingsSourceLine(
      gatewayConfig({ GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:4000/v1" }),
    );
    expect(line).toContain("endpoint GATEWAY_EMBEDDINGS_BASE_URL");
    expect(line).toContain("credential GATEWAY_API_KEY");
    // Same source variables, different values: the line must not change, which
    // is the strongest way to say "names, never values".
    const other = gatewayConfig({
      GATEWAY_URL: "http://gateway:5000/elsewhere",
      GATEWAY_API_KEY: "another-key-not-real",
      GATEWAY_EMBEDDINGS_BASE_URL: "http://embed:5000/other",
    });
    expect(gatewayEmbeddingsSourceLine(other)).toBe(line);
  });
});

describe("the startup source line only exists for a gateway endpoint", () => {
  it("says nothing when embeddings do not come from a gateway", () => {
    const openai = gatewayConfig({ EMBEDDING_PROVIDER: "openai" });
    expect(gatewayEmbeddingsSourceLine(openai)).toBeUndefined();
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

  it("rejects embedding gateway without any endpoint", () => {
    const message = validationError({
      ...PROVIDER_CREDENTIALS,
      EMBEDDING_PROVIDER: "gateway",
      GATEWAY_API_KEY: "gw-key",
    });
    expect(message).toBe(GATEWAY_EMBEDDINGS_PROBLEM);
  });

  it("rejects embedding gateway without any credential", () => {
    const message = validationError({
      ...PROVIDER_CREDENTIALS,
      EMBEDDING_PROVIDER: "gateway",
      GATEWAY_URL: "http://gateway:4000",
    });
    expect(message).toBe(GATEWAY_EMBEDDINGS_PROBLEM);
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

/**
 * The RESOLUTION behind the gateway embeddings endpoint, one half at a time.
 *
 * A URL that looks right is not evidence about WHICH variable supplied it, which is
 * why the startup line names the source variables: the fallback is a decision the
 * operator did not make, and a mistyped variable name inherits the old one silently.
 * The two cases below are the two ways the halves can disagree. Hosts are `.invalid`
 * (RFC 6761: never resolvable, never routed) and every key is a fake literal.
 */
describe("the gateway embeddings split resolves each half on its own", () => {
  /** Chat host fixture: never resolves. */
  const CHAT_BASE_URL = "https://chat.invalid/api/v1";
  /** Embeddings host fixture: a different host from {@link CHAT_BASE_URL}. */
  const EMBEDDINGS_BASE_URL = "https://embeddings.invalid/openai/v1";
  /** The fake chat credential; only the NAME it came from is asserted. */
  const CHAT_KEY = "chat-key-not-real";

  it("treats whitespace-only embeddings halves as unset even when the schema is bypassed", () => {
    // `parseConfig` trims both embeddings variables, so spaces never survive it.
    // This probe BYPASSES the schema on purpose: a resolver written as a truthiness
    // check on the raw value would treat "   " as a host and post to "   /embeddings",
    // leaving the schema as the only thing between that and production.
    const resolution = resolveGatewayEmbeddings({
      GATEWAY_URL: CHAT_BASE_URL,
      GATEWAY_API_KEY: CHAT_KEY,
      GATEWAY_EMBEDDINGS_BASE_URL: "   ",
      GATEWAY_EMBEDDINGS_API_KEY: "\t\n ",
    });

    expect(resolution).toEqual({
      baseUrl: CHAT_BASE_URL,
      apiKey: CHAT_KEY,
      baseUrlSource: "GATEWAY_URL",
      apiKeySource: "GATEWAY_API_KEY",
    });
  });

  it("PINNED HAZARD: setting the embeddings URL alone sends the GATEWAY_API_KEY credential to the embeddings host", () => {
    // Not a bug report, a TRIPWIRE. One URL and one key name one service each:
    // moving the host while the credential stays behind is exactly how a working key
    // reaches a host it was never issued for, and the 401 that follows accuses the
    // wrong side. The docs warn about it; this case makes the warning executable, so
    // a later "fix" to the inherited credential has to confront the documentation.
    const resolution = resolveGatewayEmbeddings({
      GATEWAY_URL: CHAT_BASE_URL,
      GATEWAY_API_KEY: CHAT_KEY,
      GATEWAY_EMBEDDINGS_BASE_URL: EMBEDDINGS_BASE_URL,
      GATEWAY_EMBEDDINGS_API_KEY: "",
    });

    expect(resolution.baseUrl).toBe(EMBEDDINGS_BASE_URL);
    expect(resolution.baseUrlSource).toBe("GATEWAY_EMBEDDINGS_BASE_URL");
    // The credential was NOT split, and the source NAME says so: a deployment in
    // this state logs `GATEWAY_API_KEY`, which is the visible half of the hazard.
    expect(resolution.apiKey).toBe(CHAT_KEY);
    expect(resolution.apiKeySource).toBe("GATEWAY_API_KEY");
  });
});
