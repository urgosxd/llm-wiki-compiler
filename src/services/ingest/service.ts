/**
 * @file src/services/ingest/service.ts
 * @description The ingest transaction, owned in one place.
 *
 * Every client that ingests — the CLI, the MCP server, and the HTTP host — must
 * reach THIS code. The reason is not tidiness: ingest writes across two systems
 * that share no transaction manager (a markdown file on the filesystem and rows
 * in Postgres), so the project lock and the dimension coordinator are the only
 * things keeping them in sync. A client that took a different path would silently
 * lose that guarantee.
 *
 * ## The lock wraps the whole transaction
 *
 * `saveSource` and the journal each take the lock around their own file
 * operation, which protects one write and not one run. Two concurrent ingests
 * could interleave their wiki and graph commits, and a rollback triggered by one
 * would revert the other's file. The lock therefore spans prepare + commit +
 * discard, and it lives in `.llmwiki/`, so it excludes across PROCESSES — the MCP
 * server is a separate process over the same project.
 *
 * Fail-fast, not blocking: a request handler that waited would park invisibly for
 * as long as another client's ingest takes. Callers get `LockBusyError` and retry
 * on their own terms.
 */

import path from "path";
import { createHash } from "node:crypto";
import {
  createDimensionsDatabase,
  ingestDimensions,
  resolveDimensions,
  resolveStackId,
} from "../../dimensions/index.js";
import { tryWithOrdinaryMutationLock } from "../../operation-bundles/with-mutation-lock.js";
import { LockBusyError } from "../../utils/lock.js";
import { appendLog } from "../../utils/activity-log.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import * as output from "../../utils/output.js";
import { verbose } from "../../utils/output.js";
import ingestWeb from "../../ingest/web.js";
import ingestFile from "../../ingest/file.js";
import ingestPdf from "../../ingest/pdf.js";
import ingestImage from "../../ingest/image.js";
import ingestTranscript from "../../ingest/transcript.js";
import { buildDocument, enforceCharLimit, enforceMinContent } from "./document.js";
import { detectSourceType } from "./source-detection.js";
import type { IngestResult, SourceType } from "../../utils/types.js";

/** Input shape for raw-text ingestion. */
export interface IngestTextInput { title: string; text: string; source?: string }

/** Format the root-relative source reference recorded in the Markdown journal. */
export function journalSavedPath(savedPath: string, pathApi = path): string {
  return `${SOURCES_DIR}/${pathApi.basename(savedPath)}`;
}

/** Fetch content from the appropriate ingestion module based on source type. */
async function fetchContent(
  source: string,
  sourceType: SourceType,
): Promise<{ title: string; content: string }> {
  switch (sourceType) {
    case "web":
      return ingestWeb(source);
    case "pdf":
      return ingestPdf(source);
    case "image":
      return ingestImage(source);
    case "transcript":
      return ingestTranscript(source);
    case "file":
      return ingestFile(source);
  }
}

/**
 * Append a root-bound ingest entry to the activity journal (`log.md`).
 * Shared by both ingest paths so they journal identically: under the project
 * `root` (not cwd) with a root-relative `Saved` path, keeping the entry portable
 * regardless of the caller's working directory.
 */
async function journalIngest(
  root: string,
  title: string,
  source: string,
  savedPath: string,
  charCount: number,
): Promise<void> {
  await appendLog(root, "ingest", title, {
    details: [
      `Source: ${source}`,
      `Saved: ${journalSavedPath(savedPath)}`,
      `Chars: ${charCount.toLocaleString()}`,
    ],
  });
}

/**
 * Write one document to every enabled dimension, atomically.
 *
 * The coordinator owns ordering and compensation; this helper only adapts the
 * caller's shape (title, document, body) to the dimension port and unwraps what
 * the caller needs back. Dimensions come from `LLMWIKI_DIMENSIONS`; unset means
 * wiki only, so this is behaviour-preserving for projects that never asked for a
 * graph.
 *
 * @param root - Project root.
 * @param input - Source identity, title, frontmatter document, and body.
 * @returns The written path and its write status.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
async function writeToDimensions(
  root: string,
  input: { title: string; source: string; document: string; body: string },
): Promise<{ savedPath: string; writeStatus: NonNullable<IngestResult["writeStatus"]> }> {
  // Pages are rows in Postgres now, so the dimensions need a handle. It is built
  // for this operation and released right after, because an unclosed pool keeps
  // the event loop alive.
  const dimensionsDb = createDimensionsDatabase();
  const locked = await tryWithOrdinaryMutationLock(root, async () => {
    try {
      return await ingestDimensions(
        dimensionsDb.db,
        resolveStackId(),
        input,
        resolveDimensions({ root, db: dimensionsDb.db }),
      );
    } finally {
      await dimensionsDb.close();
    }
  });
  if (locked.busy) {
    // The project's existing lock error: callers already branch on it.
    throw new LockBusyError(0);
  }
  const outcome = locked.value;
  if (outcome.artifactPath === undefined) {
    throw new Error(`no file-backed dimension reported a write path for ${input.source}`);
  }
  return { savedPath: outcome.artifactPath, writeStatus: outcome.writeStatus ?? "created" };
}

/**
 * Ingest a source (URL, file, PDF, image, or transcript) into `sources/`.
 *
 * @param root - Project root.
 * @param source - A URL (http/https), YouTube URL, local file, PDF, or image path.
 * @returns Saved filename, character count, truncation flag, source URI, and source type.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
export async function ingestSource(root: string, source: string): Promise<IngestResult> {
  const sourceType = await detectSourceType(source);
  output.status("*", output.info(`Ingesting [${sourceType}]: ${source}`));
  verbose(`source type: ${sourceType}`);

  const { title, content } = await fetchContent(source, sourceType);
  verbose(`fetched: ${content.length} chars`);

  const result = enforceCharLimit(content);
  enforceMinContent(result.content);
  const document = buildDocument(title, source, result, sourceType);
  const { savedPath, writeStatus } = await writeToDimensions(root, {
    title,
    source,
    document,
    body: result.content,
  });
  verbose(`saved: ${savedPath} (${result.content.length} chars extracted)`);

  // Journal only real writes — a no-op re-ingest must not append a log line.
  if (writeStatus !== "unchanged") {
    await journalIngest(root, title, source, savedPath, result.content.length);
  }

  return {
    filename: path.basename(savedPath),
    charCount: result.content.length,
    truncated: result.truncated,
    source,
    sourceType,
    writeStatus,
  };
}

/**
 * Ingest raw text directly into the wiki sources directory.
 *
 * When `source` is omitted a deterministic synthetic identity
 * `manual:<sha256(title,text)>` is derived so that identical content is
 * idempotent and differing content coexists (mirrors saveSource collision rules).
 * The hash is fed a length-prefixed title so the title/text boundary is
 * unambiguous — a raw separator (newline) or bare concatenation would let a
 * boundary-shifted pair collide (e.g. title="a",text="b" vs title="ab",text="").
 *
 * @param root - Absolute path to the wiki root directory.
 * @param input - Title, raw text body, and optional explicit source identity.
 * @returns Structured ingest result with filename, char count, and source URI.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
export async function ingestTextSource(root: string, input: IngestTextInput): Promise<IngestResult> {
  const digest = createHash("sha256")
    .update(`${input.title.length}\n`)
    .update(input.title)
    .update(input.text)
    .digest("hex");
  const source = input.source ?? `manual:${digest}`;
  const result = enforceCharLimit(input.text);
  enforceMinContent(result.content);
  const document = buildDocument(input.title, source, result, "file");
  const { savedPath, writeStatus } = await writeToDimensions(root, {
    title: input.title,
    source,
    document,
    body: result.content,
  });

  // Journal only real writes — a no-op re-ingest must not append a log line.
  if (writeStatus !== "unchanged") {
    await journalIngest(root, input.title, source, savedPath, result.content.length);
  }

  return {
    filename: path.basename(savedPath),
    charCount: result.content.length,
    truncated: result.truncated,
    source,
    sourceType: "file",
    writeStatus,
  };
}
