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
import type {
  Dimension,
  DimensionName,
  DimensionsDatabase,
  IngestOutcome,
} from "../../dimensions/index.js";
import { resolveStackAuthority } from "../../dimensions/stack-authority.js";
import { projectSourceMarkdown } from "../../dimensions/wiki/source-projection.js";
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
import type { IngestResult, SourceType, WriteStatus } from "../../utils/types.js";

/** Input shape for raw-text ingestion. */
export interface IngestTextInput { title: string; text: string; source?: string }

/**
 * A Stack a caller ALREADY named, for a surface that resolves none for itself.
 *
 * The MCP tools carry the Stack as their own argument, so they must not reach
 * `resolveStackForCommand` — which is not a fallback that finds one: it reads the Stack
 * an ENVIRONMENT names and REFUSES by name when a database is configured and no Stack is
 * named. No code path creates a Stack implicitly. A Stack exists because its owner
 * created it over HTTP (`POST /stacks`), or because an operator seeded it from an
 * optional declaration at boot.
 * A named id is precedence 1 of `resolveStackAuthority`, which hands it back without
 * a lookup.
 * Callers that pass nothing here (the CLI, the HTTP host, the SDK) read the Stack their
 * own environment names, and are REFUSED — not provisioned — when they name none and a
 * database is configured.
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

/** The document one ingest writes: identity, title, its markdown, and its body. */
interface IngestDocumentInput { title: string; source: string; document: string; body: string }

/**
 * Write one source into `sources/`, for the named mode where this wiki has no database.
 *
 * S2 of `odd/tasks/single-stack-authority.md`: "a wiki with no database at all is a
 * legitimate mode". This is the whole of what an ingest still does in it, stated
 * rather than implied: the raw markdown lands at `sources/<slug>.md` and NOTHING else
 * is written. No `wiki.*` row, no page file under `wiki/`, no `.llmwiki/state.json` --
 * pages and compile state belong to `compile`, which reads this directory back from
 * disk, and that is what makes such a wiki file-backed rather than degraded.
 *
 * The file it writes is the SAME one the row-backed path projects after its commit,
 * through the same function: `projectSourceMarkdown` owns the slug-to-filename
 * resolution, the stable collision suffix, the path confinement and the
 * self-compensation after a failed write. Calling `saveSource` here would be a second
 * answer to "where does a source live".
 *
 * @param root - Project root; `sources/` is resolved against it.
 * @param input - Title, full markdown, and source identity.
 * @returns Where the source landed and whether it changed.
 */
async function ingestAsFiles(
  root: string,
  input: IngestDocumentInput,
): Promise<{ artifactPath: string; writeStatus: WriteStatus }> {
  const projected = await projectSourceMarkdown(root, input);
  return { artifactPath: projected.artifactPath, writeStatus: projected.writeStatus };
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
 * ## The Stack is decided ONCE, by the authority, and the mode is its answer
 *
 * `resolveStackAuthority` owns the precedence: the caller's id wins; otherwise a
 * configured database leaves the run to the Stack its environment NAMES, read through
 * `resolveStackForCommand`, which creates nothing; otherwise -- no database configured at
 * all -- the NAMED `file` mode. A configured database that names no Stack is a loud,
 * named refusal, never a provisioned row and never a file fallback: no code path creates
 * a Stack implicitly, and a Stack exists only because its owner created it over HTTP or
 * an operator seeded it from an explicit declaration.
 *
 * That is why nothing here reads `AKS_STACK_ID` or asks whether a DSN exists: an empty
 * id used to decide the mode by itself, and the two situations it conflated -- "this
 * wiki has no database", a supported wiki, and "a configured database answered no
 * Stack", an outage -- became one file-backed success. Only the second may fail, and
 * only the authority can tell them apart.
 *
 * The same id reaches the coordinator and the dimensions, so the two can never
 * disagree -- the job rows and the document CONTENT must land in one Stack. A second
 * resolution was a second answer: the job landed in the requested Stack while the
 * document went to the host's bound one, so a caller was told "unchanged, nothing to
 * do" about a Stack that did not contain the file at all.
 *
 * A caller that already knows the Stack (the MCP tool, whose argument is required)
 * supplies it as precedence 1: there is nothing to fall back to there, and a call that
 * named none is refused by name rather than handed a Stack nobody named. No code path
 * creates a Stack implicitly.
 *
 * @param root - Project root.
 * @param input - Source identity, title, frontmatter document, and body.
 * @param observer - Optional job observer.
 * @param env - Environment the dimensions write with; defaults to `process.env`.
 * @param explicitStackId - A Stack the CALLER named -- precedence 1 of the authority,
 *   so a caller that knows its Stack costs no lookup and creates nothing.
 * @param port - The dimensions, injected by the caller that owns them.
 *   OPTIONAL, and its omission is VALID: absent means "resolve the dimensions
 *   internally, exactly as this function always has", never "throw" and never
 *   "write to nothing". The loud refusal belongs to the API-owned entry points,
 *   which require a port and raise `MissingDimensionsPortError` when they were not
 *   given one; a shared function that threw on omission would break every caller
 *   that legitimately has no port (the SDK facade, the published surface).
 * @returns The written path and its write status.
 * @throws {LockBusyError} When another mutation holds the project lock.
 * @throws {StackAuthorityError} When a database is configured and no Stack resolves;
 *   never a file-backed result in that case.
 */
async function writeToDimensions(
  root: string,
  input: IngestDocumentInput,
  observer?: IngestJobObserver,
  env: NodeJS.ProcessEnv = process.env,
  explicitStackId?: string,
  port?: DimensionsPort<Dimension>,
): Promise<{ savedPath: string; writeStatus: NonNullable<IngestResult["writeStatus"]> }> {
  // Built for this operation and released right after, because an unclosed pool keeps
  // the event loop alive. Building it in the named file mode is harmless and measured,
  // not assumed: the pool is LAZY, so a run that never queries opens no socket. The mode
  // is not decided here -- the authority below decides it -- and the handle is passed
  // along for the row-backed work that follows: resolution provisions nothing and never
  // reads it.
  const dimensionsDb = createDimensionsDatabase(env);
  observer?.ingest.stage("preparing");
  const locked = await tryWithOrdinaryMutationLock(root, async () => {
    try {
      const authority = await resolveStackAuthority({
        stackId: explicitStackId,
        env,
        db: dimensionsDb.db,
      });
      // NO DATABASE CONFIGURED AT ALL: the source lands on disk and no row-shaped
      // dimension runs. `ingestDimensions` is keyed by a Stack, so it is not reached.
      if (authority.kind === "file") return await ingestAsFiles(root, input);
      observer?.ingest.stage("committing");
      return await ingestIntoStack(dimensionsDb, authority.stackId, { root, input, env, observer, port });
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
 * Write one document to the dimensions of ONE Stack, through the coordinator.
 *
 * ABSENT PORT MEANS RESOLVE INTERNALLY -- not "throw", not "write to nothing". The two
 * branches are deliberately the SAME resolution: the port forwards exactly the root,
 * handle, environment and Stack this run already holds, so an injected port cannot
 * answer a different question than the internal one. The refusal for a missing port
 * lives at the API-owned entry points that require one; here, omission is valid by
 * design, because the SDK facade and the published surface legitimately have none.
 *
 * A separate function because `writeToDimensions` branches on the authority's kind
 * first: keeping the coordinator call in that body would put the row-backed write and
 * the file-mode write in one scope, which is how a mode ends up decided twice.
 *
 * @param dimensionsDb - The handle the caller opened, and closes.
 * @param stackId - The Stack the authority resolved.
 * @param request - Project root, source input, the one environment this run reads, the
 *   job observer, and the caller's dimensions port when it supplied one.
 * @returns What the coordinator wrote.
 */
async function ingestIntoStack(
  dimensionsDb: DimensionsDatabase,
  stackId: string,
  request: {
    readonly root: string;
    readonly input: IngestDocumentInput;
    readonly env: NodeJS.ProcessEnv;
    readonly observer: IngestJobObserver | undefined;
    readonly port: DimensionsPort<Dimension> | undefined;
  },
): Promise<IngestOutcome> {
  const { root, input, env, observer, port } = request;
  // `env` reaches the dimensions because it carries the dimension switch, the Stack name
  // and the connection string; `stackId` settles the one question this run answered.
  return await ingestDimensions(
    dimensionsDb.db,
    stackId,
    input,
    port === undefined
      ? resolveDimensions({ root, db: dimensionsDb.db, env, stackId })
      : port.resolve({ only: INGEST_DIMENSIONS, env, root, db: dimensionsDb.db, stackId }),
    { attempts: observer?.attempts },
  );
}

/**
 * Ingest a source (URL, file, PDF, DOCX, image, or transcript) into `sources/`.
 *
 * @param root - Project root.
 * @param source - A URL (http/https), YouTube URL, local file, PDF, DOCX, or image path.
 * @param observer - Optional job observer.
 * @param env - Environment the dimensions write with; defaults to `process.env`.
 * @param stack - A Stack the caller named. Absent for every existing caller, which
 *   leaves the run to the Stack its own environment NAMES -- and refuses, naming what
 *   is missing, when it names none and a database is configured.
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
 * @param port - The dimensions, injected by the caller that owns them: the parameter
 *   `ingestSource` already takes, in the position `ingestSource` takes it. Omitted
 *   means "resolve internally", exactly as before.
 * @returns Structured ingest result with filename, char count, and source URI.
 * @throws {LockBusyError} When another mutation holds the project lock.
 */
export async function ingestTextSource(
  root: string,
  input: IngestTextInput,
  env: NodeJS.ProcessEnv = process.env,
  port?: DimensionsPort<Dimension>,
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
  //
  // `port` rides in the SAME trailing position `ingestSource` uses. It is the injected
  // resolution seam: a port this function accepted but did not forward would revert to
  // the ambient read, which makes the published option a decorative consumer.
  const { savedPath, writeStatus } = await writeToDimensions(root, {
    title: input.title,
    source,
    document,
    body: result.content,
  }, undefined, env, undefined, port);

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
