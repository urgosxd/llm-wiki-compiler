import { z } from "zod";

/**
 * Application configuration.
 *
 * TypeScript mirror of `app/core/config.py`. The Python module calls
 * `load_dotenv()` at import time and reads `os.getenv(...)` once into a
 * module-level singleton; this module does the same against `process.env`
 * (Node's own `--env-file` handles the .env loading normally done by dotenv).
 *
 * Every key name, default, type, and required/optional rule below is part of
 * the contract with the Python service and must not drift.
 */

/** `Literal["openai", "gateway"]` from config.py. */
export const EMBEDDING_PROVIDERS = ["openai", "gateway"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** `Literal["anthropic", "openai", "gateway"]` from config.py. */
export const EXTRACTION_PROVIDERS = [
  "anthropic",
  "openai",
  "gateway",
] as const;
export type ExtractionProvider = (typeof EXTRACTION_PROVIDERS)[number];

/**
 * Python lowercases the raw value before validating it:
 *   os.getenv("EMBEDDING_PROVIDER", "openai").lower()
 *
 * The default is applied to the raw string, never to the enum: an unset var
 * takes the Python default, while an explicitly empty or unknown value fails
 * fast instead of silently becoming the default provider.
 */
function providerFromEnv<const T extends readonly [string, ...string[]]>(
  allowed: T,
  fallback: T[number],
) {
  return z
    .string()
    .default(fallback)
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(allowed));
}

/**
 * Python dies at import on `int(os.getenv("EMBEDDING_DIM", "1536"))` when the
 * value is not numeric. Zod raises a clear, fail-fast issue for the same input
 * instead of silently falling back to the default.
 */
const IntegerFromEnv = z
  .string()
  .default("1536")
  .transform((value, ctx) => {
    // `int()` tolerates surrounding whitespace and an optional sign.
    if (!/^[+-]?\d+$/.test(value.trim())) {
      ctx.addIssue({
        code: "custom",
        message: `Expected an integer, received ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return Number.parseInt(value.trim(), 10);
  });

const EnvSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://aks:aks@localhost:5432/aks"),

  // Optional API key for protecting the server. Empty string = open mode.
  // Python applies `.strip()`, so surrounding whitespace is not a real key.
  AKS_API_KEY: z.string().default("").transform((value) => value.trim()),

  // Embedding configuration.
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: IntegerFromEnv,
  EMBEDDING_PROVIDER: providerFromEnv(EMBEDDING_PROVIDERS, "openai"),

  // Extraction / synthesis configuration.
  EXTRACTION_MODEL: z.string().default("claude-sonnet-4-5"),
  EXTRACTION_PROVIDER: providerFromEnv(EXTRACTION_PROVIDERS, "anthropic"),

  // Provider credentials. Only the ones your chosen providers use are needed.
  // Deliberately NOT stripped: Python reads these with bare `os.getenv`.
  OPENAI_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  GATEWAY_URL: z.string().default("").transform((value) => value.trim()),
  GATEWAY_API_KEY: z.string().default(""),

  /**
   * Whether to send `strict: true` in the tool definition.
   *
   * Defaults on for `openai`, where structured outputs are guaranteed, and off
   * everywhere else because the flag is an OpenAI extension: a gateway that does
   * not implement it may reject the whole request.
   *
   * Set this to `true` when the gateway is a provider that *does* support the
   * flag — an OpenAI-compatible endpoint that implements structured outputs. This
   * exists because "OpenAI-compatible" covers a wide range: some gateways proxy
   * OpenAI faithfully and honour `strict`, others accept the field and ignore it,
   * and a few reject unknown fields. Only the operator knows which one they run.
   *
   * `auto` keeps the provider default; `true`/`false` force it. An explicit
   * `false` on `openai` is a deliberate downgrade to advisory typing.
   */
  EXTRACTION_STRICT_SCHEMA: z
    .enum(["auto", "true", "false", "TRUE", "FALSE", "AUTO"])
    .default("auto")
    .transform((value) => value.toLowerCase() as "auto" | "true" | "false"),
});

/** Parsed env, plus the derived `auth_enabled` property from config.py. */
export interface Config extends z.infer<typeof EnvSchema> {
  /** True iff the stripped AKS_API_KEY is non-empty. */
  readonly authEnabled: boolean;
}

/**
 * Error raised by {@link validateConfig}. Python raises a plain `ValueError`;
 * a dedicated subclass keeps the exact message while staying identifiable.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Parses `env` into a {@link Config}. Throws a `ZodError` when a value cannot
 * satisfy the schema (unknown provider, non-numeric EMBEDDING_DIM).
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.parse(env);
  return { ...parsed, authEnabled: parsed.AKS_API_KEY !== "" };
}

/**
 * Validates that the chosen providers have the credentials they need.
 * Called at startup so misconfiguration fails fast with a clear message.
 *
 * The five checks below run in the same order, and raise the same messages,
 * as `Config.validate()` in the Python oracle.
 */
export function validateConfig(cfg: Config): void {
  if (cfg.EMBEDDING_PROVIDER === "openai" && !cfg.OPENAI_API_KEY) {
    throw new ConfigValidationError(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  }
  if (
    cfg.EMBEDDING_PROVIDER === "gateway" &&
    (!cfg.GATEWAY_URL || !cfg.GATEWAY_API_KEY)
  ) {
    throw new ConfigValidationError(
      "EMBEDDING_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  }
  if (cfg.EXTRACTION_PROVIDER === "anthropic" && !cfg.ANTHROPIC_API_KEY) {
    throw new ConfigValidationError(
      "EXTRACTION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set",
    );
  }
  if (cfg.EXTRACTION_PROVIDER === "openai" && !cfg.OPENAI_API_KEY) {
    throw new ConfigValidationError(
      "EXTRACTION_PROVIDER=openai but OPENAI_API_KEY is not set",
    );
  }
  if (
    cfg.EXTRACTION_PROVIDER === "gateway" &&
    (!cfg.GATEWAY_URL || !cfg.GATEWAY_API_KEY)
  ) {
    throw new ConfigValidationError(
      "EXTRACTION_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set",
    );
  }
}

/**
 * The config singleton. Read once at module load, exactly like
 * `config = Config()` after `load_dotenv()` in Python. Never re-read per
 * request; `auth_enabled` is derived here, not recomputed later.
 */
export const config: Config = parseConfig(process.env);
