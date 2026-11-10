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

import { tryWithOrdinaryMutationLock } from "../../utils/mutation-lock.js";
import path from "path";
import { createHash } from "node:crypto";
import type { DimensionsPort } from "../../sdk/core-types.js";
import {
  createDimensionsDatabase,
  ingestDimensions,
  resolveDimensions,
} from "../../dimensions/index.js";
import type { Dimension, DimensionName } from "../../dimensions/index.js";
import { resolveStackForCommand } from "../stacks/resolve-stack.js";
import { LockBusyError } from "../../utils/lock.js";
import { appendLog } from "../../utils/activity-log.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import * as output from "../../utils/output.js";
import { verbose } from "../../utils/output.js";
import ingestWeb from "../../ingest/web.js";
import ingestFile from "../../ingest/file.js";
import ingestPdf from "../../ingest/pdf.js";
import ingestDocx from "../../ingest/docx.js";
import ingestImage from "../../ingest/image.js";
import ingestTranscript from "../../ingest/transcript.js";
import { buildDocument, enforceCharLimit, enforceMinContent } from "./document.js";
import { detectSourceType } from "./source-detection.js";
import type { IngestJobObserver } from "./jobs/types.js";
import type { IngestResult, SourceType } from "../../utils/types.js";

/** Input shape for raw-text ingestion. */
export interface IngestTextInput { title: string; text: string; source?: string }

/**
 * A Stack a caller ALREADY named, for a surface where no default may be resolved.
 *
 * The MCP tools carry the Stack as their own argument, so they must not reach
 * `resolveStackForCommand` — that helper provisions a default Stack when the
 * environment names none, which is exactly the fallback the tool path no longer has.
 * Callers that pass nothing here (the CLI, the HTTP host, the SDK) keep the
 * resolution they have always had.
 */
export interface IngestStackArgument { readonly stackId?: string }

/**
 * The dimensions an ingest may write, in the order they are written.
 *
 * A CEILING, not an answer: `resolveDimensions` intersects it with
 * `LLMWIKI_DIMENSIONS`, so an environment that enables only `wiki` still writes
 * only `wiki`. It exists because a `DimensionsPort` must be TOLD which dimensions
 * a caller may receive -- `DimensionsRequest.only` is required, because a
 * resolution that does not state its narrowing has lost the configuration it was
 * supposed to pass -- and because the refusal a port-less api caller receives names
 * the dimensions it asked for.
 */
export const INGEST_DIMENSIONS: readonly DimensionName[] = ["wiki", "kg"];

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
    case "docx":
      return ingestDocx(source);
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
 *
 * @param env - Environment naming the Stack this ingest wrote to; `process.env` when
 *   omitted. The journal is appended as ROWS for whichever Stack the environment
 *   names, so an ingest performed for a NAMED Stack must pass that environment or the
 *   entry lands in the deployment's journal instead of the tenant's.
 */
async function journalIngest(
  root: string,
  title: string,
  source: string,
  savedPath: string,
  charCount: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await appendLog(root, "ingest", title, {
    details: [
      `Source: ${source}`,
      `Saved: ${journalSavedPath(savedPath)}`,
      `Chars: ${charCount.toLocaleString()}`,
    ],
    env,
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
 * @param observer - Optional job observer.
 * @param env - Environment the dimensions write with; defaults to `process.env`.
 * @param explicitStackId - A Stack the CALLER named. When absent the Stack is resolved
 *   from `env` exactly as before, default Stack included.
 * @param port - The dimensions, injected by the caller that owns them.
 *   OPTIONAL, and its omission is VALID: absent means "resolve the dimensions
 *   internally, exactly as this function always has", never "throw" and never
 *   "write to nothing". The loud refusal belongs to the API-owned entry points,
 *   which require a port and raise `MissingDimensionsPortError` when they were not
 *   given one; a shared function that threw on omission would break every caller
 *   that legitimately has no port (the SDK facade, the published surface).
 * @returns The written path and its write status.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
async function writeToDimensions(
  root: string,
  input: { title: string; source: string; document: string; body: string },
  observer?: IngestJobObserver,
  env: NodeJS.ProcessEnv = process.env,
  explicitStackId?: string,
  port?: DimensionsPort<Dimension>,
): Promise<{ savedPath: string; writeStatus: NonNullable<IngestResult["writeStatus"]> }> {
  // Pages are rows in Postgres now, so the dimensions need a handle. It is built
  // for this operation and released right after, because an unclosed pool keeps
  // the event loop alive.
  const dimensionsDb = createDimensionsDatabase(env);
  observer?.ingest.stage("preparing");
  const locked = await tryWithOrdinaryMutationLock(root, async () => {
    try {
      // The Stack is resolved ONCE and the same value is handed to both the
      // coordinator and the dimensions, so the two can never disagree -- the job rows
      // and the document CONTENT must land in one Stack. A second resolution was a
      // second answer: the job landed in the requested Stack while the document went
      // to the host's bound one, so a caller was told "unchanged, nothing to do"
      // about a Stack that did not contain the file at all.
      //
      // `resolveStackForCommand` rather than `resolveStackId`: a checkout that
      // configured no Stack is no longer a refusal here, it is the default Stack. The
      // strict helper stays as it is, because the surfaces that must refuse -- the MCP
      // deployment binding -- still need it.
      //
      // A caller that already knows the Stack (the MCP tool, whose argument is
      // required) skips the resolution entirely: there is no default to fall back to
      // there, and asking for one would provision a Stack nobody named.
      const stackId = explicitStackId ?? await resolveStackForCommand(dimensionsDb.db, env);
      observer?.ingest.stage("committing");
      return await ingestDimensions(
        dimensionsDb.db,
        stackId,
        input,
        // ABSENT PORT MEANS RESOLVE INTERNALLY -- not "throw", not "write to
        // nothing". The two branches are deliberately the SAME resolution: the port
        // forwards exactly the root, handle, environment and Stack this function
        // already holds, so an injected port cannot answer a different question than
        // the internal one. The refusal for a missing port lives at the API-owned
        // entry points that require one; here, omission is valid by design.
        //
        // `env` still reaches the dimensions because it carries the dimension switch,
        // the Stack name and the connection string; `stackId` settles the one question
        // this function already answered.
        port === undefined
          ? resolveDimensions({ root, db: dimensionsDb.db, env, stackId })
          : port.resolve({ only: INGEST_DIMENSIONS, env, root, db: dimensionsDb.db, stackId }),
        { attempts: observer?.attempts },
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
  observer?.ingest.stage("projecting");
  return { savedPath: outcome.artifactPath, writeStatus: outcome.writeStatus ?? "created" };
}

/**
 * Ingest a source (URL, file, PDF, DOCX, image, or transcript) into `sources/`.
 *
 * @param root - Project root.
 * @param source - A URL (http/https), YouTube URL, local file, PDF, DOCX, or image path.
 * @param observer - Optional job observer.
 * @param env - Environment the dimensions write with; defaults to `process.env`.
 * @param stack - A Stack the caller named. Absent for every existing caller, which
 *   keeps the environment's selection (default Stack included) unchanged.
 * @param port - The dimensions, injected by the caller that owns them. Omitted means
 *   "resolve internally", exactly as before; see {@link writeToDimensions}.
 * @returns Saved filename, character count, truncation flag, source URI, and source type.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
export async function ingestSource(
  root: string,
  source: string,
  observer?: IngestJobObserver,
  env: NodeJS.ProcessEnv = process.env,
  stack: IngestStackArgument = {},
  port?: DimensionsPort<Dimension>,
): Promise<IngestResult> {
  observer?.ingest.stage("detecting");
  const sourceType = await detectSourceType(source);
  output.status("*", output.info(`Ingesting [${sourceType}]: ${source}`));
  verbose(`source type: ${sourceType}`);

  observer?.ingest.stage("fetching");
  const { title, content } = await fetchContent(source, sourceType);
  verbose(`fetched: ${content.length} chars`);

  observer?.ingest.stage("extracting");
  const result = enforceCharLimit(content);
  enforceMinContent(result.content);
  const document = buildDocument(title, source, result, sourceType);
  const { savedPath, writeStatus } = await writeToDimensions(root, {
    title,
    source,
    document,
    body: result.content,
  }, observer, env, stack.stackId, port);
  verbose(`saved: ${savedPath} (${result.content.length} chars extracted)`);

  // Journal only real writes — a no-op re-ingest must not append a log line.
  if (writeStatus !== "unchanged") {
    observer?.ingest.stage("journaling");
    // The SAME environment the dimensions wrote with, so the entry names the tenant
    // whose pages were just written rather than the deployment this process runs in.
    await journalIngest(root, title, source, savedPath, result.content.length, env);
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
 * @param env - Environment naming the Stack this ingest writes to; `process.env` when
 *   omitted. A caller that resolved the request environment must pass it, or the
 *   document and its journal entry land in the AMBIENT Stack instead of the one the
 *   request named.
 * @returns Structured ingest result with filename, char count, and source URI.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
export async function ingestTextSource(
  root: string,
  input: IngestTextInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestResult> {
  const digest = createHash("sha256")
    .update(`${input.title.length}\n`)
    .update(input.title)
    .update(input.text)
    .digest("hex");
  const source = input.source ?? `manual:${digest}`;
  const result = enforceCharLimit(input.text);
  enforceMinContent(result.content);
  const document = buildDocument(input.title, source, result, "file");
  // `env` keeps the position it has in `ingestSource`, and is forwarded rather than
  // dropped: omitting it here made this path resolve the tenant from the ambient
  // environment, so a request for one Stack wrote into the deployment's.
  const { savedPath, writeStatus } = await writeToDimensions(root, {
    title: input.title,
    source,
    document,
    body: result.content,
  }, undefined, env);

  // Journal only real writes — a no-op re-ingest must not append a log line.
  if (writeStatus !== "unchanged") {
    await journalIngest(root, input.title, source, savedPath, result.content.length, env);
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
