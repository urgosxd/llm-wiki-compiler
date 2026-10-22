/**
 * @file packages/llmwiki-kg/ts/src/core/llm/embeddings.ts
 * @description Batched text embeddings and the single-query embedding.
 *
 * Split out of `core/llm_clients.ts` as its own unit because the embedding
 * provider is chosen independently of the extraction provider, and because
 * restoring provider ordering from each entry's `index` is a concern only this
 * path has.
 */

import { config } from "../../config.js";
import { embeddingEndpoint } from "./endpoints.js";
import { LlmError } from "./errors.js";
import { asArray, asRecord, postJson } from "./json.js";

/** One provider entry, already validated into a dense numeric vector. */
interface EmbeddingEntry {
  readonly slot: number;
  readonly vector: number[];
}

/** Reads an entry's `index`, falling back to its position in `data`. */
function entrySlot(record: Record<string, unknown>, position: number): number {
  const index = record["index"];
  return typeof index === "number" ? index : position;
}

/** Validates one provider entry into a vector destined for `slot`. */
function toEmbeddingEntry(
  entry: unknown,
  position: number,
  inputCount: number,
  endpoint: string,
): EmbeddingEntry {
  const record = asRecord(entry);
  const embedding = asArray(record?.["embedding"]);
  if (record === undefined || embedding === undefined) {
    throw new LlmError(`${endpoint} returned an entry with no embedding`, endpoint);
  }

  const slot = entrySlot(record, position);
  if (!Number.isInteger(slot) || slot < 0 || slot >= inputCount) {
    throw new LlmError(
      `${endpoint} returned an out-of-range embedding index ${String(record["index"])}`,
      endpoint,
    );
  }

  const vector: number[] = [];
  for (const component of embedding) {
    if (typeof component !== "number") {
      throw new LlmError(`${endpoint} returned a non-numeric embedding component`, endpoint);
    }
    vector.push(component);
  }
  return { slot, vector };
}

/** Places every entry at its own slot, rejecting a response that skips one. */
function orderBySlot(
  entries: readonly EmbeddingEntry[],
  inputCount: number,
  endpoint: string,
): number[][] {
  const ordered = new Array<number[]>(inputCount);
  for (const entry of entries) {
    ordered[entry.slot] = entry.vector;
  }
  for (const [position, vector] of ordered.entries()) {
    if (vector === undefined) {
      throw new LlmError(
        `${endpoint} returned no embedding for input ${String(position)}`,
        endpoint,
      );
    }
  }
  return ordered;
}

/**
 * Embeds `texts` in one batched request.
 *
 * One HTTP round trip for the whole batch, matching
 * `Settings.embed_model.get_text_embedding_batch(texts)` in Python: per-text
 * requests would multiply both latency and provider cost for a document that
 * chunks into a dozen pieces.
 *
 * The model name is sent verbatim from `config.EMBEDDING_MODEL`
 * (`hf:nomic-ai/nomic-embed-text-v1.5`), which is what the direct HTTP API
 * expects and what the LlamaIndex workaround in Python was working around.
 *
 * @returns one vector per input, in input order. Ordering is restored from each
 *   entry's `index` when the provider supplies it, because the gateway is not
 *   contractually ordered.
 * @throws {LlmError} when the provider fails, returns a count mismatch, or
 *   returns an entry that is not an array of numbers. A short vector is worse
 *   than a failure: it would be stored, and the pgvector column would reject it
 *   only after the transaction had already begun writing chunks.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const { endpoint, apiKey } = embeddingEndpoint();
  const { body } = await postJson(
    endpoint,
    { authorization: `Bearer ${apiKey}` },
    { model: config.EMBEDDING_MODEL, input: [...texts] },
  );

  const data = asArray(asRecord(body)?.["data"]);
  if (data === undefined) {
    throw new LlmError(`${endpoint} response has no data array`, endpoint);
  }
  if (data.length !== texts.length) {
    throw new LlmError(
      `${endpoint} returned ${String(data.length)} embeddings for ${String(texts.length)} inputs`,
      endpoint,
    );
  }

  const entries = data.map((entry, position) =>
    toEmbeddingEntry(entry, position, texts.length, endpoint),
  );
  return orderBySlot(entries, texts.length, endpoint);
}

/**
 * Embeds a single query string.
 *
 * Same model as document chunks, so cosine distances are comparable with the
 * stored chunk vectors — the reason `embed_query` exists separately in Python
 * rather than callers reaching for the embedder themselves.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  if (vector === undefined) {
    throw new LlmError("embedding provider returned no vector for the query", "embeddings");
  }
  return vector;
}
