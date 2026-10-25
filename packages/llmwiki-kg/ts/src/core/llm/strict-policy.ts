/**
 * @file packages/llmwiki-kg/ts/src/core/llm/strict-policy.ts
 * @description Whether to send `strict: true` in the tool definition.
 *
 * ## Why this is a policy and not a constant
 *
 * `strict: true` is what turns a tool schema from advisory into binding: without
 * it the `enum` on a field is a hint the model may ignore, and structured outputs
 * are not enforced. Whether it is safe to send depends entirely on the backend,
 * and "OpenAI-compatible" does not answer the question:
 *
 * - `openai` implements it, so structured outputs are guaranteed.
 * - `anthropic` has no such field; its tool schemas are enforced unconditionally,
 *   so there is nothing to opt into.
 * - `gateway` is whatever OpenAI-compatible endpoint the operator pointed
 *   `GATEWAY_URL` at. Three behaviours are all common in the wild: a faithful
 *   proxy that honours `strict`, a server that accepts the field and ignores it,
 *   and a strict parser that rejects the request for an unknown field. Sending it
 *   blindly trades a schema hint for a possible outage; never sending it leaves a
 *   capable gateway permanently unenforced.
 *
 * So the default follows the provider, and `EXTRACTION_STRICT_SCHEMA` overrides
 * it. The operator is the only party who knows which gateway they run.
 *
 * ## Why an override can also force it off
 *
 * An `openai` deployment behind a proxy that drops unknown fields in the function
 * object is not hypothetical. The override is symmetric because a downgrade to
 * advisory typing is a legitimate, if lesser, configuration — and it is better
 * than a request that fails.
 */

import { config } from "../../config.js";
import type { ExtractionProvider } from "../../config.js";

/** The `EXTRACTION_STRICT_SCHEMA` value: keep the provider default or force it. */
export type StrictOverride = "auto" | "true" | "false";

/** The resolved decision, and why it was made. */
export interface StrictDecision {
  /** Whether to send `strict: true` in the tool definition. */
  readonly enabled: boolean;
  /**
   * Where the decision came from: the provider default or the operator override.
   * Carried for logging and for tests, not sent to any provider.
   */
  readonly source: "provider-default" | "override";
}

/** Providers whose structured-output mode is guaranteed to honour `strict`. */
const STRICT_CAPABLE: readonly ExtractionProvider[] = ["openai"];

/**
 * Decides whether this request should ask the provider to enforce the schema.
 *
 * @param provider - The configured extraction provider.
 * @param override - `EXTRACTION_STRICT_SCHEMA`: `auto`, `true`, or `false`.
 * @returns The decision and its provenance.
 */
export function resolveStrictPolicy(
  provider: ExtractionProvider,
  override: StrictOverride,
): StrictDecision {
  if (override === "true") return { enabled: true, source: "override" };
  if (override === "false") return { enabled: false, source: "override" };
  return { enabled: STRICT_CAPABLE.includes(provider), source: "provider-default" };
}

/** {@link resolveStrictPolicy} against the loaded configuration. */
export function strictSchemaEnabled(): boolean {
  return resolveStrictPolicy(config.EXTRACTION_PROVIDER, config.EXTRACTION_STRICT_SCHEMA)
    .enabled;
}
