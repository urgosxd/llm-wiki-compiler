/**
 * @file src/services/ingest/document.ts
 * @description Turn fetched source text into the markdown document that gets
 * written to `sources/`: enforce the size floor and ceiling, and build the
 * frontmatter that records where the document came from.
 *
 * Extracted from `src/commands/ingest.ts`. These are pure transformations of a
 * string except for the two warnings they emit, which report a decision the
 * operator needs to know about (content was cut, or content is suspiciously
 * short). The warning stays here rather than moving to the transport because it
 * describes what happened to the DOCUMENT, and every client would otherwise have
 * to re-derive it.
 */

import { buildFrontmatter } from "../../utils/markdown.js";
import { MAX_SOURCE_CHARS, MIN_SOURCE_CHARS } from "../../utils/constants.js";
import * as output from "../../utils/output.js";
import type { SourceType } from "../../utils/types.js";

/** Truncate result including whether truncation occurred and original length. */
export interface TruncateResult {
  content: string;
  truncated: boolean;
  originalChars: number;
}

/** Truncate content if it exceeds the character limit, logging a warning. */
export function enforceCharLimit(content: string): TruncateResult {
  if (content.length <= MAX_SOURCE_CHARS) {
    return { content, truncated: false, originalChars: content.length };
  }

  output.status(
    "!",
    output.warn(
      `Content truncated from ${content.length.toLocaleString()} to ${MAX_SOURCE_CHARS.toLocaleString()} characters.`
    )
  );
  return {
    content: content.slice(0, MAX_SOURCE_CHARS),
    truncated: true,
    originalChars: content.length,
  };
}

/**
 * Reject empty content and warn when content is trivially short.
 *
 * Empty content is a hard error rather than an empty page: a source that
 * extracted nothing is a failed ingest, not a successful one that happens to be
 * blank.
 *
 * @param content - Text after truncation.
 * @throws When no readable content could be extracted.
 */
export function enforceMinContent(content: string): void {
  const length = content.trim().length;

  if (length === 0) {
    throw new Error(
      "No readable content could be extracted from the source."
    );
  }

  if (length < MIN_SOURCE_CHARS) {
    output.status(
      "!",
      output.warn(
        `Content seems very short (${length} chars, minimum recommended is ${MIN_SOURCE_CHARS}).`
      )
    );
  }
}

/** Build the full markdown document with frontmatter. */
export function buildDocument(
  title: string,
  source: string,
  result: TruncateResult,
  sourceType?: SourceType,
): string {
  const meta: Record<string, unknown> = {
    title,
    source,
    ingestedAt: new Date().toISOString(),
  };
  if (sourceType !== undefined) {
    meta.sourceType = sourceType;
  }
  if (result.truncated) {
    meta.truncated = true;
    meta.originalChars = result.originalChars;
  }
  const frontmatter = buildFrontmatter(meta);

  return `${frontmatter}\n\n${result.content}\n`;
}
