/**
 * @file src/ingest/docx.ts
 * @description Word (`.docx`) ingestion module.
 *
 * A `.docx` is a zip container of Office Open XML parts, so it cannot be read as
 * UTF-8 text the way `src/ingest/file.ts` reads a `.md`, and there is no cheap
 * content signal to sniff: the extension is the only reliable format evidence.
 * That is why `.docx` gets its own `SourceType` member and its own adapter
 * (S5 — one format-dispatch seam, never a per-format branch inside the pipeline).
 *
 * ## Why mammoth
 *
 * mammoth is the maintained converter for exactly this job: pure JavaScript (no
 * node-gyp or per-platform native build, so CI stays portable), BSD-2-Clause, and
 * it exposes `extractRawText`, which yields the document's text without asking us
 * to reimplement OOXML traversal. `pdf-parse` remains the only prebuilt-binary
 * dependency in the pipeline.
 *
 * ## Why the DEFAULT import
 *
 * mammoth ships CommonJS only (`module.exports = ...`) with an `export =`
 * declaration. Under this project's `esModuleInterop` the default import is the
 * supported interop shape; named imports (`import { extractRawText } from
 * "mammoth"`) type-check in some setups but resolve to `undefined` at runtime and
 * fail only when a real document is ingested.
 *
 * ## Empty extraction is returned, not thrown
 *
 * When a document parses but holds no text, this adapter returns the empty
 * content and lets the shared `enforceMinContent` guard reject it. Format
 * KNOWLEDGE belongs here, but the emptiness POLICY belongs to the shared path
 * (S7, and the manager ruling in L6): teaching this adapter to throw would give
 * every format its own copy of a rule that must stay identical across web, file,
 * image, transcript, PDF and DOCX.
 *
 * Reading only: this adapter performs no write, so ingest atomicity (S6) is
 * untouched by anything in this file.
 */

import { readFile } from "fs/promises";
import mammoth from "mammoth";
import { titleFromFilename, type IngestedSource } from "./shared.js";

/**
 * Build the actionable message for an unparseable `.docx`.
 *
 * mammoth surfaces the underlying archive error verbatim ("Can't find end of
 * central directory and zipfile comment was not found"), which names neither the
 * document nor the format. An operator needs both: which file, and that the file
 * is not really a `.docx`.
 *
 * @param filePath - Path that was passed to the adapter.
 * @param error - Whatever mammoth rejected with.
 * @returns A one-line message naming the file, the format and the cause.
 */
function describeDocxFailure(filePath: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Failed to parse DOCX "${filePath}". The file is not a valid .docx (Office Open XML) archive: ${reason}`;
}

/**
 * Ingest a local `.docx` file and return its plain text with a document title.
 *
 * @param filePath - Absolute or relative path to a `.docx` file.
 * @returns The title derived from the filename and the extracted plain text.
 * @throws When the file cannot be read or is not a valid `.docx` archive.
 */
export default async function ingestDocx(filePath: string): Promise<IngestedSource> {
  const buffer = await readFile(filePath);
  const title = titleFromFilename(filePath);

  let text: string;
  try {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } catch (error) {
    throw new Error(describeDocxFailure(filePath, error));
  }

  // No empty-content check here on purpose — see the header: the shared guard owns it.
  return { title, content: text.trim() };
}
