/**
 * @file packages/llmwiki-kg/ts/src/embedding-backend.ts
 * @description The embedding backend a HOST process resolved, injected per call,
 * and the precedence rules that decide when it is allowed to drive the request.
 *
 * ## Why the descriptor travels as a parameter
 *
 * The KG side resolves its provider from its own variable namespace. A host that
 * already resolved an OpenAI-compatible backend — endpoint, credential, model —
 * must be able to hand that SAME backend over instead of asking the operator to
 * configure it twice. Carrying it through the environment would couple the two
 * sides by mutation order (the vendored config resolves once, lazily), so it is
 * an explicit argument and a scoped override: installed for the one call that
 * received it, cleared in `finally`.
 *
 * ## What this module does NOT know
 *
 * No provider names, no host names, no URLs, no credential variables. A backend
 * is whatever the host reports; a caller that reports none keeps the vendored
 * env-derived path and its own fail-closed messages. That is what makes an
 * OpenAI-compatible provider added tomorrow work with no edit here.
 *
 * ## Precedence, which is backward compatibility first
 *
 * An explicitly configured KG-side variable ALWAYS wins: a deployment that
 * already sets `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `GATEWAY_URL` or
 * `GATEWAY_API_KEY` keeps exactly the behaviour it has today, and the descriptor
 * is not even resolved for it. The injected backend only fills what the KG side
 * left blank, and an explicitly chosen `EMBEDDING_MODEL` still decides the model
 * sent in the request body.
 */

import {
  findEmbeddingModelProblem,
  isBlank,
  readPresent,
  KG_BACKEND_VARIABLES,
} from "./wiki-credential-fallback.js";

/**
 * The embedding backend a hosting process resolved for its own provider.
 *
 * Deliberately the smallest shape that can serve a request: where to POST, what
 * to authenticate with, and which model to ask for.
 */
export interface EmbeddingBackendDescriptor {
  /** Base URL of the OpenAI-compatible endpoint, without the `/embeddings` path. */
  readonly baseURL: string;
  /** Credential sent as `Bearer`, or `""` when the host resolved none. */
  readonly apiKey: string;
  /** Model id the host's embeddings client was configured with. */
  readonly model: string;
}

/** What one kg run should install, and the reason it cannot run at all. */
export interface EmbeddingBackendRun {
  /** Descriptor to install, or `undefined` to keep the env-derived path. */
  readonly backend: EmbeddingBackendDescriptor | undefined;
  /** Message to raise before any request, or `null` when the run may proceed. */
  readonly problem: string | null;
}

/** The KG-side variable that names the embedding model the operator chose. */
const KG_MODEL_VARIABLE = "EMBEDDING_MODEL";
/** The wiki-side variable holding the embedding credential. */
const WIKI_CREDENTIAL_VARIABLE = "OPENAI_EMBEDDINGS_API_KEY";
/** The KG-side variable holding the gateway credential. */
const KG_GATEWAY_CREDENTIAL_VARIABLE = "GATEWAY_API_KEY";

/** The descriptor installed for the call in flight, if any. */
let installedBackend: EmbeddingBackendDescriptor | undefined;

/**
 * Run `work` with `descriptor` installed as the embedding backend.
 *
 * The previous value is restored in `finally`, so a throwing (or rejected) call
 * cannot leave a backend installed for the next one — that would silently send a
 * later document to a provider its operator never configured.
 *
 * @param descriptor - Backend to install; `undefined` installs none.
 * @param work - The embedding work to run inside the scope.
 * @returns Whatever `work` resolves to.
 */
export async function withEmbeddingBackend<T>(
  descriptor: EmbeddingBackendDescriptor | undefined,
  work: () => Promise<T> | T,
): Promise<T> {
  const previous = installedBackend;
  installedBackend = descriptor;
  try {
    return await work();
  } finally {
    installedBackend = previous;
  }
}

/**
 * The endpoint and credential to embed with, or `undefined` when the KG's own
 * config decides — which is what keeps the env-derived path untouched.
 */
export function injectedEmbeddingEndpoint(): { endpoint: string; apiKey: string } | undefined {
  const backend = installedBackend;
  if (backend === undefined) return undefined;
  return { endpoint: `${backend.baseURL}/embeddings`, apiKey: backend.apiKey };
}

/**
 * The model for the request body, or `undefined` when the KG's own config
 * decides.
 *
 * An explicitly chosen `EMBEDDING_MODEL` wins: it is a KG-side setting, and S3
 * gives it precedence over anything derived. `LLMWIKI_EMBEDDING_MODEL` needs no
 * handling here because the descriptor's model already reflects it.
 */
export function injectedEmbeddingModel(): string | undefined {
  const backend = installedBackend;
  if (backend === undefined) return undefined;
  return readPresent(process.env, KG_MODEL_VARIABLE) ?? backend.model;
}

/**
 * True when the KG side configured its own embedding backend.
 *
 * Reuses {@link KG_BACKEND_VARIABLES} rather than restating the names: the set
 * the bridge may fill is exactly the set whose explicit value must win. The
 * model is not a member — naming a model says nothing about where the request
 * goes, and an explicit model still overrides the descriptor's (see
 * {@link injectedEmbeddingModel}).
 *
 * @param env - Environment to read; never modified.
 * @returns True when any backend variable holds a non-blank value.
 */
export function configuresOwnEmbeddingBackend(env: NodeJS.ProcessEnv): boolean {
  return KG_BACKEND_VARIABLES.some((name) => readPresent(env, name) !== undefined);
}

/** The refusal for a backend the host resolved without any credential. */
const MISSING_CREDENTIAL_PROBLEM =
  "The wiki dimension's embedding backend resolved with no API key. " +
  `Set the wiki dimension's embedding credential (${WIKI_CREDENTIAL_VARIABLE}) ` +
  `or ${KG_GATEWAY_CREDENTIAL_VARIABLE} to reuse that backend in the kg dimension.`;

/**
 * Decide whether `descriptor` may drive this run, and why it may not.
 *
 * Fails closed BEFORE any request: a backend without a credential would 401 from
 * the provider, and a model nobody chose is very likely not 768 wide, which
 * Postgres would reject only after the chunk write had begun.
 *
 * @param descriptor - The backend the host resolved, or `undefined` when it reports none.
 * @param env - Environment the run resolved from; never modified.
 * @returns The backend to install plus a problem message, or `null` when usable.
 */
export function prepareEmbeddingBackend(
  descriptor: EmbeddingBackendDescriptor | undefined,
  env: NodeJS.ProcessEnv,
): EmbeddingBackendRun {
  if (descriptor === undefined || configuresOwnEmbeddingBackend(env)) {
    return { backend: undefined, problem: null };
  }
  if (isBlank(descriptor.apiKey)) {
    return { backend: undefined, problem: MISSING_CREDENTIAL_PROBLEM };
  }
  // The descriptor's model is the one this request would carry, so it is the
  // model the width rule has to judge.
  const modelProblem = findEmbeddingModelProblem(descriptor.model, env);
  if (modelProblem !== null) return { backend: undefined, problem: modelProblem };
  return { backend: descriptor, problem: null };
}
