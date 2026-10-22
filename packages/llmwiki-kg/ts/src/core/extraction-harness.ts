/**
 * @file packages/llmwiki-kg/ts/src/core/extraction-harness.ts
 * @description Shared fixture builders for the split `core/extraction-*` test files.
 */
import { afterEach, beforeEach, vi } from "vitest";

import type { ChunkResult } from "./extraction.js";

export interface SplitterFixture {
  readonly name: string;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly text: string;
  readonly chunks: readonly string[];
}

export function characterCounter(text: string): number {
  return [...text].length;
}

export const SPLITTER_FIXTURES: readonly SplitterFixture[] = [
  {
    name: "paragraphs",
    chunkSize: 12,
    chunkOverlap: 3,
    text: "Alpha one. Alpha two.\n\nBeta one. Beta two.\n\nGamma one.",
    chunks: [
      "Alpha one.",
      "Alpha two.",
      "Beta one.",
      "Beta two.",
      "Gamma one.",
    ],
  },
  {
    name: "paragraph-merge",
    chunkSize: 40,
    chunkOverlap: 8,
    text: "Alpha one. Alpha two.\n\nBeta one. Beta two.\n\nGamma one.",
    chunks: [
      "Alpha one. Alpha two.",
      "Beta one. Beta two.\n\nGamma one.",
    ],
  },
  {
    name: "whitespace-trim",
    chunkSize: 20,
    chunkOverlap: 4,
    text: "   Leading spaces here.    Trailing too.   \n\n\n\n Double blank run above.  ",
    chunks: [
      "Leading spaces",
      "here.",
      "Trailing too.",
      "Double blank",
      "run above.",
    ],
  },
  {
    name: "overlap-carry",
    chunkSize: 24,
    chunkOverlap: 8,
    text: "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. Thirteen. Fourteen.",
    chunks: [
      "One. Two. Three. Four.",
      "Four. Five. Six. Seven.",
      "Seven. Eight. Nine.",
      "Nine. Ten. Eleven.",
      "Eleven. Twelve.",
      "Twelve. Thirteen.",
      "Fourteen.",
    ],
  },
  {
    name: "abbreviation",
    chunkSize: 18,
    chunkOverlap: 4,
    text: "Mr. Smith went to Washington. He arrived at 3 p.m. sharp. Then he left.",
    chunks: [
      "Mr. Smith went to",
      "to Washington.",
      "He arrived at 3 p.",
      "m. sharp.",
      "Then he left.",
    ],
  },
  {
    name: "ellipsis",
    chunkSize: 20,
    chunkOverlap: 5,
    text: "Question! Exclamation. Ellipsis... then more. And then U.S. policy.",
    chunks: [
      "Question!",
      "Exclamation.",
      "Ellipsis...",
      ".. then more.",
      "And then U.S.",
      "policy.",
    ],
  },
  {
    name: "quoted",
    chunkSize: 16,
    chunkOverlap: 4,
    text: "He said \"Stop.\" Then left. She replied \"Ok.\" And stayed.",
    chunks: [
      "He said \"Stop.\"",
      "Then left.",
      "She replied \"Ok.",
      "\" And stayed.",
    ],
  },
  {
    name: "parens",
    chunkSize: 14,
    chunkOverlap: 3,
    text: "(Sent1.) Sent2. Another (aside.) Then end.",
    chunks: [
      "(Sent1.)",
      "Sent2. Another",
      "(aside.)",
      ") Then end.",
    ],
  },
  {
    name: "newlines",
    chunkSize: 20,
    chunkOverlap: 5,
    text: "Line one\nSecond line. Third. Fourth\n\nFifth after paragraph. Sixth.",
    chunks: [
      "Line one\nSecond",
      "line. Third. Fourth",
      "Fifth after",
      "paragraph. Sixth.",
    ],
  },
  {
    name: "numeric",
    chunkSize: 16,
    chunkOverlap: 4,
    text: "Item 1. Item 2. Item 3. Version 3.5.2 ships. Done.",
    chunks: [
      "Item 1. Item 2.",
      "Item 3.",
      "Version 3.5.",
      "5.2 ships. Done.",
    ],
  },
  {
    name: "no-sentence-punct",
    chunkSize: 12,
    chunkOverlap: 2,
    text: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    chunks: [
      "alpha beta",
      "gamma delta",
      "epsilon",
      "zeta eta",
      "theta iota",
      "kappa",
      "lambda mu",
    ],
  },
  {
    name: "single-long-word",
    chunkSize: 20,
    chunkOverlap: 4,
    text: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
    chunks: [
      "abcdefghijklmnopqrst",
      "qrstuvwxyzabcdefghij",
      "ghijklmnopqrstuvwxyz",
    ],
  },
  {
    name: "single-sentence",
    chunkSize: 1024,
    chunkOverlap: 200,
    text: "Just one sentence here.",
    chunks: [
      "Just one sentence here.",
    ],
  },
  {
    name: "cjk",
    chunkSize: 12,
    chunkOverlap: 2,
    text: "日本語のテキストです。これはテストです。もっと長い文章をここに書きます。",
    chunks: [
      "日本語のテキストです。",
      "これはテストです。もっと",
      "っと長い文章をここに書き",
      "書きます。",
    ],
  },
  {
    name: "empty-ish",
    chunkSize: 1024,
    chunkOverlap: 200,
    text: "   ",
    chunks: [
    ],
  },
  {
    name: "prose-2000",
    chunkSize: 200,
    chunkOverlap: 40,
    text: "The AKS reference server compiles uploaded documents into a domain-specific ontology. Every document is stored on disk in its original form, and a record is written to the stack_documents table. The record carries the filename, the byte size, a SHA-256 hash of the contents, and the storage path. The hash makes uploads idempotent within a Stack: uploading identical bytes twice returns the original record rather than creating a second copy, which keeps the ontology from absorbing the same source twice.\n\nWhen a document is ingested, the pipeline reads the file, decodes it as UTF-8 text, and applies the extraction-time character limit. The file on disk is never truncated; only the text handed to the language model is. This distinction matters because the stored document remains a faithful copy of what the operator uploaded, while the compilation cost stays bounded. A document longer than five hundred thousand characters is marked as truncated, and the flag survives on the row so a later reader can tell a partial compilation from a complete one.\n\nChunking splits the text into overlapping windows. Each window is embedded with the configured embedding model, and the vector is stored alongside the chunk. Retrieval later compares a query vector against those chunk vectors using cosine distance, which is why the embedding model must stay the same across documents in a Stack. Changing the model mid-flight would make old and new vectors incomparable, silently degrading retrieval quality.\n\nGraph extraction runs a language model over each chunk with a schema-constrained prompt. The model returns triplets rather than free text, so the parser can reject anything that does not fit. Entities that appear in several chunks are merged by name, and the highest confidence wins. Relationships are deduplicated on the triple of source, type, and target, which collapses repeated mentions of the same edge into one row.\n\nConsolidation is the step that actually grows the ontology. Extraction is ",
    chunks: [
      "The AKS reference server compiles uploaded documents into a domain-specific ontology. Every document is stored on disk in its original form, and a record is written to the stack_documents table.",
      "The record carries the filename, the byte size, a SHA-256 hash of the contents, and the storage path.",
      "The hash makes uploads idempotent within a Stack: uploading identical bytes twice returns the original record rather than creating a second copy,",
      "which keeps the ontology from absorbing the same source twice.\n\nWhen a document is ingested, the pipeline reads the file, decodes it as UTF-8 text, and applies the extraction-time character limit.",
      "The file on disk is never truncated; only the text handed to the language model is.",
      "This distinction matters because the stored document remains a faithful copy of what the operator uploaded, while the compilation cost stays bounded.",
      "A document longer than five hundred thousand characters is marked as truncated, and the flag survives on the row so a later reader can tell a partial compilation from a complete one.",
      "Chunking splits the text into overlapping windows. Each window is embedded with the configured embedding model, and the vector is stored alongside the chunk.",
      "Retrieval later compares a query vector against those chunk vectors using cosine distance, which is why the embedding model must stay the same across documents in a Stack.",
      "Changing the model mid-flight would make old and new vectors incomparable, silently degrading retrieval quality.",
      "Graph extraction runs a language model over each chunk with a schema-constrained prompt. The model returns triplets rather than free text, so the parser can reject anything that does not fit.",
      "Entities that appear in several chunks are merged by name, and the highest confidence wins.",
      "Relationships are deduplicated on the triple of source, type, and target, which collapses repeated mentions of the same edge into one row.",
      "Consolidation is the step that actually grows the ontology. Extraction is",
    ],
  },
  {
    name: "prose-fit",
    chunkSize: 1024,
    chunkOverlap: 200,
    text: "The AKS reference server compiles uploaded documents into a domain-specific ontology. Every document is stored on disk in its original form, and a record is written to the stack_documents table. The record carries the filename, the byte size, a SHA-256 hash of the contents, and the storage path. The hash makes uploads idempotent within a Stack: uploading identical bytes twice returns the original record rather than creating a second copy, which keeps the ontology from absorbing the same source twice.\n\nWhen a document is ingested, the pipeline reads the file, decodes it as UTF-8 text, and applies the extraction-time character limit. The file on disk is never truncated; only the text handed to the language model is. This distinction matters because the stored document remains a faithful copy of what the operator uploaded, while the compilation cost stays bounded. A document longer than five hundred thousand characters is marked as truncated, and the flag survives on the row so a later reader can tell a partial compilation from a complete one.\n\nChunking splits the text into overlapping windows. Each window is embedded with the configured embedding model, and the vector is stored alongside the chunk. Retrieval later compares a query vector against those chunk vectors using cosine distance, which is why the embedding model must stay the same across documents in a Stack. Changing the model mid-flight would make old and new vectors incomparable, silently degrading retrieval quality.\n\nGraph extraction runs a language model over each chunk with a schema-constrained prompt. The model returns triplets rather than free text, so the parser can reject anything that does not fit. Entities that appear in several chunks are merged by name, and the highest confidence wins. Relationships are deduplicated on the triple of source, type, and target, which collapses repeated mentions of the same edge into one row.\n\nConsolidation is the step that actually grows the ontology. Extraction is ",
    chunks: [
      "The AKS reference server compiles uploaded documents into a domain-specific ontology. Every document is stored on disk in its original form, and a record is written to the stack_documents table. The record carries the filename, the byte size, a SHA-256 hash of the contents, and the storage path. The hash makes uploads idempotent within a Stack: uploading identical bytes twice returns the original record rather than creating a second copy, which keeps the ontology from absorbing the same source twice.",
      "When a document is ingested, the pipeline reads the file, decodes it as UTF-8 text, and applies the extraction-time character limit. The file on disk is never truncated; only the text handed to the language model is. This distinction matters because the stored document remains a faithful copy of what the operator uploaded, while the compilation cost stays bounded. A document longer than five hundred thousand characters is marked as truncated, and the flag survives on the row so a later reader can tell a partial compilation from a complete one.\n\nChunking splits the text into overlapping windows. Each window is embedded with the configured embedding model, and the vector is stored alongside the chunk. Retrieval later compares a query vector against those chunk vectors using cosine distance, which is why the embedding model must stay the same across documents in a Stack. Changing the model mid-flight would make old and new vectors incomparable, silently degrading retrieval quality.",
      "Graph extraction runs a language model over each chunk with a schema-constrained prompt. The model returns triplets rather than free text, so the parser can reject anything that does not fit. Entities that appear in several chunks are merged by name, and the highest confidence wins. Relationships are deduplicated on the triple of source, type, and target, which collapses repeated mentions of the same edge into one row.\n\nConsolidation is the step that actually grows the ontology. Extraction is",
    ],
  },
];

export interface RecordedRequest {
  readonly url: string;
  readonly body: unknown;
}

export const recorded: RecordedRequest[] = [];

export let embeddingResponses: Array<(inputs: readonly string[]) => unknown> = [];
/** Chat-completion responses served by the fake, in call order. */
export let chatResponses: Array<(body: Record<string, unknown>) => unknown> = [];
/** When set, the fake answers 500 instead of a body. */
export let failChat = false;

export const EMBEDDING_DIM = 768;
export const STACK_ID = "aaaaaaaa-0000-4000-8000-00000000aaaa";
export const DOCUMENT_ID = "bbbbbbbb-0000-4000-8000-00000000bbbb";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body: unknown = JSON.parse(rawBody);
      recorded.push({ url, body });

      if (url.endsWith("/embeddings")) {
        const inputs = (body as { input?: string[] }).input ?? [];
        const responder = embeddingResponses.shift();
        if (responder === undefined) {
          return jsonResponse({ data: inputs.map((_, index) => ({ index, embedding: fakeVector() })) });
        }
        return jsonResponse(responder(inputs));
      }

      if (url.endsWith("/chat/completions")) {
        if (failChat) {
          return jsonResponse({ error: { message: "stub failure" } }, 500);
        }
        const rec = body as Record<string, unknown>;
        const responder = chatResponses.shift();
        if (responder === undefined) {
          return jsonResponse(toolCallResponse({ triplets: [] }));
        }
        return jsonResponse(responder(rec));
      }

      return jsonResponse({ error: { message: `unexpected url ${url}` } }, 404);
    },
  );
}

export function uninstallFetchStub(): void {
  vi.unstubAllGlobals();
  recorded.length = 0;
  embeddingResponses = [];
  chatResponses = [];
  failChat = false;
}

export function fakeVector(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, index) => (index % 7) / 7);
}

export function toolCallResponse(payload: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "KGSchema", arguments: JSON.stringify(payload) },
            },
          ],
        },
      },
    ],
  };
}

export function setEmbeddingResponse(responder?: (inputs: readonly string[]) => unknown): void {
  embeddingResponses.push(responder ?? ((inputs) => ({
    data: inputs.map((_, index) => ({ index, embedding: fakeVector() })),
  })));
}

export function setToolResponse(payloads: readonly unknown[]): void {
  for (const payload of payloads) {
    chatResponses.push(() => toolCallResponse(payload));
  }
}

export function setToolFailure(): void {
  failChat = true;
}

export function embeddingCalls(): number {
  return recorded.filter((entry) => entry.url.endsWith("/embeddings")).length;
}

export function toolCalls(): number {
  return recorded.filter((entry) => entry.url.endsWith("/chat/completions")).length;
}

export function lastToolPrompt(): string {
  const chat = recorded.filter((entry) => entry.url.endsWith("/chat/completions")).at(-1);
  const messages = (chat?.body as { messages?: Array<{ content?: string }> } | undefined)?.messages;
  return messages?.[0]?.content ?? "";
}

export function stubEmbeddings(): void {
  setEmbeddingResponse();
}
export function restoreEmbeddings(): void {
  uninstallFetchStub();
  installFetchStub();
}
export function stubToolCall(): void {
  // The fake falls back to answering every chunk with an empty triplet list when
  // no responder is queued, so nothing has to be set up for the cost tests.
  chatResponses = [];
  failChat = false;
}
export function restoreToolCall(): void {
  uninstallFetchStub();
  installFetchStub();
}

export function chunk(index: number, content: string): ChunkResult {
  return {
    documentId: DOCUMENT_ID,
    stackId: STACK_ID,
    chunkIndex: index,
    content,
    contentHash: "0".repeat(64),
    tokenCount: content.length,
    embedding: fakeVector(),
    chunkerStrategy: "sentence",
  };
}

export const TECHNICAL_PROSE = `The AKS reference server compiles uploaded documents into a domain-specific ontology. Every document is stored on disk in its original form, and a record is written to the stack_documents table. The record carries the filename, the byte size, a SHA-256 hash of the contents, and the storage path. The hash makes uploads idempotent within a Stack: uploading identical bytes twice returns the original record rather than creating a second copy, which keeps the ontology from absorbing the same source twice.

Chunking splits the text into overlapping windows. Each window is embedded with the configured embedding model, and the vector is stored alongside the chunk. Retrieval later compares a query vector against those chunk vectors using cosine distance, which is why the embedding model must stay the same across documents in a Stack. Changing the model mid-flight would make old and new vectors incomparable, silently degrading retrieval quality.

Graph extraction runs a language model over each chunk with a schema-constrained prompt. The model returns triplets rather than free text, so the parser can reject anything that does not fit. Entities that appear in several chunks are merged by name, and the highest confidence wins. Relationships are deduplicated on the triple of source, type, and target, which collapses repeated mentions of the same edge into one row.

Consolidation is the step that actually grows the ontology. Extraction is stateless; it does not know what the Stack already contains. Consolidation looks up each extracted entity by name within the Stack, bumps confidence when the entity already exists, and records which document contributed. The same treatment applies to relationships, except that both endpoints must resolve to known entities before a row is written.

Section 4.2 governs the retention of records produced during the audit period. The controller shall retain all records for a period of not less than seven years from the date of creation, unless a longer period is required by applicable law. Records may be retained in electronic form provided that the electronic copy accurately reproduces the original and remains accessible throughout the retention period.

Where a record is subject to a legal hold, the controller shall suspend destruction immediately upon receipt of notice. The suspension applies to all copies of the record, including backups and archived versions. The controller shall confirm the suspension in writing within five business days and shall provide an inventory of the affected records to the requesting party.

Photosynthesis converts light energy into chemical energy stored in carbohydrate molecules. In plants, the process occurs in chloroplasts, organelles that contain the pigment chlorophyll. Chlorophyll absorbs light most strongly in the blue and red portions of the visible spectrum, which is why leaves appear green: green wavelengths are reflected rather than absorbed.

The migration ran for eleven hours and moved roughly four hundred million rows. Operators reported no data loss, but the read path slowed noticeably in the last two hours. The slowdown came from index maintenance: every inserted row touched three secondary indexes, and the write amplification pushed the page cache past its working set. Adding the indexes after the load finished cut the total time by about a third`;

vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

beforeEach(() => {
  installFetchStub();
});

afterEach(() => {
  uninstallFetchStub();
});
