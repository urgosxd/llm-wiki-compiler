/**
 * @file src/dimensions/wiki/concept-embeddings.ts
 * @description The embedding port the concept resolver scores through, plus the
 * explicit degradation path when semantic comparison is unavailable.
 *
 * The resolver in `concept-resolution.ts` knows nothing about providers, batches
 * or error taxonomies: it asks for vectors and receives them. This module owns
 * everything provider-shaped, which keeps the resolver a pure function that a test
 * can drive without a network.
 *
 * ## Degradation is reported, never silent
 *
 * Semantic grouping is an enhancement, not a requirement: the deterministic tiers
 * in `concept-identity.ts` still resolve the common synonym case with no API cost.
 * So a disabled or misconfigured embedding provider must NOT abort a compile — but
 * it must not be swallowed either, because a user who expects synonyms to
 * accumulate needs to know why they did not. Every path here returns a
 * {@link ConceptDegradation} reason instead of a bare `undefined`.
 *
 * A failure DURING the batch call is different: it is a real provider fault, not a
 * configuration decision, so it is returned as `embeddings-failed` with the
 * classified error rather than retried into a silent downgrade.
 */

import {
  classifyEmbeddingError,
  embedTextBatch,
  makeCountingProvider,
  resolveEmbedBatchSize,
} from "../../utils/embeddings-batch.js";
import { embeddingsDisabled } from "../../utils/embeddings-config.js";
import {
  findEmbeddingProviderProblem,
  getActiveEmbeddingProviderName,
  getEmbeddingProvider,
} from "../../utils/embedding-provider.js";
import { resolveEmbeddingFingerprint } from "../../utils/embeddings-store.js";
import type {
  ConceptDegradation,
  ConceptEmbeddingPort,
  ConceptEmbedOutcome,
} from "./concept-resolution.js";

/** Outcome of trying to build a working embedding port. */
export type ConceptEmbeddingSetup =
  | { readonly ok: true; readonly port: ConceptEmbeddingPort }
  | { readonly ok: false; readonly degradation: ConceptDegradation };

/**
 * Turns a provider failure into a reportable degradation, preserving the taxonomy
 * class so the caller can tell a transient fault from a permanent one.
 */
function describeEmbeddingFailure(err: unknown): ConceptDegradation {
  const detail = err instanceof Error ? err.message : String(err);
  return { reason: "embeddings-failed", detail: `${classifyEmbeddingError(err)}: ${detail}` };
}

/**
 * Builds the embedding port for concept identity, or explains why it cannot be
 * built.
 *
 * Checks the project's own switches in the order that produces the most useful
 * message: an explicit opt-out first (`LLMWIKI_EMBEDDINGS=0`), then a misconfigured
 * provider (a name with no capability or credentials), and only then constructs one.
 *
 * @returns A ready port, or the degradation that replaces semantic grouping.
 */
export function createConceptEmbeddingPort(): ConceptEmbeddingSetup {
  if (embeddingsDisabled()) {
    return {
      ok: false,
      degradation: {
        reason: "embeddings-disabled",
        detail: "embeddings are disabled for this project",
      },
    };
  }

  const problem = findEmbeddingProviderProblem();
  if (problem !== null) {
    return {
      ok: false,
      degradation: {
        reason: "embeddings-unconfigured",
        detail: `embedding provider "${problem.provider}" is unusable: ${problem.message}`,
      },
    };
  }

  const providerName = getActiveEmbeddingProviderName();
  const { provider } = makeCountingProvider(getEmbeddingProvider());
  const batchSize = resolveEmbedBatchSize(providerName);
  const fingerprint = resolveEmbeddingFingerprint();

  return {
    ok: true,
    port: {
      fingerprint,
      async embed(texts: readonly string[]): Promise<ConceptEmbedOutcome> {
        try {
          return { ok: true, vectors: await embedTextBatch(provider, [...texts], batchSize) };
        } catch (err) {
          return { ok: false, degradation: describeEmbeddingFailure(err) };
        }
      },
    },
  };
}

/**
 * The port factory a caller passes to `resolveConceptIdentity` when it merely wants
 * the best available behaviour: semantic grouping when embeddings work, the
 * deterministic tiers plus a reported reason when they do not.
 *
 * @returns A port that always answers with an outcome, or `undefined` when no port
 *   should be offered at all — in which case the resolver reports
 *   `embeddings-unconfigured` itself. Configuration problems are returned as a
 *   degradation by the port so the reason survives to the caller's report.
 */
export function conceptEmbeddingPortOrUndefined(): ConceptEmbeddingPort | undefined {
  const setup = createConceptEmbeddingPort();
  if (setup.ok) {
    return setup.port;
  }
  return {
    fingerprint: "",
    async embed(): Promise<ConceptEmbedOutcome> {
      return { ok: false, degradation: setup.degradation };
    },
  };
}
