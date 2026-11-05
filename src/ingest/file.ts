/**
 * @file src/ingest/file.ts
 * @description Local text-file ingestion module.
 *
 * Reads `.md` and `.txt` files from the local filesystem and returns their
 * content as markdown: Markdown is returned as-is, plain text is wrapped in a
 * markdown code block.
 *
 * Every other extension reaching this adapter is REFUSED, and the refusal is the
 * interesting part of this file. Formats with their own adapter never arrive here
 * — `detectSourceType` routes `.pdf`, `.docx`, images, transcripts and URLs to
 * their own adapters — so an extension that does arrive is one the compiler does
 * not read (`src/services/ingest/source-detection.ts`). The message must
 * therefore say what is actually supported and, for the two formats the product
 * deliberately descoped, name the remedy: `.doc` needs re-saving as `.docx`, and
 * `.xlsx` waits on a tracked parser (S3, S4).
 *
 * The refusal produces no write and no partial data (S6): it throws before the
 * file is read, so nothing downstream is reached.
 */

import { readFile } from "fs/promises";
import path from "path";
import { IMAGE_EXTENSIONS, TRANSCRIPT_EXTENSIONS } from "../utils/constants.js";
import { titleFromFilename, type IngestedSource } from "./shared.js";

/** Plain-text file extensions handled directly by this module. */
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"]);

/** The tracked spreadsheet parser named by the `.xlsx` refusal (S3). */
const XLSX_FOLLOW_UP_PARSER = "read-excel-file@9.3.14";

/** Wrap plain text content in a markdown fenced block. */
function wrapPlainText(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

/**
 * Describe every format the compiler really ingests.
 *
 * Derived from the same constants the detector reads, so this one sentence cannot
 * drift into a third copy of the format list and start lying again.
 *
 * @returns A comma-separated summary of supported formats.
 */
function supportedFormatsSummary(): string {
  const images = [...IMAGE_EXTENSIONS].join(", ");
  const transcripts = [...TRANSCRIPT_EXTENSIONS].join(", ");
  return (
    `Markdown (.md), plain text (.txt), PDF (.pdf), Word (.docx), ` +
    `images (${images}), transcripts (${transcripts}), and web URLs (http/https).`
  );
}

/**
 * Refusal for legacy binary Word (`.doc`, Word 97-2003).
 *
 * Not in scope (S4): the pre-2007 format is a binary OLE container with no
 * pure-JavaScript reader, so it needs an external office suite to convert. The
 * message has to say that plainly and point at `.docx`, or an operator concludes
 * the compiler is broken rather than their file being the wrong dialect.
 *
 * @param ext - The refused extension as it appeared in the path.
 * @returns The refusal message.
 */
function legacyDocRefusal(ext: string): string {
  return (
    `Unsupported file type "${ext}": .doc is legacy binary Word (Word 97-2003, pre-2007). ` +
    `That format is unsupported because it cannot be read without an external office suite. ` +
    `Re-save or export the document as .docx and ingest that instead.`
  );
}

/**
 * Refusal for Excel workbooks, naming the follow-up parser (S3).
 *
 * `.xlsx` is deliberately descoped rather than forgotten. Naming the tracked
 * parser turns the refusal into a signpost, and the alternative tells the
 * operator how to get their data in TODAY instead of waiting.
 *
 * @param ext - The refused extension as it appeared in the path.
 * @returns The refusal message.
 */
function spreadsheetRefusal(ext: string): string {
  return (
    `Unsupported file type "${ext}": spreadsheet ingest is not available yet, so Excel ` +
    `workbooks are not read. The planned parser for .xlsx support is a tracked follow-up ` +
    `(${XLSX_FOLLOW_UP_PARSER}). In the meantime, export the sheet you need as Markdown ` +
    `or plain text and ingest that.`
  );
}

/**
 * Refusal for any other unknown extension.
 *
 * States what IS supported instead of the old false claim that only `.md` and
 * `.txt` work, which contradicted the product and talked operators out of formats
 * that already ingest.
 *
 * @param ext - The refused extension as it appeared in the path.
 * @returns The refusal message.
 */
function unknownExtensionRefusal(ext: string): string {
  return `Unsupported file type "${ext}". Supported formats: ${supportedFormatsSummary()}`;
}

/**
 * Build the actionable refusal message for an extension this adapter cannot read.
 *
 * @param ext - Lowercased extension including the leading dot.
 * @returns The refusal message for that extension.
 */
function unsupportedExtensionMessage(ext: string): string {
  if (ext === ".doc") return legacyDocRefusal(ext);
  if (ext === ".xlsx") return spreadsheetRefusal(ext);
  return unknownExtensionRefusal(ext);
}

/**
 * Ingest a local file and return its content as markdown.
 * @param filePath - Absolute or relative path to a .md or .txt file.
 * @returns An object with a title derived from the filename and the markdown content.
 * @throws On unsupported file type or read failure.
 */
export default async function ingestFile(filePath: string): Promise<IngestedSource> {
  const ext = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(unsupportedExtensionMessage(ext));
  }

  const raw = await readFile(filePath, "utf-8");
  const title = titleFromFilename(filePath);
  const content = ext === ".md" ? raw : wrapPlainText(raw);

  return { title, content };
}
