import {
  bridgeEnvWithWikiCredentials,
  hasHfPrefix,
  isBlank,
  readPresent,
  WIKI_CHAT_MODEL_VARIABLE,
} from "./wiki-credential-fallback.js";
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
   * The embeddings half of the `gateway` provider.
   *
   * `GATEWAY_URL` used to name TWO services: the chat-completions host and the
   * embeddings host. A deployment whose two services live on different hosts
   * could therefore satisfy one and not the other, and no configuration could
   * satisfy both. These two variables name the embeddings service on its own,
   * following the `<PROVIDER>_EMBEDDINGS_BASE_URL` shape `OPENAI_EMBEDDINGS_BASE_URL`
   * already publishes.
   *
   * Both are blank by default and BLANK MEANS INHERIT: the embeddings endpoint
   * resolves from `GATEWAY_EMBEDDINGS_BASE_URL` when it is set and from
   * `GATEWAY_URL` otherwise, and the credential the same way. Upgrade changes
   * nothing for a deployment that sets only the old pair — which is every
   * deployment that exists today. See {@link resolveGatewayEmbeddings}.
   *
   * Trimmed like `GATEWAY_URL`, so a whitespace-only value cannot resolve to a
   * host, and `GATEWAY_EMBEDDINGS_API_KEY` trimmed where `GATEWAY_API_KEY` is
   * not, so "blank" answers the same question in both halves of the fallback.
   */
  GATEWAY_EMBEDDINGS_BASE_URL: z.string().default("").transform((value) => value.trim()),
  GATEWAY_EMBEDDINGS_API_KEY: z.string().default("").transform((value) => value.trim()),

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
 * The subset of the config {@link resolveGatewayEmbeddings} reads.
 *
 * Structural rather than `Config`, so the resolution can be exercised against a
 * literal in a test without building a whole config — and so the function states
 * exactly which four variables it is allowed to look at.
 */
export interface GatewayEmbeddingsEnv {
  readonly GATEWAY_URL: string;
  readonly GATEWAY_API_KEY: string;
  readonly GATEWAY_EMBEDDINGS_BASE_URL: string;
  readonly GATEWAY_EMBEDDINGS_API_KEY: string;
}

/** The variables the embeddings base URL can come from, most specific first. */
export type GatewayEmbeddingsUrlSource =
  | "GATEWAY_EMBEDDINGS_BASE_URL"
  | "GATEWAY_URL";

/** The variables the embeddings credential can come from, most specific first. */
export type GatewayEmbeddingsKeySource =
  | "GATEWAY_EMBEDDINGS_API_KEY"
  | "GATEWAY_API_KEY";

/** Where the `gateway` provider's embedding request goes, and which variables said so. */
export interface GatewayEmbeddingsResolution {
  /** Resolved base URL, or `""` when neither variable names one. */
  readonly baseUrl: string;
  /** Resolved credential, or `""` when neither variable names one. */
  readonly apiKey: string;
  /** Variable the base URL came from, or `undefined` when neither is set. */
  readonly baseUrlSource: GatewayEmbeddingsUrlSource | undefined;
  /** Variable the credential came from, or `undefined` when neither is set. */
  readonly apiKeySource: GatewayEmbeddingsKeySource | undefined;
}

/** `name`, or `undefined` when `value` is not a setting. */
function sourceOf<T extends string>(name: T, value: string): T | undefined {
  return isBlank(value) ? undefined : name;
}

/**
 * The embeddings endpoint and credential of the `gateway` provider.
 *
 * ONE resolution for the whole process, on purpose: `embeddingEndpoint()` builds
 * the URL from it, `validateConfig()` refuses a blank result from it, and the
 * startup line names the source variables it reports. Three sites reading the
 * fallback three ways is how a request ends up sent somewhere validation never
 * checked.
 *
 * The fallback happens HERE and nowhere else. `config` is never mutated: an
 * operator who leaves the new variables unset must keep a config that says so,
 * and nothing may write the inherited value back into it — that is what the
 * credential bridge does for its OWN variables and deliberately not for these
 * (see `KG_BRIDGED_VARIABLES`, which this must not grow).
 *
 * @param cfg - The parsed config, or any object carrying the four variables.
 * @returns The resolved endpoint, credential, and the variable behind each.
 */
export function resolveGatewayEmbeddings(
  cfg: GatewayEmbeddingsEnv,
): GatewayEmbeddingsResolution {
  const hasOwnUrl = !isBlank(cfg.GATEWAY_EMBEDDINGS_BASE_URL);
  const hasOwnKey = !isBlank(cfg.GATEWAY_EMBEDDINGS_API_KEY);
  return {
    baseUrl: hasOwnUrl ? cfg.GATEWAY_EMBEDDINGS_BASE_URL : cfg.GATEWAY_URL,
    apiKey: hasOwnKey ? cfg.GATEWAY_EMBEDDINGS_API_KEY : cfg.GATEWAY_API_KEY,
    baseUrlSource: hasOwnUrl
      ? "GATEWAY_EMBEDDINGS_BASE_URL"
      : sourceOf("GATEWAY_URL", cfg.GATEWAY_URL),
    apiKeySource: hasOwnKey
      ? "GATEWAY_EMBEDDINGS_API_KEY"
      : sourceOf("GATEWAY_API_KEY", cfg.GATEWAY_API_KEY),
  };
}

/**
 * The one startup line naming which variables supplied the gateway embeddings
 * endpoint and credential.
 *
 * WHY NAMES AND NOT VALUES. The inheritance above is a decision the operator did
 * not make, so it has to be observable rather than inferred: a deployment that
 * meant to split the endpoint and mistyped the variable name inherits the old
 * one silently, and the only symptom is a request to the wrong host. Printing
 * the two NAMES makes that self-evident; printing the values would put an
 * endpoint and a credential in a log file, which is the incident this whole
 * change is downstream of.
 *
 * One fixed-size line: it names at most two variables and never enumerates the
 * configuration, so it cannot grow into a config dump.
 *
 * @param cfg - The parsed config.
 * @returns The line, or `undefined` when no gateway embeddings endpoint applies.
 */
export function gatewayEmbeddingsSourceLine(cfg: Config): string | undefined {
  if (cfg.EMBEDDING_PROVIDER !== "gateway") return undefined;
  const { baseUrlSource, apiKeySource } = resolveGatewayEmbeddings(cfg);
  return (
    "[AKS] Gateway embeddings source: " +
    `endpoint ${baseUrlSource ?? "unset"}, credential ${apiKeySource ?? "unset"}`
  );
}

/**
 * The KG-side extraction-model variable, spelled as the schema above spells it.
 *
 * The line prints this name, so the literal is the output contract rather than a
 * lookup key; it stays beside the schema line that defines it.
 */
const EXTRACTION_MODEL_VARIABLE = "EXTRACTION_MODEL";

/**
 * The one startup line naming WHICH variable supplied the extraction model.
 *
 * WHY NAMES AND NOT VALUES. The extraction model is the second thing the
 * operator configures on the wiki side and the KG side consumes, so a deployment
 * that meant to pin its own model and mistyped the variable name silently
 * extracts with an inherited one — and the only symptom is a provider rejecting
 * a model id. Naming the source makes that self-evident; printing the value would
 * put a model id in a log file, and a model id is the thing the operator's
 * provider credentials are spent on.
 *
 * WHY EVERY CASE SAYS "configuration". This line reports what the CONFIGURATION
 * resolved, which is not always what a request sends. When the wiki dimension's
 * chat backend is injected into the kg dimension, `injectedChatModel()` returns
 * that backend's own model verbatim — unprefixed — and it takes precedence per
 * request (see `embedding-backend.ts`). A line a reader takes as "the model the
 * next request will use" would therefore be false in exactly the deployment this
 * bridge exists for, so each case names itself as the configuration-side
 * resolution and claims nothing about a request.
 *
 * WHY IT TAKES THE RAW ENVIRONMENT rather than the parsed config, unlike
 * {@link gatewayEmbeddingsSourceLine}. The bridge fills `EXTRACTION_MODEL` from
 * `LLMWIKI_MODEL` before the schema ever sees it, so the parsed config cannot say
 * which of the two names supplied the value it holds — the filled copy erases
 * exactly the distinction this line exists to report. One fixed-size line, and it
 * names at most one variable, so it cannot grow into a config dump.
 *
 * @param env - The environment the config resolves from, BEFORE bridging.
 * @returns The line, always present: every configuration has a model source.
 */
export function extractionModelSourceLine(env: NodeJS.ProcessEnv): string {
  const prefix = "[AKS] Extraction model configuration source: ";
  if (readPresent(env, EXTRACTION_MODEL_VARIABLE) !== undefined) {
    return `${prefix}${EXTRACTION_MODEL_VARIABLE}`;
  }
  const wikiModel = readPresent(env, WIKI_CHAT_MODEL_VARIABLE);
  if (wikiModel === undefined) return `${prefix}built-in default`;
  const prefixState = hasHfPrefix(wikiModel) ? "already present" : "applied";
  return `${prefix}${WIKI_CHAT_MODEL_VARIABLE}, hf: prefix ${prefixState}`;
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
 * Refusal raised when the gateway embeddings endpoint or credential is blank
 * AFTER the fallback, naming both chains so the reader learns which variables
 * can supply each half.
 */
const GATEWAY_EMBEDDINGS_PROBLEM =
  "EMBEDDING_PROVIDER=gateway but GATEWAY_EMBEDDINGS_BASE_URL or GATEWAY_URL is not set, " +
  "or GATEWAY_EMBEDDINGS_API_KEY or GATEWAY_API_KEY is not set";

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
  // The embeddings arm judges the RESOLVED pair, not the old variables: a
  // deployment that names only `GATEWAY_EMBEDDINGS_BASE_URL` and
  // `GATEWAY_EMBEDDINGS_API_KEY` is configured, and refusing it because
  // `GATEWAY_URL` is blank would undo the split. Blankness is still refused
  // after resolution, which is where it matters — an empty base URL would
  // otherwise resolve to "/embeddings", a relative request to nowhere.
  const embeddings = resolveGatewayEmbeddings(cfg);
  if (
    cfg.EMBEDDING_PROVIDER === "gateway" &&
    (isBlank(embeddings.baseUrl) || isBlank(embeddings.apiKey))
  ) {
    throw new ConfigValidationError(GATEWAY_EMBEDDINGS_PROBLEM);
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
 * The config singleton. Resolved ONCE, on FIRST ACCESS, from the bridged
 * environment — the same "read the environment once" rule as
 * `config = Config()` after `load_dotenv()` in Python. Never re-read per
 * request or per call: `authEnabled` is derived at that first resolution, not
 * recomputed later.
 *
 * WHY FIRST ACCESS AND NOT IMPORT. llmwiki loads the project `.env` into
 * `process.env` after this module graph has been evaluated, and the bundle that
 * carries this module is evaluated before the CLI entry body runs at all.
 * Snapshotting `process.env`
 * here made a `.env` invisible to the KG side, so the credentials the wiki
 * dimension already had never reached the bridge. Resolving on first access
 * moves the snapshot to where the environment is complete: a dimension running,
 * or the standalone server starting.
 *
 * The environment is bridged first, so a value the wiki dimension already
 * configures (an embedding key, a provider, an endpoint) is visible to the KG
 * side without being duplicated in a second namespace. The bridge only fills
 * absences: an explicitly set KG-side variable reaches the schema unchanged.
 */
export const config: Config = lazyConfig();

/** The resolved singleton, kept for the rest of the process once produced. */
let resolvedConfig: Config | undefined;

/** Resolve the singleton once, from the environment as it is at first access. */
function resolveConfig(): Config {
  resolvedConfig ??= parseConfig(bridgeEnvWithWikiCredentials(process.env));
  return resolvedConfig;
}

/**
 * The {@link Config} stand-in that defers resolution to the first read.
 *
 * A proxy rather than one accessor per key, because the schema — not this
 * module — decides which keys exist. Every reflection path a caller can take
 * (`config.KEY`, spread, `in`, `Object.keys`) is answered from the resolved
 * object, so no consumer has to know the singleton is deferred.
 */
function lazyConfig(): Config {
  return new Proxy({} as Config, {
    get: (_target, property) => Reflect.get(resolveConfig(), property),
    has: (_target, property) => Reflect.has(resolveConfig(), property),
    ownKeys: () => Reflect.ownKeys(resolveConfig()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(resolveConfig(), property),
  });
}
