/**
 * @file packages/llmwiki-kg/ts/src/chat-backend.ts
 * @description The CHAT backend a HOST process resolved, injected per call, and
 * the precedence rules that decide when it is allowed to drive the request.
 *
 * ## Why this is a second module rather than a second shape in the first
 *
 * `embedding-backend.ts` answers "where do vectors come from"; this one answers
 * "where does extraction come from". They are different services in a real
 * deployment — the wiki's chat may be a gateway while its embeddings come from a
 * hosted embedding host — so they are different descriptors, different scoped
 * overrides, and different request readers. Sharing one override between them is
 * exactly the crossed wire both modules exist to prevent.
 *
 * ## What this module does NOT know
 *
 * No host names, no URLs, no provider table. A backend is whatever the host
 * reports; a caller that reports none keeps the vendored env-derived path and
 * its own fail-closed messages. Every request built from a descriptor uses the
 * OpenAI-compatible shape (`{baseURL}/chat/completions`, `Authorization: Bearer`,
 * `model` in the body), which is what makes an OpenAI-compatible provider added
 * tomorrow work with no edit here.
 *
 * ## Precedence, which is backward compatibility first
 *
 * An explicitly chosen KG-side extraction variable ALWAYS wins: a deployment
 * that already sets `EXTRACTION_PROVIDER` (and the endpoint and credential it
 * implies) or `EXTRACTION_MODEL` keeps exactly the behaviour it has today, and
 * no descriptor is even resolved for it. The injected backend only fills what
 * the KG side left blank.
 *
 * The credentials are NOT in that set, deliberately: `OPENAI_API_KEY`,
 * `GATEWAY_URL` and `GATEWAY_API_KEY` are read by the embedding side too, so
 * setting one says nothing about which CHAT backend the operator chose — and
 * treating them as a choice hid the descriptor in every deployment that shares a
 * credential, which is the deployment this feature exists for.
 */

import { isBlank, readPresent } from "./wiki-credential-fallback.js";

/**
 * The chat backend a hosting process resolved for its own provider.
 *
 * Deliberately the smallest shape that can serve a request: where to POST, what
 * to authenticate with, and which model to ask for.
 */
export interface ChatBackendDescriptor {
  /** Base URL of the OpenAI-compatible endpoint, without the `/chat/completions` path. */
  readonly baseURL: string;
  /** Credential sent as `Bearer`, or `""` when the host resolved none. */
  readonly apiKey: string;
  /** Model id the host's CHAT client was configured with. */
  readonly model: string;
}

/** What one kg run should install, and the reason it cannot run at all. */
export interface ChatBackendRun {
  /** Descriptor to install, or `undefined` to keep the env-derived path. */
  readonly backend: ChatBackendDescriptor | undefined;
  /** Message to raise before any request, or `null` when the run may proceed. */
  readonly problem: string | null;
}

/**
 * The KG-side variables that configure the extraction backend itself: the
 * provider it names, and the model the operator chose.
 *
 * EXPORTED because "the operator configured this side itself" is decided by
 * exactly this set, and a second list of the same names would be a second answer
 * to the same question. The credentials both sides share are deliberately
 * absent — see this module's header.
 */
export const KG_CHAT_BACKEND_VARIABLES = ["EXTRACTION_PROVIDER", "EXTRACTION_MODEL"] as const;

/** The KG-side variable that names the extraction model. */
const KG_MODEL_VARIABLE = "EXTRACTION_MODEL";
/** The wiki-side variable holding the chat credential. */
const WIKI_CHAT_CREDENTIAL_VARIABLE = "OPENAI_API_KEY";
/** The vendor whose request shape a descriptor implies. */
const ANTHROPIC = "anthropic";
const OPENAI = "openai";
const GATEWAY = "gateway";

/** The descriptor installed for the call in flight, if any. */
let installedBackend: ChatBackendDescriptor | undefined;

/**
 * Run `work` with `descriptor` installed as the extraction backend.
 *
 * The previous value is restored in `finally`, so a throwing (or rejected) call
 * cannot leave a backend installed for the next one — that would silently send a
 * later document to a provider its operator never configured.
 *
 * @param descriptor - Backend to install; `undefined` installs none.
 * @param work - The extraction work to run inside the scope.
 * @returns Whatever `work` resolves to.
 */
export async function withChatBackend<T>(
  descriptor: ChatBackendDescriptor | undefined,
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
 * The endpoint and credential to extract with, or `undefined` when the KG's own
 * config decides — which is what keeps the env-derived path untouched.
 *
 * @returns The chat-completions URL and credential, or `undefined` when nothing
 *   is installed for this call.
 */
export function injectedChatEndpoint(): { endpoint: string; apiKey: string } | undefined {
  const backend = installedBackend;
  if (backend === undefined) return undefined;
  return { endpoint: `${backend.baseURL}/chat/completions`, apiKey: backend.apiKey };
}

/**
 * The model for the request body, or `undefined` when the KG's own config
 * decides.
 *
 * An explicitly chosen `EXTRACTION_MODEL` wins: it is a KG-side setting, and the
 * precedence rule gives it priority over anything derived.
 *
 * @param env - Environment to read; never modified. Defaults to the ambient one,
 *   which is what the vendored request path reads.
 * @returns The model to request, or `undefined` when nothing is installed.
 */
export function injectedChatModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const backend = installedBackend;
  if (backend === undefined) return undefined;
  return readPresent(env, KG_MODEL_VARIABLE) ?? backend.model;
}

/**
 * True while a backend is installed for the call in flight.
 *
 * The request builders use it to decide the WIRE SHAPE: a descriptor is an
 * OpenAI-compatible backend, so the Anthropic body and headers never apply to
 * one, whatever `EXTRACTION_PROVIDER` says.
 *
 * @returns True when a chat backend is installed for the current call.
 */
export function isChatBackendInjected(): boolean {
  return installedBackend !== undefined;
}

/**
 * True when the KG side configured its own extraction backend.
 *
 * @param env - Environment to read; never modified.
 * @returns True when any variable in {@link KG_CHAT_BACKEND_VARIABLES} is set.
 */
export function configuresOwnChatBackend(env: NodeJS.ProcessEnv): boolean {
  return KG_CHAT_BACKEND_VARIABLES.some((name) => readPresent(env, name) !== undefined);
}

/** The refusal for a backend the host resolved without any credential. */
const MISSING_CREDENTIAL_PROBLEM =
  "The wiki dimension's chat backend resolved with no API key. " +
  `Set the wiki dimension's chat credential (${WIKI_CHAT_CREDENTIAL_VARIABLE}) ` +
  "or EXTRACTION_PROVIDER with its own endpoint and credential to extract in the kg dimension.";

/**
 * Decide whether `descriptor` may drive this run, and why it may not.
 *
 * Fails closed BEFORE any request: a backend without a credential would 401 from
 * the provider, and a 401 names nothing an operator can act on.
 *
 * @param descriptor - The backend the host resolved, or `undefined` when it reports none.
 * @param env - Environment the run resolved from; never modified.
 * @returns The backend to install plus a problem message, or `null` when usable.
 */
export function prepareChatBackend(
  descriptor: ChatBackendDescriptor | undefined,
  env: NodeJS.ProcessEnv,
): ChatBackendRun {
  if (descriptor === undefined || configuresOwnChatBackend(env)) {
    return { backend: undefined, problem: null };
  }
  if (isBlank(descriptor.apiKey)) {
    return { backend: undefined, problem: MISSING_CREDENTIAL_PROBLEM };
  }
  return { backend: descriptor, problem: null };
}

/**
 * The subset of the parsed config the extraction credential check reads.
 *
 * Structural rather than an import of `Config`, so this module stays free of a
 * circular dependency on the config module. Every credential is optional because
 * the check judges only the provider that was actually resolved.
 */
export interface ExtractionCredentialConfig {
  readonly EXTRACTION_PROVIDER: string;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly GATEWAY_URL?: string | undefined;
  readonly GATEWAY_API_KEY?: string | undefined;
}

/** The exact fail-closed messages, one per unusable extraction credential. */
const ANTHROPIC_KEY_PROBLEM =
  `EXTRACTION_PROVIDER=${ANTHROPIC} but ANTHROPIC_API_KEY is not set. ` +
  "Set ANTHROPIC_API_KEY to extract in the kg dimension.";
const EXTRACTION_OPENAI_KEY_PROBLEM =
  `EXTRACTION_PROVIDER=${OPENAI} but OPENAI_API_KEY is not set. ` +
  "Set OPENAI_API_KEY to extract in the kg dimension.";
const EXTRACTION_GATEWAY_PROBLEM =
  `EXTRACTION_PROVIDER=${GATEWAY} but GATEWAY_URL or GATEWAY_API_KEY is not set. ` +
  "Set both to extract in the kg dimension.";

/**
 * The reason this configuration cannot extract, or `null` when it can.
 *
 * WHY THIS EXISTS AT ALL. Without it, a kg dimension that resolves no shared
 * chat backend reaches the schema default provider with no credential and the
 * failure arrives as a provider 401 — which names no variable, costs a round
 * trip, and is indistinguishable from a wrong key. The check runs before the
 * first request and names what to set.
 *
 * @param cfg - The parsed KG config, read for the provider and its credentials.
 * @returns The exact message to raise, or `null` when the configuration is usable.
 */
export function findExtractionCredentialProblem(
  cfg: ExtractionCredentialConfig,
): string | null {
  if (cfg.EXTRACTION_PROVIDER === ANTHROPIC && isBlank(cfg.ANTHROPIC_API_KEY)) {
    return ANTHROPIC_KEY_PROBLEM;
  }
  if (cfg.EXTRACTION_PROVIDER === OPENAI && isBlank(cfg.OPENAI_API_KEY)) {
    return EXTRACTION_OPENAI_KEY_PROBLEM;
  }
  if (
    cfg.EXTRACTION_PROVIDER === GATEWAY &&
    (isBlank(cfg.GATEWAY_URL) || isBlank(cfg.GATEWAY_API_KEY))
  ) {
    return EXTRACTION_GATEWAY_PROBLEM;
  }
  return null;
}
