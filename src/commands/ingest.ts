/**
 * Commander action for `llmwiki ingest <source>`.
 *
 * This module is now TRANSPORT ONLY. The ingest pipeline — source detection,
 * fetching, truncation, the dimension transaction, and journaling — lives in
 * `src/services/ingest/`, so the CLI, the MCP server, and the HTTP host all reach
 * the same code. That is not tidiness: ingest writes across a markdown file and
 * Postgres, which share no transaction manager, so a client that bypassed the
 * service would silently lose the synchronization guarantee.
 *
 * What remains here is the CLI's own presentation: read `process.cwd()`, print
 * the saved path, and suggest the next command.
 *
 * The pipeline helpers are RE-EXPORTED so existing consumers keep their import
 * paths. Moving a definition and its consumers in one step would have made this
 * refactor impossible to review.
 */

import path from "path";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { ingestSource } from "../services/ingest/service.js";

export { ingestSource, ingestTextSource, journalSavedPath } from "../services/ingest/service.js";
export type { IngestTextInput } from "../services/ingest/service.js";
export { detectSourceType } from "../services/ingest/source-detection.js";
export { buildDocument, enforceCharLimit } from "../services/ingest/document.js";

/**
 * Ingest a source and save it to the sources/ directory.
 * @param source - A URL (http/https), YouTube URL, local file, PDF, or image path.
 */
export default async function ingest(source: string): Promise<void> {
  const cwd = process.cwd();
  const result = await ingestSource(cwd, source);
  const savedPath = path.join(cwd, SOURCES_DIR, result.filename);

  output.status(
    "+",
    output.success(`Saved ${output.bold(result.filename)} → ${output.source(savedPath)}`)
  );
  output.status("→", output.dim("Next: llmwiki compile"));
}
