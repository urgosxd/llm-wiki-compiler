/**
 * @file packages/llmwiki-kg/ts/src/wiki-credential-fallback.ts
 * @description Bridges the wiki dimension's embedding credentials into the KG
 * dimension's own provider namespace, and reports the cases it cannot bridge.
 *
 * ## Why this module exists
 *
 * The vendored core resolves its providers from `EMBEDDING_PROVIDER`,
 * `OPENAI_API_KEY`, `GATEWAY_URL` and `GATEWAY_API_KEY`; the compiler's wiki
 * dimension resolves the same credentials from `LLMWIKI_*` and the loosely
 * named `OPENAI_*` variables. Enabling the `kg` dimension next to `wiki` used
 * to fail against the provider before it reached the database, because the
 * second namespace was empty. One credential source for both dimensions is the
 * whole point: the operator configures the wiki and the graph follows.
 *
 * ## What is bridged, and what deliberately is not
 *
 * Only the five variables above. `EMBEDDING_DIM`, `EXTRACTION_*`, `DATABASE_URL`
 * and `AKS_API_KEY` describe storage shape or unrelated credentials and keep
 * their own resolution: deriving them from the wiki side would silently reshape
 * the graph to match the wiki.
 *
 * `EMBEDDING_MODEL` is bridged, but ONLY from a value the operator actually
 * named (`LLMWIKI_EMBEDDING_MODEL`). The wiki's own default table is never
 * mirrored: those defaults are 1536-wide for an OpenAI endpoint, and the kg
 * embedding columns are `vector(768)`, so inheriting a default would inherit an
 * unusable model. No named model means no bridged model, and
 * {@link findEmbeddingModelProblem} refuses the run instead.
 *
 * ## Precedence, which is backward compatibility first
 *
 * An explicitly configured KG-side value ALWAYS wins: a deployment that already
 * sets `EMBEDDING_PROVIDER` or a credential keeps exactly the behaviour it has
 * today. The bridge only fills absences, never overwrites, never merges. Where
 * a value is absent, it is derived from the wiki side per the table documented
 * on {@link bridgeEnvWithWikiCredentials}.
 *
 * ## Why the failure is a message rather than a raw provider error
 *
 * A missing or partial credential has to name the variable the operator must
 * set. A 401 from a remote API, or a stack trace, tells them nothing about
 * which of the two namespaces is empty. {@link findEmbeddingCredentialProblem}
 * answers that question and never includes a credential VALUE.
 */

/** The four KG-side variables that configure the embedding BACKEND itself. */
const KG_PROVIDER = "EMBEDDING_PROVIDER";
const KG_OPENAI_KEY = "OPENAI_API_KEY";
const KG_GATEWAY_URL = "GATEWAY_URL";
const KG_GATEWAY_API_KEY = "GATEWAY_API_KEY";
/** The KG-side variable that names the embedding model to request. */
const KG_MODEL = "EMBEDDING_MODEL";

/**
 * The KG-side variables that configure the embedding backend: provider, endpoint
 * and credentials.
 *
 * EXPORTED because "the operator configured this side itself" is decided by
 * exactly this set, and a second list of the same names would be a second answer
 * to the same question. `EMBEDDING_MODEL` is deliberately NOT a member: naming a
 * model does not tell the kg dimension where to send the request.
 */
export const KG_BACKEND_VARIABLES = [
  KG_PROVIDER,
  KG_OPENAI_KEY,
  KG_GATEWAY_URL,
  KG_GATEWAY_API_KEY,
] as const;

/**
 * Every KG-side variable this module fills, in the order the table documents.
 *
 * EXPORTED AS THE SINGLE SOURCE OF TRUTH for the conformance check against the
 * wiki dimension's own variable tables. The test derives the names the wiki side
 * publishes and asserts this bridge honours exactly those, so a rename or a new
 * override on either side has to fail a test instead of drifting silently.
 */
export const KG_BRIDGED_VARIABLES = [...KG_BACKEND_VARIABLES, KG_MODEL] as const;

/** Wiki-side sources, most- to least-specific. */
const WIKI_EMBEDDING_PROVIDER = "LLMWIKI_EMBEDDING_PROVIDER";
const WIKI_PROVIDER = "LLMWIKI_PROVIDER";
const WIKI_EMBEDDING_KEY = "OPENAI_EMBEDDINGS_API_KEY";
const WIKI_EMBEDDING_ENDPOINT = "OPENAI_EMBEDDINGS_BASE_URL";
const WIKI_SHARED_ENDPOINT = "OPENAI_BASE_URL";
/** The model the operator named for the wiki dimension's embeddings. */
const WIKI_EMBEDDING_MODEL = "LLMWIKI_EMBEDDING_MODEL";
/**
 * Width of the kg dimension's `vector(768)` embedding columns (`schema.ts`).
 *
 * Postgres rejects a vector of any other width, and it does so only once the
 * chunk write has begun, so the width is judged before the first request.
 */
const EMBEDDING_COLUMN_WIDTH = 768;

/** The wiki provider assumed when neither provider variable is set. */
const WIKI_PROVIDER_DEFAULT = "anthropic";
/** The KG provider whose credential is a single API key. */
const OPENAI = "openai";
/** The KG provider whose credential is an endpoint plus a key. */
const GATEWAY = "gateway";

/** The exact fail-closed messages S4 fixes, one per unusable configuration. */
const OPENAI_KEY_PROBLEM =
  `EMBEDDING_PROVIDER=${OPENAI} but no API key is configured. ` +
  `Set ${KG_OPENAI_KEY}, or ${WIKI_EMBEDDING_KEY} to reuse the wiki dimension's credential.`;
const GATEWAY_URL_PROBLEM =
  `EMBEDDING_PROVIDER=${GATEWAY} but ${KG_GATEWAY_URL} is not set. ` +
  `Set ${KG_GATEWAY_URL}, or ${WIKI_EMBEDDING_ENDPOINT} to reuse the wiki dimension's endpoint.`;
const GATEWAY_KEY_PROBLEM =
  `EMBEDDING_PROVIDER=${GATEWAY} but ${KG_GATEWAY_API_KEY} is not set. ` +
  `Set ${KG_GATEWAY_API_KEY}, or ${WIKI_EMBEDDING_KEY} to reuse the wiki dimension's credential.`;

/**
 * The subset of the parsed config the credential check reads.
 *
 * Structural rather than an import of `Config`, so this module stays free of a
 * circular dependency on the config module that calls into it. `DEFAULT`
 * callers pass the parsed singleton, which satisfies it.
 */
export interface EmbeddingCredentialConfig {
  readonly EMBEDDING_PROVIDER: string;
  readonly OPENAI_API_KEY: string;
  readonly GATEWAY_URL: string;
  readonly GATEWAY_API_KEY: string;
}

/**
 * True for a value that is absent, empty, or whitespace-only.
 *
 * Every rule in this module treats those identically: an empty string is not a
 * credential, and a variable holding spaces is not a configured provider.
 *
 * Exported because the injected-backend precedence in `embedding-backend.ts`
 * judges blankness the same way; two definitions of "blank" would be two
 * answers to the same question.
 *
 * @param value - A raw environment or config string.
 * @returns True when the value cannot be used as a setting.
 */
export function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * The raw value of `name`, or `undefined` when it is blank.
 *
 * Exported for the same reason as {@link isBlank}: the injected-backend
 * precedence has to read the operator's own choices exactly as the bridge does.
 *
 * @param env - Environment to read; never modified.
 * @param name - Variable name.
 * @returns The value as configured, or `undefined` when absent or blank.
 */
export function readPresent(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return isBlank(value) ? undefined : value;
}

/**
 * The provider name the wiki dimension embeds with.
 *
 * `LLMWIKI_EMBEDDING_PROVIDER` overrides `LLMWIKI_PROVIDER`; with neither set
 * the answer is `anthropic`, which has no kg-dimension equivalent at all.
 *
 * @param env - Environment to read; never modified.
 * @returns The resolved wiki embedding provider, trimmed and lowercased.
 */
export function resolveWikiEmbeddingProvider(env: NodeJS.ProcessEnv): string {
  const configured =
    readPresent(env, WIKI_EMBEDDING_PROVIDER) ?? readPresent(env, WIKI_PROVIDER);
  if (configured === undefined) return WIKI_PROVIDER_DEFAULT;
  return configured.trim().toLowerCase();
}

/**
 * The endpoint the wiki dimension's OpenAI-compatible embeddings use, if any.
 *
 * @param env - Environment to read; never modified.
 * @returns The configured endpoint, or `undefined` when none is set.
 */
export function resolveWikiEmbeddingEndpoint(
  env: NodeJS.ProcessEnv,
): string | undefined {
  return readPresent(env, WIKI_EMBEDDING_ENDPOINT) ?? readPresent(env, WIKI_SHARED_ENDPOINT);
}

/**
 * The key the wiki dimension's embeddings authenticate with, if any.
 *
 * `OPENAI_EMBEDDINGS_API_KEY` is the embeddings-specific override; the shared
 * `OPENAI_API_KEY` is what most installations set, and it is the same variable
 * the KG side reads, so this fallback rarely fires.
 *
 * @param env - Environment to read; never modified.
 * @returns The configured key, or `undefined` when none is set.
 */
export function resolveWikiEmbeddingKey(env: NodeJS.ProcessEnv): string | undefined {
  return readPresent(env, WIKI_EMBEDDING_KEY) ?? readPresent(env, KG_OPENAI_KEY);
}

/**
 * The KG provider the wiki side implies, or `undefined` when it implies none.
 *
 * A wiki `openai` provider becomes `gateway` when the wiki points its
 * embeddings at an explicit endpoint — the same service, reached the way the KG
 * already knows how to reach it — and `openai` otherwise.
 *
 * @param env - Environment to read; never modified.
 * @param wikiProvider - The value {@link resolveWikiEmbeddingProvider} returned.
 * @returns The provider to derive, or `undefined` for a wiki provider with no equivalent.
 */
function deriveKgProvider(
  env: NodeJS.ProcessEnv,
  wikiProvider: string,
): string | undefined {
  if (wikiProvider !== OPENAI) return undefined;
  return resolveWikiEmbeddingEndpoint(env) === undefined ? OPENAI : GATEWAY;
}

/** Fill `name` with `derived` only when the KG side left it blank. */
function fillIfAbsent(
  bridged: NodeJS.ProcessEnv,
  name: string,
  derived: string | undefined,
): void {
  if (derived === undefined || !isBlank(bridged[name])) return;
  bridged[name] = derived;
}

/**
 * A copy of `env` in which the KG dimension can find the wiki dimension's
 * embedding credentials.
 *
 * | KG variable | 1st | 2nd | 3rd | fallback |
 * | --- | --- | --- | --- | --- |
 * | `EMBEDDING_PROVIDER` | itself | `gateway` when the wiki provider is `openai` and it sets an endpoint | `openai` when the wiki provider is `openai` | schema default |
 * | `OPENAI_API_KEY` | itself | the wiki embedding key, when the provider is `openai` | — | `""` |
 * | `GATEWAY_URL` | itself | the wiki endpoint, when the provider is `gateway` | — | `""` |
 * | `GATEWAY_API_KEY` | itself | the wiki embedding key, when the provider is `gateway` | — | `""` |
 * | `EMBEDDING_MODEL` | itself | `LLMWIKI_EMBEDDING_MODEL`, and only when that is set | — | schema default, then {@link findEmbeddingModelProblem} |
 *
 * Every other variable is copied through unchanged, and the argument is never
 * mutated: callers rely on `process.env` staying exactly as it was.
 *
 * @param env - Environment to bridge; never modified.
 * @returns A new environment object with the five KG variables filled.
 */
export function bridgeEnvWithWikiCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bridged: NodeJS.ProcessEnv = { ...env };
  const derivedProvider = deriveKgProvider(env, resolveWikiEmbeddingProvider(env));
  fillIfAbsent(bridged, KG_PROVIDER, derivedProvider);
  // The model travels on its own: it names what to ask for, not where to ask,
  // so it is derived whichever provider resulted — and only when the operator
  // named one on the wiki side.
  fillIfAbsent(bridged, KG_MODEL, readPresent(env, WIKI_EMBEDDING_MODEL));

  const provider = (readPresent(bridged, KG_PROVIDER) ?? "").trim().toLowerCase();
  const wikiKey = resolveWikiEmbeddingKey(env);
  if (provider === OPENAI) {
    fillIfAbsent(bridged, KG_OPENAI_KEY, wikiKey);
  }
  if (provider === GATEWAY) {
    fillIfAbsent(bridged, KG_GATEWAY_URL, resolveWikiEmbeddingEndpoint(env));
    fillIfAbsent(bridged, KG_GATEWAY_API_KEY, wikiKey);
  }
  return bridged;
}

/**
 * The message explaining why the wiki provider cannot drive the kg dimension.
 *
 * @param wikiProvider - The resolved wiki embedding provider.
 * @returns The fixed S4 message naming that provider, never a credential value.
 */
function noEquivalentProblem(wikiProvider: string): string {
  return (
    `LLMWIKI_EMBEDDING_PROVIDER="${wikiProvider}" has no kg-dimension equivalent. ` +
    `The kg dimension embeds through EMBEDDING_PROVIDER=${OPENAI} or ${GATEWAY}; ` +
    `set one of those with its credential.`
  );
}

/**
 * The reason this configuration cannot embed, or `null` when it can.
 *
 * WHY THE WIKI PROVIDER IS CHECKED FIRST, AND ONLY ON THE DEFAULT. A wiki
 * provider with no kg equivalent (the `anthropic` default, `ollama`, an agent
 * provider) gives the bridge nothing to derive, so the operator has to be told
 * that rather than handed a generic "no key" complaint. That explanation is
 * reported only when the KG side has no provider of its own AND the resulting
 * default (`openai`) has no credential either: a deployment that already sets
 * `OPENAI_API_KEY` and relies on the schema default keeps working untouched,
 * which is the backward compatibility this feature must not trade away.
 *
 * The message never includes a credential VALUE — only variable names.
 *
 * @param cfg - The parsed KG config, read for provider and credentials.
 * @param env - The environment the config was parsed from, read for the
 *   explicitness of `EMBEDDING_PROVIDER` and for the wiki-side provider.
 * @returns The exact message to raise, or `null` when the configuration is usable.
 */
export function findEmbeddingCredentialProblem(
  cfg: EmbeddingCredentialConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  const providerConfigured = readPresent(env, KG_PROVIDER) !== undefined;
  const provider = cfg.EMBEDDING_PROVIDER;
  const wikiProvider = resolveWikiEmbeddingProvider(env);
  if (
    !providerConfigured &&
    provider === OPENAI &&
    wikiProvider !== OPENAI &&
    isBlank(cfg.OPENAI_API_KEY)
  ) {
    return noEquivalentProblem(wikiProvider);
  }
  if (provider === OPENAI && isBlank(cfg.OPENAI_API_KEY)) return OPENAI_KEY_PROBLEM;
  if (provider === GATEWAY && isBlank(cfg.GATEWAY_URL)) return GATEWAY_URL_PROBLEM;
  if (provider === GATEWAY && isBlank(cfg.GATEWAY_API_KEY)) return GATEWAY_KEY_PROBLEM;
  return null;
}

/**
 * The message refusing a model nobody chose, naming the variable that fixes it.
 *
 * @param resolvedModel - The model the configuration resolved to.
 * @returns The exact 768-width message, never a credential value.
 */
function dimensionProblem(resolvedModel: string): string {
  return (
    `The kg dimension's embedding column is ${EMBEDDING_COLUMN_WIDTH} dimensions wide, ` +
    `but the resolved model "${resolvedModel}" was not chosen by the operator. ` +
    `Set ${WIKI_EMBEDDING_MODEL} to a model that emits ` +
    `${EMBEDDING_COLUMN_WIDTH}-dimensional vectors.`
  );
}

/**
 * The reason the resolved embedding model cannot be used, or `null` when it can.
 *
 * WHY A MODEL NOBODY CHOSE IS REFUSED. The kg columns are `vector(768)` and the
 * kg dimension performs no dimension reduction, so a provider default — 1536
 * wide for an OpenAI endpoint — fails only inside Postgres, after the expensive
 * chunk write has begun. That default is exactly what an installation which
 * configured the wiki side and nothing else would inherit.
 *
 * WHY THE EXPLICIT CASES ARE ACCEPTED UNCONDITIONALLY. An operator who set
 * `EMBEDDING_PROVIDER` is configuring this side itself, and S3 freezes that
 * behaviour as it is today, unusable width included; naming a model does the
 * same. The refusal therefore applies only to a configuration derived entirely
 * from the wiki side.
 *
 * @param resolvedModel - The model the run would actually ask for.
 * @param env - Environment to read; never modified.
 * @returns The exact message to raise, or `null` when the model may be sent.
 */
export function findEmbeddingModelProblem(
  resolvedModel: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (readPresent(env, KG_PROVIDER) !== undefined) return null;
  if (readPresent(env, KG_MODEL) !== undefined) return null;
  if (readPresent(env, WIKI_EMBEDDING_MODEL) !== undefined) return null;
  return dimensionProblem(resolvedModel);
}
