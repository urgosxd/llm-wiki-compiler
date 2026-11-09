/**
 * PDF ingestion module.
 *
 * Reads a local PDF file using the pdf-parse v2 PDFParse class, extracts the
 * text content via getText() and the document metadata via getInfo(). The title
 * comes from the PDF's Info dictionary when present, falling back to the
 * filename. Pages are joined into a single markdown body.
 *
 * ## Page boundaries are suppressed at the source, never stripped afterwards
 *
 * pdf-parse terminates every page's text with a separator line (`-- N of M --`
 * unless told otherwise). Left in, that line is cosmetic noise in a document
 * with real text and the ENTIRE extraction of a page that carries no text
 * operators — a scan, an image-only export, a broken generator — which is how a
 * zero-text PDF used to ingest as a page holding a page counter (S7).
 *
 * The first fix removed those lines by pattern-matching the extracted text after
 * the parse, and that approach cannot work. The separator is plain ASCII, so a
 * document whose own prose contains `-- 2 of 2 --` is indistinguishable from one
 * holding a real separator. That stripper deleted lines only when the matches
 * formed pdf-parse's complete `1..M` run, so a single lookalike line invalidated
 * the run and EVERY real separator leaked back into the stored text; loosening
 * it instead deletes prose. Both outcomes corrupt the document, and no amount of
 * cleverness over the finished string can separate the two cases.
 *
 * So the parser's own option does the job: `pageJoiner: ""` means "emit no
 * boundary at all", which is information only the parser has, because the parser
 * is the thing that knows where the pages are. Each page's text already ends with
 * a paragraph break, so joining on the empty string keeps the paragraph
 * separation between pages while adding no characters of its own.
 *
 * With this, a zero-text PDF yields `""` and the EXISTING shared
 * `enforceMinContent` guard rejects it with its EXISTING message.
 * `enforceMinContent` stays format-agnostic on purpose — it is shared by web,
 * file, image and transcript, and a pdf-parse literal inside it would mislead the
 * next reader of a validator that knows nothing about pages.
 *
 * ## Encryption fails with a sentence, not a stack
 *
 * A password-protected PDF is a user error, not a compiler fault: the file is
 * fine and the operator knows the password. pdf.js reports it as an error named
 * `PasswordException` whose message ("No password given") names neither the file
 * nor the remedy, so the adapter wraps that one case in an actionable message and
 * re-throws every other failure unchanged.
 *
 * pdf-parse (and its transitive pdfjs-dist) is imported dynamically so the
 * cost of loading the PDF parser is only paid when a PDF is actually being
 * ingested — `node dist/cli.js --help` and every other non-PDF code path
 * stays lean.
 */

import { readFile } from "fs/promises";
import { titleFromFilename, type IngestedSource } from "./shared.js";

/**
 * Value passed as pdf-parse's `pageJoiner`: append nothing at the end of a page.
 *
 * The parser's default is `"\n-- page_number of total_number --"`, which injects
 * the separator this module exists to keep out of the stored text. An empty
 * string is not "disable the join" — pages are still concatenated — it only
 * drops the marker the join would otherwise append.
 */
const NO_PAGE_SEPARATOR = "";

/**
 * The error name pdf.js and pdf-parse both assign to a password-protected file.
 *
 * Matched by NAME rather than by message, because the message is prose that drifts
 * between releases ("No password given" today) while the name is an explicit
 * literal in both layers: pdf.js sets it in its `BaseException` constructor, and
 * pdf-parse re-declares it on its own `PasswordException` when `getException` maps
 * the pdf.js error across the boundary. An `instanceof` against either class would
 * only survive a version where the error keeps coming from that same layer.
 */
const PASSWORD_PROTECTED_ERROR_NAME = "PasswordException";

/**
 * Decide whether a parse failure is the encrypted-document case.
 *
 * @param error - Whatever the parser rejected with.
 * @returns True when the document needs a password to be read.
 */
function isPasswordProtected(error: unknown): boolean {
  return error instanceof Error && error.name === PASSWORD_PROTECTED_ERROR_NAME;
}

/**
 * Build the actionable message for a password-protected PDF.
 *
 * Shaped like the DOCX failure message in `src/ingest/docx.ts`: which file, which
 * format, and what is actually wrong with it. One line, because this string is
 * what reaches the operator and a stack trace is not an explanation.
 *
 * @param filePath - Path that was passed to the adapter.
 * @returns The refusal message.
 */
function passwordProtectedMessage(filePath: string): string {
  return (
    `Failed to parse PDF "${filePath}": the file is password-protected and ` +
    `cannot be read without the password.`
  );
}

/** Extract the title from PDF metadata or fall back to the filename. */
export function resolveTitle(filePath: string, info: unknown): string {
  if (info && typeof info === "object") {
    const titleField = (info as Record<string, unknown>)["Title"];
    if (typeof titleField === "string" && titleField.trim().length > 0) {
      return titleField.trim();
    }
  }
  return titleFromFilename(filePath);
}

/**
 * Ingest a local PDF file and return its text content with the document title.
 *
 * pdf-parse is imported dynamically so this module's load cost stays minimal
 * for non-PDF code paths (the parser pulls in pdfjs-dist which is sizeable).
 *
 * @param filePath - Absolute or relative path to a .pdf file.
 * @returns An object with the document title and extracted text content.
 * @throws On read failure, an unparseable PDF, or a password-protected PDF.
 */
export default async function ingestPdf(filePath: string): Promise<IngestedSource> {
  const { PDFParse } = await import("pdf-parse");

  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    // Sequential calls are required: pdfjs-dist's LoopbackPort.postMessage
    // uses structuredClone internally; concurrent calls cause a DataCloneError
    // when the port tries to transfer the same underlying state simultaneously.
    const textResult = await parser.getText({ pageJoiner: NO_PAGE_SEPARATOR });
    const infoResult = await parser.getInfo();

    const title = resolveTitle(filePath, infoResult.info);
    return { title, content: textResult.text.trim() };
  } catch (error) {
    // The password case gets a message naming the file and the cause; every other
    // failure keeps the parser's own error, which the corrupt-PDF tests pin.
    if (isPasswordProtected(error)) {
      throw new Error(passwordProtectedMessage(filePath));
    }
    throw error;
  } finally {
    await parser.destroy();
  }
}
