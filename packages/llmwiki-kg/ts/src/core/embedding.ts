/**
 * @file packages/llmwiki-kg/ts/src/core/embedding.ts
 * @description Chunk-and-embed, the step that turns a document into the rows
 * `document_chunks` holds.
 *
 * An empty or whitespace-only document yields no chunks and therefore no
 * embedding request — which is what makes ingesting a whitespace-only file free,
 * and why the oracle answers such a document with `chunks_created: 0` and every
 * extraction count at zero.
 */

import { createHash } from "node:crypto";

import { embedQuery as embedQueryVector, embedTexts } from "./llm_clients.js";
import { splitText } from "./chunking.js";
import { countTokens } from "./tokenizer.js";
import type { ChunkResult } from "./extraction-types.js";

// ===========================================================================
// STEP 4: CHUNK AND EMBED
// ===========================================================================

/**
 * Splits `text` into chunks and embeds them in one batched call.
 *
 * Mirrors `chunk_and_embed`. An empty or whitespace-only document yields no
 * chunks and therefore no embedding request — which is what makes ingesting a
 * whitespace-only file free, and is why the oracle answers such a document with
 * `chunks_created: 0` and every extraction count at zero.
 *
 * `content_hash` is the hex SHA-256 of the chunk text, matching
 * `hashlib.sha256(content.encode("utf-8")).hexdigest()`.
 */
export async function chunkAndEmbed(
  text: string,
  stackId: string,
  documentId: string,
): Promise<ChunkResult[]> {
  if (text.trim() === "") {
    return [];
  }

  const texts = splitText(text);
  if (texts.length === 0) {
    return [];
  }

  // `split_text("")` only happens for empty input, already excluded above; a
  // defensive filter keeps a lone empty chunk from being embedded and stored.
  const embeddable = texts.filter((chunk) => chunk !== "");
  if (embeddable.length === 0) {
    return [];
  }

  const embeddings = await embedTexts(embeddable);

  return embeddable.map((content, index) => ({
    documentId,
    stackId,
    chunkIndex: index,
    content,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    tokenCount: countTokens(content),
    embedding: embeddings[index] ?? [],
    chunkerStrategy: "sentence",
  }));
}

/**
 * Embeds a single query string for the `/context` endpoint.
 *
 * Same model as document chunks, so cosine distances are comparable.
 */
export async function embedQuery(text: string): Promise<number[]> {
  return embedQueryVector(text);
}
