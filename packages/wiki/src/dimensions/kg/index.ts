/**
 * @file src/dimensions/kg.ts
 * @description The `kg` dimension: ingest into the Agent Knowledge Standard graph.
 *
 * The knowledge-graph implementation is **not authored here**. It is the
 * vendored reference server under `packages/llmwiki-kg`, consumed in process
 * through its library barrel. This module is the adapter: it sequences the
 * vendored core's steps and maps them onto the dimension contract.
 *
 * ## Why the write is split across `prepare` and `commit`
 *
 * The graph write is the expensive, fallible half of an ingest: it chunks and
 * embeds text, calls an extraction model, and consolidates entities and edges
 * into Postgres. Graph work runs as the **last** step, after the wiki write has
 * landed, so a graph failure never strands a source the wiki never received.
 *
 * `prepare` does chunking, embedding, and extraction without touching the graph
 * tables. `commit` performs the consolidation — the step that makes rows
 * visible. A prepared-but-uncommitted graph has nothing to undo, so `discard`
 * is a no-op and the outbox covers a `commit` that fails partway.
 *
 * ## Detect-only runs, and the two doors before the spend
 *
 * `prepare` is the only place where a run that must not cost money can still be stopped
 * for free, so BOTH doors are there and both are before the first request:
 *
 * - a detect-only run (`KgDimensionOptions.dryRun`) computes the chunk count with the
 *   chunker ALONE — the same `splitText` call `chunkAndEmbed` makes internally — and
 *   returns a handle carrying what it WOULD have sent. It never reaches `embedTexts` and
 *   never reaches the extraction model. `commit` needs no knowledge of it: the handle
 *   holds no chunks, so its existing empty-write branch is the right outcome, and the
 *   summary it renders carries the report.
 * - a run whose chunk count exceeds the configured cap is REFUSED by name rather than
 *   truncated (`./request-cap.ts`). Extracting half a document and reporting success
 *   would read exactly like a complete run.
 *
 * Neither door changes the chunk boundaries a real run produces: both count with the same
 * chunker, the same default size and the same overlap.
 *
 * ## Credentials and database
 *
 * The vendored core reads provider credentials and `DATABASE_URL` from the
 * process environment through its own `config` module, exactly as when run as a
 * standalone server. This adapter adds no second configuration layer.
 *
 * What it does add is a door: the vendored config bridges the wiki dimension's
 * embedding credentials into that namespace, and `prepare` refuses a
 * configuration the bridge could not complete BEFORE any provider or database
 * call. A missing credential has to name the variable to set; a 401 from a
 * remote provider names nothing and costs a round trip.
 *
 * The bridge is the env-shaped half. The other half is the descriptor the wiki
 * dimension's own provider reports (`describeEmbeddingBackend`): endpoint,
 * credential and model as they were actually resolved, so the kg dimension
 * reaches the same OpenAI-compatible service whatever that service is, with no
 * provider table and no second endpoint convention. It is injected per call and
 * only fills what the KG side left blank.
 *
 * Extraction runs on the same two halves, deliberately kept apart: the env side
 * is the KG's own `EXTRACTION_*` namespace (never bridged from the wiki side),
 * and the descriptor side is the wiki provider's CHAT report
 * (`describeChatBackend`). A chat descriptor and an embedding descriptor are
 * different services in a real deployment — often on different hosts — so each
 * is installed around its own call and neither may supply the other's request.
 */

import { createHash } from "node:crypto";
import {
  chunkAndEmbed,
  ConfigValidationError,
  configuresOwnChatBackend,
  configuresOwnEmbeddingBackend,
  consolidateEntityRows,
  consolidateRelationshipRows,
  registerDocumentRow,
  createClient,
  createDatabase,
  extractGraphFromChunks,
  findEmbeddingCredentialProblem,
  findEmbeddingModelProblem,
  findExtractionCredentialProblem,
  kgConfig,
  forgetDocumentRows,
  prepareChatBackend,
  prepareEmbeddingBackend,
  readStackOntology,
  splitText,
  withChatBackend,
  withEmbeddingBackend,
  type ChunkResult,
  type ChatBackendDescriptor,
  type ChatBackendRun,
  type EmbeddingBackendDescriptor,
  type EmbeddingBackendRun,
  type ExtractedEntity,
  type ExtractedRelationship,
} from "@repo/kg";
import { defaultOntology, loadStoredOntology } from "@repo/kg";
import type { DatabaseHandle } from "@repo/foundation";
import type { ExtractionResult, Ontology } from "@repo/kg";

import {
  assertWithinExtractionRequestCap,
  resolveExtractionRequestCap,
} from "./request-cap.js";

import { getEmbeddingProvider } from "../../utils/embedding-provider.js";
import { getProvider } from "../../utils/provider.js";
import type {
  CommittedWrite,
  CommitScope,
  Dimension,
  DimensionInput,
  PreparedWrite,
} from "../types.js";

/** One triplet rejection, derived from the core's own result shape. */
type KgRejection = NonNullable<ExtractionResult["rejected"]>[number];

/** Seconds to wait for the graph database before giving up. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Chars of a source digest kept in an in-memory chunk label. */
const SOURCE_LABEL_CHARS = 32;

/**
 * Embedding requests one document costs, however many chunks it has.
 *
 * `embedTexts` sends the whole chunk list in ONE HTTP round trip, so the per-document
 * count is always this — never one per chunk. The measured baseline states the same fact
 * from the other side: four chunks, one embedding request.
 */
const EMBEDDING_REQUESTS_PER_BATCH = 1;

/**
 * Stable per-source label for in-memory chunk metadata.
 *
 * Deliberately independent of the body: editing a source must not change which
 * source its chunks are labelled as. This is metadata only — it never becomes a
 * database key.
 *
 * @param source - Source identity (URL or path).
 * @returns A 32-char hex digest of the source alone.
 */
function sourceLabel(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, SOURCE_LABEL_CHARS);
}

/**
 * What a detect-only run would have sent, all of it derived without a provider call.
 *
 * S10 is the reason this exists: a dry run whose answer is only "ok" has learned nothing,
 * and the numbers an operator needs before approving a real run are exactly these — how
 * many requests the document costs and whether that fits the cap. Every count here comes
 * from the chunker's output, so reporting them costs a tokenisation pass and no network.
 */
interface DryRunReport {
  /** Chunks the real path would produce, and therefore the unit requests are counted in. */
  readonly chunks: number;
  /** Chat requests extraction would send: one per chunk, sequentially. */
  readonly chatRequests: number;
  /** Embedding requests chunking would send: the whole chunk list in one batch. */
  readonly embeddingRequests: number;
  /** The cap the would-be request count was judged against. */
  readonly cap: number;
}

/** Handle carried between `prepare` and `commit` for the graph dimension. */
interface KgHandle {
  /**
   * Document id, assigned by Postgres during `commit`.
   *
   * It is NOT known at prepare time and cannot be derived: `stack_documents.id`
   * defaults to `gen_random_uuid()` and the row does not exist yet. The earlier
   * adapter synthesized a 32-hex id from source+body, which happened to cast to
   * UUID but matched no row, so the `entity_source_documents.document_id`
   * foreign key rejected every consolidation.
   */
  documentId: string;
  /** Source identity and body, kept so `commit` can register the row. */
  readonly registration: { readonly source: string; readonly body: string; readonly title: string };
  readonly chunks: readonly ChunkResult[];
  readonly entities: readonly ExtractedEntity[];
  readonly relationships: readonly ExtractedRelationship[];
  /** Triplets the declared ontology turned away; empty when none was supplied. */
  readonly rejected: readonly KgRejection[];
  /**
   * Chunks whose extraction failed after every retry was spent.
   *
   * Carried so the commit summary can say a document was extracted from SOME of
   * its chunks. The all-failed case never gets here: it raises inside
   * `extractGraphFromChunks`, which fails `prepare` and therefore the ingest.
   */
  readonly failedChunks: number;
  /**
   * Chunks that answered with no usable envelope at all.
   *
   * Carried for the same reason as {@link failedChunks}, and kept separate from
   * it because the two read differently to an operator: a failed chunk names a
   * provider problem, while a mangled one names a response the model should
   * never have produced. Neither is fatal, and neither makes the ingest fail.
   */
  readonly mangledChunks: number;
  /**
   * `type` values the model emitted outside the schema its Stack declared.
   *
   * Carried for the same reason as {@link mangledChunks} and kept separate from
   * {@link KgHandle.rejected}: a triplet whose type the model invented and a
   * triplet the ontology turned away are usually the same triplet, but only the
   * first one names a provider that did not enforce the schema — which is the
   * difference between "fix the prompt" and "this gateway ignores `strict`".
   */
  readonly schemaViolations: number;
  /**
   * What a detect-only run would have sent; absent for a run that extracted for real.
   *
   * Present only on the handle a dry run returns, which holds no chunks and no entities.
   * `commit` renders it through {@link summaryFor} without asking whether the run was a
   * dry one, so the mode stays a property of `prepare` alone.
   */
  readonly dryRunReport?: DryRunReport;
}

/** How this dimension is bound to one knowledge stack. */
export interface KgDimensionOptions {
  /** Knowledge stack the document belongs to. */
  readonly stackId: string;
  /** Stack name passed to the extraction prompt for context. */
  readonly stackName: string;
  /** Postgres connection string; defaults to the vendored core's own config. */
  readonly databaseUrl?: string;
  /**
   * Detect-only mode: report what extraction WOULD send, and send none of it.
   *
   * A dry run makes zero provider requests — no embedding batch and no completion — and
   * still answers with the chunk count, the chat requests and the embedding batch the
   * real run would cost, judged against the configured request cap. It opens no database
   * connection for the write and holds no entities. Counted, not guessed: every number
   * comes from the chunker the real path uses, so the report describes the real run's
   * boundaries exactly.
   */
  readonly dryRun?: boolean;
  /**
   * Declared entity and relationship types this Stack's graph may contain.
   *
   * Omitted means the oracle's behaviour: the model sees the default type hints
   * and whatever it emits is accepted, because `strict=False`. Supplied means
   * the declaration is enforced — the types go into the tool schema and every
   * triplet outside them is dropped and reported.
   *
   * An explicit value takes precedence over {@link loadOntology} and stops it
   * from being called at all, which is what lets a caller override the database
   * without editing it.
   */
  readonly ontology?: Ontology;
  /**
   * Reads this Stack's stored declaration, called once per `prepare`.
   *
   * Injected rather than imported so the two consumers can differ: the compiler
   * supplies the Postgres reader, while tests and detect-only runs supply a stub
   * and stay free of a database. Omitted means "no stored declaration", which is
   * the oracle's behaviour — NOT a silent default, because there is nothing to
   * read.
   */
  readonly loadOntology?: (stackId: string, databaseUrl?: string) => Promise<unknown>;
  /**
   * Describes the embedding backend the wiki dimension resolved, called once per
   * `prepare`.
   *
   * Injected for the same reason as {@link loadOntology}: the compiler supplies
   * the host's real resolution, while tests supply a stub. Omitted means the
   * host's own resolution is used, so a caller never has to know how the wiki
   * side builds its provider.
   */
  readonly describeEmbeddingBackend?: () => EmbeddingBackendDescriptor | undefined;
  /**
   * Describes the CHAT backend the wiki dimension resolved, called once per step
   * that needs it: the extraction call in `prepare`, and the graph write in
   * `commit` that records which model produced each row.
   *
   * Injected for the same reason as {@link describeEmbeddingBackend}, and kept a
   * separate member for a stronger one: the wiki's chat and embedding services
   * are different hosts in a real deployment, so the two descriptors must be
   * independently replaceable — and independently observable.
   */
  readonly describeChatBackend?: () => ChatBackendDescriptor | undefined;
}

/**
 * Resolves the ontology this run must enforce, reading the Stack if needed.
 *
 * ## Why an unreadable declaration fails the run
 *
 * A malformed declaration could be swallowed into `undefined`, and the run would
 * proceed with the oracle's permissive behaviour. That is the one outcome this
 * feature must never produce: an operator who declared a schema and silently got
 * default extraction would believe the graph is constrained when it is not. The
 * error propagates, and `prepare` fails before a single triplet is extracted.
 *
 * ## Why the explicit option short-circuits
 *
 * Reading the database to discard the answer would make an override depend on a
 * reachable database it does not actually need.
 *
 * A Stack with no stored declaration is enforced against the documented default,
 * not left permissive. `readStackOntology` still returns `undefined` for a null
 * column — that is the reader's honest answer to "what is stored" — so the
 * default is applied here, at the boundary that knows a Stack exists.
 *
 * @param options - Stack binding, optional override, optional loader.
 * @returns The ontology to enforce; never `undefined`.
 * @throws {OntologyError} When the stored declaration is present but invalid.
 */
async function resolveOntology(options: KgDimensionOptions): Promise<Ontology> {
  if (options.ontology !== undefined) return options.ontology;
  const load = options.loadOntology ?? loadStoredOntology;
  const stored = await load(options.stackId, options.databaseUrl);
  return readStackOntology(stored) ?? defaultOntology();
}

/**
 * Trailing arguments for the extraction call, omitting the ontology when absent.
 *
 * @param ontology - The ontology to enforce, or `undefined` for none.
 * @returns An empty tuple without an ontology, or the single-element tuple with it.
 */
function ontologyArgs(ontology: Ontology | undefined): [] | [Ontology] {
  return ontology === undefined ? [] : [ontology];
}

/**
 * Renders the rejection count for a commit summary, or nothing when clean.
 *
 * A summary is the only per-document signal a caller sees without querying the
 * graph, so a run that silently dropped a third of its triplets must not read
 * the same as a run that found only a third.
 *
 * @param rejected - Triplets the ontology turned away.
 * @returns A leading-comma fragment, or an empty string when nothing was rejected.
 */
function rejectionNote(rejected: readonly KgRejection[]): string {
  return rejected.length === 0 ? "" : `, ${rejected.length} triplets rejected by ontology`;
}

/**
 * Renders the failed-chunk count, or nothing when every chunk answered.
 *
 * The same reasoning as {@link rejectionNote}, for the same reason: a document
 * whose graph was built from two of five chunks must not read exactly like one
 * that only had two chunks' worth of facts in it.
 *
 * @param failedChunks - Chunks that produced nothing after their retries.
 * @returns A leading-comma fragment, or an empty string when nothing failed.
 */
function extractionNote(failedChunks: number): string {
  return failedChunks === 0 ? "" : `, ${failedChunks} chunks failed extraction`;
}

/**
 * Renders the shape-mangled chunk count, or nothing when every envelope read.
 *
 * The same reasoning as {@link rejectionNote}, for a third distinct cause: a
 * document whose responses came back uninjured and a document whose responses
 * came back mangled both show zero of the triplets they might have had, and only
 * the second one is a defect worth chasing.
 *
 * @param mangledChunks - Chunks that answered with no usable envelope.
 * @returns A leading-comma fragment, or an empty string when none was mangled.
 */
function mangledNote(mangledChunks: number): string {
  return mangledChunks === 0 ? "" : `, ${mangledChunks} chunks returned a mangled response`;
}

/**
 * Renders the schema-violation count, or nothing when the model obeyed.
 *
 * The same reasoning as {@link rejectionNote}, for the one cause the ontology
 * cannot see: on a provider that treats the tool schema's `enum` as a hint, an
 * invented type is rejected exactly like an undeclared one, so a Stack whose
 * gateway ignores `strict` reads like a Stack whose model simply drifted. This
 * fragment names the provider's non-enforcement, which is a configuration
 * remedy, not a prompt one.
 *
 * @param schemaViolations - `type` values the model put outside the schema.
 * @returns A leading-comma fragment, or an empty string when nothing violated.
 */
function schemaViolationNote(schemaViolations: number): string {
  return schemaViolations === 0 ? "" : `, ${schemaViolations} types outside the declared schema`;
}

/** Which head a summary renders: the detect-only run, or the persisted one. */
type SummaryKind = "dry-run" | "commit";

/**
 * How many chunks the chunker would produce for `body`, without embedding anything.
 *
 * The SAME three steps `chunkAndEmbed` takes before it calls `embedTexts`: a blank body
 * yields nothing, the text is split with `splitText` at the chunker's default size and
 * overlap, and the empty piece a blank split can leave is dropped. Boundaries are
 * therefore byte-identical to the paid path's, which S2 requires, and the cost is a
 * tokenisation pass instead of a provider request.
 *
 * On the real path this runs IN ADDITION to `chunkAndEmbed`'s own split. That second pass
 * is the price of refusing a cap breach before the embedding batch has been paid for, and
 * it is CPU only: it performs no network call and reads no credential.
 *
 * @param body - Document body, exactly as `chunkAndEmbed` receives it.
 * @returns The number of chunks `chunkAndEmbed` would return rows for; `0` for a blank body.
 */
function chunkCountFor(body: string): number {
  if (body.trim() === "") return 0;
  return splitText(body).filter((chunk) => chunk !== "").length;
}

/**
 * The report a detect-only run carries, from counts that cost nothing.
 *
 * @param chunks - Chunks the real path would produce.
 * @param cap - The resolved request cap this run was judged against.
 * @returns The would-be request counts and the cap.
 */
function dryRunReportFor(chunks: number, cap: number): DryRunReport {
  return {
    chunks,
    // Extraction is one chat request per chunk, sequentially: the count is the chunk count.
    chatRequests: chunks,
    // The whole chunk list goes to the provider in ONE batch, so this is not per chunk.
    embeddingRequests: chunks === 0 ? 0 : EMBEDDING_REQUESTS_PER_BATCH,
    cap,
  };
}

/**
 * Renders what a detect-only run would have sent, or nothing when no report is carried.
 *
 * The empty answer matters as much as the filled one: `commit` routes a real run whose
 * body chunked to nothing through the same `dry-run` head, and that summary must read
 * exactly as it did before this report existed.
 *
 * @param report - The would-be request counts, or `undefined` for a run without one.
 * @returns A leading-comma fragment, or an empty string when there is no report.
 */
function dryRunNote(report: DryRunReport | undefined): string {
  if (report === undefined) return "";
  const chatRequests = pluralize(report.chatRequests, "chat request");
  const embeddingRequests = pluralize(report.embeddingRequests, "embedding request");
  return (
    `, would send ${chatRequests}, ${embeddingRequests}` +
    `, within the ${report.cap} request cap`
  );
}

/**
 * A count with its noun, pluralised, so a one-request run does not read `1 requests`.
 *
 * @param count - How many of the thing there are.
 * @param noun - The singular name of the thing.
 * @returns e.g. `1 chat request` or `4 chat requests`.
 */
function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The two doors that must close before any provider is paid, in one place.
 *
 * Both are decided from {@link chunkCountFor}, which counts with the chunker alone, so
 * neither costs a request and neither can change the boundaries a real run would produce.
 *
 * @param options - Stack binding, carrying the detect-only flag.
 * @param input - The document about to be extracted.
 * @param chunkLabel - Placeholder document id for a detect-only handle.
 * @returns The prepared write a detect-only run must return, or `undefined` to extract for real.
 * @throws {ConfigValidationError} When the configured cap is not a positive whole number.
 * @throws {ExtractionRequestCapError} When the document needs more chat requests than the cap.
 */
function beforeProviderSpend(
  options: KgDimensionOptions,
  input: DimensionInput,
  chunkLabel: string,
): PreparedWrite | undefined {
  const capRun = resolveExtractionRequestCap(process.env);
  // The class is thrown HERE, not in `request-cap.ts`: the boundary rule counts every file
  // that reaches for the KG core, and this adapter already holds that edge's allowance.
  if (capRun.kind === "invalid") throw new ConfigValidationError(capRun.problem);
  const plannedChunks = chunkCountFor(input.body);
  assertWithinExtractionRequestCap(plannedChunks, capRun.cap);
  if (options.dryRun !== true) return undefined;
  return {
    unchanged: plannedChunks === 0,
    handle: detectOnlyHandle(chunkLabel, input, dryRunReportFor(plannedChunks, capRun.cap)),
  };
}

/**
 * The handle a detect-only run returns: coherent, and deliberately empty.
 *
 * No chunks means no embeddings and no entities, which is what makes `commit`'s existing
 * empty-write branch the correct outcome for a dry run without `commit` having to know
 * the run was one. The report rides on the handle because the summary is the only
 * per-document signal a caller sees, and `commit` renders it from the handle alone.
 *
 * @param chunkLabel - Placeholder document id, the same one the real path carries.
 * @param input - The document, kept for the same reason the real path keeps it.
 * @param dryRunReport - What this run would have sent.
 * @returns A handle `commit` can render and `discard` can ignore.
 */
function detectOnlyHandle(
  chunkLabel: string,
  input: DimensionInput,
  dryRunReport: DryRunReport,
): KgHandle {
  return {
    documentId: chunkLabel,
    registration: { source: input.source, body: input.body, title: input.title },
    chunks: [],
    entities: [],
    relationships: [],
    rejected: [],
    failedChunks: 0,
    mangledChunks: 0,
    schemaViolations: 0,
    dryRunReport,
  };
}

/**
 * Renders one document's summary: the head counts, then every degraded-run note.
 *
 * ## Why the fragments are composed here and nowhere else
 *
 * The summary is the only per-document signal a caller sees without querying the
 * graph, and it has exactly two producers: the detect-only path and the persist
 * path. Composing it at each call site kept the note ORDER in two template
 * literals at once, so appending a note to one and not the other made a dry run
 * describe a run the real commit does not perform — a divergence no assertion
 * catches, because both strings stay well-formed. One composition point means a
 * new note is added once and both paths report it.
 *
 * The order is load-bearing and is the order of the calls below:
 * {@link rejectionNote} comes FIRST — its exact wording and its position are
 * pinned by callers and predate the other three — then the failed-chunk, mangled
 * envelope and schema-violation notes. Each note carries its own leading comma
 * and renders nothing when its count is zero, so the head is followed directly by
 * an empty string on a clean run and the summary is the counts alone.
 *
 * @param kind - Which head to render: the detect-only run or the persisted one.
 * @param handle - Prepared chunks and extraction, for the counts and the notes.
 * @returns The summary string for this document.
 */
function summaryFor(kind: SummaryKind, handle: KgHandle): string {
  // A detect-only handle holds no chunks: what it would have produced lives in its
  // report. Every other handle counts its own chunks, so a real run whose body chunked
  // to nothing reports `0 chunks` exactly as it did before the report existed.
  const chunkCount = handle.dryRunReport?.chunks ?? handle.chunks.length;
  const counts = `${chunkCount} chunks, ${handle.entities.length} entities`;
  const head =
    kind === "dry-run" ? `kg:dry-run(${counts}${dryRunNote(handle.dryRunReport)})` : `kg:${counts}`;
  return `${head}${rejectionNote(handle.rejected)}${extractionNote(handle.failedChunks)}${mangledNote(handle.mangledChunks)}${schemaViolationNote(handle.schemaViolations)}`;
}

/**
 * Write the extracted graph into Postgres inside one transaction.
 *
 * The document row is registered FIRST, in the same transaction as the
 * consolidation, for two reasons: `entity_source_documents.document_id` is a
 * foreign key onto `stack_documents`, so the parent must exist before any
 * contribution row; and sharing the transaction means a failed consolidation
 * leaves no orphan document behind.
 *
 * @param options - Stack binding and connection override.
 * @param handle - Prepared chunks and extraction; gains the assigned document id.
 * @param callerTx - Coordinator's transaction to join, when it owns one.
 * @returns Nothing; `handle.documentId` carries the id back to `commit`.
 */
async function writeGraph(
  options: KgDimensionOptions,
  handle: KgHandle,
  callerTx?: DatabaseHandle,
): Promise<void> {
  // JOINING IS THE WHOLE POINT. A commit that received a scope and opened its own
  // connection instead would commit the graph separately from the wiki, and a
  // later failure would leave exactly the half state atomic ingest removes. Both
  // commits succeed, so the break is silent -- this is the one rule the port's
  // `commit` documentation calls out.
  if (callerTx !== undefined) {
    await writeGraphRows(callerTx, options, handle);
    return;
  }
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    await db.transaction(async (tx) => {
      await writeGraphRows(tx, options, handle);
    });
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}

/**
 * The graph statements themselves, on whichever handle carries the transaction.
 *
 * Split out so the connection decision above and the write below cannot drift: the
 * document row, the entities and the relationships must all land on the SAME
 * handle (v3 rule), or the foreign key from `entity_source_documents` to
 * `stack_documents` sees a parent that does not exist yet on that connection.
 *
 * @param tx - Transaction bound to this dimension's Stack.
 * @param options - Stack binding.
 * @param handle - Prepared chunks and extraction; gains the assigned document id.
 */
async function writeGraphRows(
  tx: DatabaseHandle,
  options: KgDimensionOptions,
  handle: KgHandle,
): Promise<void> {
  handle.documentId = await registerDocumentRow(tx, {
    stackId: options.stackId,
    source: handle.registration.source,
    body: handle.registration.body,
    title: handle.registration.title,
  });
  const nameToId = await consolidateEntityRows(
    tx,
    options.stackId,
    handle.documentId,
    handle.entities,
  );
  await consolidateRelationshipRows(
    tx,
    options.stackId,
    handle.relationships,
    nameToId,
  );
}

/**
 * Delete every document row for a source, letting the foreign keys cascade.
 *
 * WHY `storage_path` AND NOT AN ID: the compiler registers a document with the
 * SOURCE IDENTITY in `storage_path` (a URL or path), because it has no filename to
 * give the graph. That column is therefore the only thing connecting a source
 * string to its rows, and it is what `forget` can match on.
 *
 * WHY A DELETE RATHER THAN A TOMBSTONE: chunk and
 * `entity_source_documents` rows cascade from `stack_documents`, so one delete
 * retires the whole trace. Soft delete would require every one of the six readers
 * of `stack_documents` to learn a new filter, and those readers are measured
 * against the Python oracle, which has no such concept — the fidelity guarantee
 * would stop holding for deleted documents. The crash this would have protected
 * against is already covered: the source file is still on disk, and the outbox
 * retains `document` and `body`, so a re-ingest reconstructs the graph.
 *
 * Deleting by source removes EVERY generation of that source, which is what
 * retirement means: a source whose content changed is a different `source_hash`
 * and therefore a different row, and forgetting the source must retire all of
 * them, not just the newest.
 *
 * @param options - Stack binding and connection override.
 * @param source - Source identity recorded at ingest time.
 */
async function deleteGraphRows(options: KgDimensionOptions, source: string): Promise<void> {
  const client = createClient(
    options.databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    await db.transaction(async (tx) => {
      // No row is not an error: forgetting an unknown or already-forgotten source
      // is the desired end state, and a reconciler retry must not fail on it.
      await forgetDocumentRows(tx, options.stackId, source);
    });
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}

/**
 * Describe the embedding backend the active embedding provider resolved.
 *
 * The default for {@link KgDimensionOptions.describeEmbeddingBackend}: this is
 * the provider the wiki dimension embeds with, so its report is the endpoint,
 * credential and model that dimension will actually use.
 *
 * @returns The descriptor, or `undefined` for a provider that reports none.
 * @throws {Error} Whatever the provider factory throws for an unusable provider.
 */
function describeActiveEmbeddingBackend(): EmbeddingBackendDescriptor | undefined {
  return getEmbeddingProvider().describeEmbeddingBackend?.();
}

/** What a backend resolver reported: its descriptor, or why it could not answer. */
interface BackendResolution {
  readonly backend: EmbeddingBackendDescriptor | undefined;
  readonly problem: string | null;
}

/**
 * Ask the injected (or default) resolver for the backend, keeping its MESSAGE
 * when it throws.
 *
 * A stack trace from a provider factory tells an operator nothing about which
 * variable to set, so only the message is kept.
 *
 * @param options - Stack binding carrying the injected resolver, if any.
 * @returns The reported backend, or the resolver's message.
 */
function describeBackend(options: KgDimensionOptions): BackendResolution {
  const describe = options.describeEmbeddingBackend ?? describeActiveEmbeddingBackend;
  try {
    return { backend: describe(), problem: null };
  } catch (error) {
    return {
      backend: undefined,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The backend this run should install, and the reason it cannot run at all.
 *
 * WHY THE PROVIDER IS NOT BUILT WHEN THE KG SIDE CONFIGURED ITSELF: resolving a
 * provider can fail for reasons that have nothing to do with this run — the wiki
 * side's own credential, say — and a deployment already working on its KG-side
 * variables must not start failing because of the wiki side.
 *
 * WHY THE RESOLVER'S FAILURE COMES LAST: when the env-derived rules explain the
 * refusal, that explanation names the variable to set. Only when they are
 * satisfied does the factory's own reason become the useful answer.
 *
 * @param options - Stack binding carrying the injected resolver, if any.
 * @returns The descriptor to install, or the message to raise before any request.
 */
function resolveEmbeddingBackendRun(options: KgDimensionOptions): EmbeddingBackendRun {
  const credentialProblem = findEmbeddingCredentialProblem(kgConfig, process.env);
  if (configuresOwnEmbeddingBackend(process.env)) {
    // Nothing to install, but the width rule still applies: a KG-side key with no
    // provider of its own is still a provider derived from the wiki side.
    return { backend: undefined, problem: credentialProblem ?? modelProblem() };
  }
  const resolution = describeBackend(options);
  if (resolution.backend !== undefined) {
    const run = prepareEmbeddingBackend(resolution.backend, process.env);
    if (run.backend !== undefined || run.problem !== null) return run;
  }
  return {
    backend: undefined,
    problem: credentialProblem ?? resolution.problem ?? modelProblem(),
  };
}

/**
 * The width refusal for the model the KG config would ask for, or `null`.
 *
 * Judged LAST: it presumes a configuration that can embed at all, so a missing
 * credential or a provider that cannot serve embeddings outranks a width worry.
 *
 * @returns The exact message, or `null` when the model may be sent.
 */
function modelProblem(): string | null {
  return findEmbeddingModelProblem(kgConfig.EMBEDDING_MODEL, process.env);
}

/**
 * Describe the chat backend the active CHAT provider resolved.
 *
 * The default for {@link KgDimensionOptions.describeChatBackend}: this is the
 * provider the wiki dimension generates with, so its report is the endpoint,
 * credential and model that dimension will actually use for extraction.
 *
 * @returns The descriptor, or `undefined` for a provider that reports none.
 * @throws {Error} Whatever the provider factory throws for an unusable provider.
 */
function describeActiveChatBackend(): ChatBackendDescriptor | undefined {
  return getProvider().describeChatBackend?.();
}

/** What a chat-backend resolver reported: its descriptor, or why not. */
interface ChatResolution {
  readonly backend: ChatBackendDescriptor | undefined;
  readonly problem: string | null;
}

/**
 * Ask the injected (or default) chat resolver, keeping its MESSAGE when it
 * throws.
 *
 * A stack trace from a provider factory tells an operator nothing about which
 * variable to set, so only the message is kept.
 *
 * @param options - Stack binding carrying the injected resolver, if any.
 * @returns The reported backend, or the resolver's message.
 */
function describeChat(options: KgDimensionOptions): ChatResolution {
  const describe = options.describeChatBackend ?? describeActiveChatBackend;
  try {
    return { backend: describe(), problem: null };
  } catch (error) {
    return {
      backend: undefined,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The chat backend this run should install, and the reason it cannot extract.
 *
 * Same shape and same reasons as {@link resolveEmbeddingBackendRun}: a KG-side
 * configuration already working on its own variables must not start failing
 * because the wiki side cannot resolve one, and when the env-derived rules
 * explain the refusal that explanation names the variable to set, so it outranks
 * the factory's own reason.
 *
 * @param options - Stack binding carrying the injected resolver, if any.
 * @returns The descriptor to install, or the message to raise before any request.
 */
function resolveChatBackendRun(options: KgDimensionOptions): ChatBackendRun {
  const credentialProblem = findExtractionCredentialProblem(kgConfig);
  if (configuresOwnChatBackend(process.env)) {
    return { backend: undefined, problem: credentialProblem };
  }
  const resolution = describeChat(options);
  if (resolution.backend !== undefined) {
    const run = prepareChatBackend(resolution.backend, process.env);
    if (run.backend !== undefined || run.problem !== null) return run;
  }
  return { backend: undefined, problem: credentialProblem ?? resolution.problem };
}

/**
 * The two backend runs this `prepare` may install, or a refusal naming what to set.
 *
 * Judged FIRST, before the ontology read and before any provider call: a missing or partial
 * embedding credential must fail closed with the variable to set, never surface as a
 * provider 401 or a stack trace. The extraction side is judged here too, and still before
 * any request, because a missing chat credential discovered after the embedding calls have
 * been paid for is the same defect in a more expensive place.
 *
 * @param options - Stack binding carrying the injected resolvers, if any.
 * @returns Each half separately, because each is installed around its own call alone.
 * @throws {ConfigValidationError} When either half cannot be resolved.
 */
function resolveBackendRuns(options: KgDimensionOptions): {
  readonly embedding: EmbeddingBackendRun;
  readonly chat: ChatBackendRun;
} {
  const embedding = resolveEmbeddingBackendRun(options);
  if (embedding.problem !== null) throw new ConfigValidationError(embedding.problem);
  const chat = resolveChatBackendRun(options);
  if (chat.problem !== null) throw new ConfigValidationError(chat.problem);
  return { embedding, chat };
}

/**
 * Build the graph dimension.
 *
 * @param options - Stack binding and an optional database override.
 */
export function createKgDimension(options: KgDimensionOptions): Dimension {
  return {
    name: "kg",

    async prepare(input: DimensionInput): Promise<PreparedWrite> {
      const backends = resolveBackendRuns(options);
      // Chunk labels carry the source identity only. The authoritative document
      // id does not exist yet — Postgres assigns it during `commit` — and chunks
      // stay in memory, so nothing depends on this placeholder matching a row.
      const chunkLabel = sourceLabel(input.source);
      // Resolved BEFORE embedding: a malformed declaration should fail the run
      // before the expensive half spends a provider call, and it must fail rather
      // than degrade to permissive extraction.
      const ontology = await resolveOntology(options);
      // THE MONEY DOOR, and the only place where "refused" is still free: the cap and
      // the detect-only answer are both decided here, before a single request leaves the
      // process. See {@link beforeProviderSpend}.
      const detectOnly = beforeProviderSpend(options, input, chunkLabel);
      if (detectOnly !== undefined) return detectOnly;
      // Installed around this call alone: the override decides the endpoint,
      // credential and model of the requests chunking makes, and is cleared
      // again even when embedding fails.
      const chunks = await withEmbeddingBackend(backends.embedding.backend, () =>
        chunkAndEmbed(input.body, options.stackId, chunkLabel),
      );
      // The ontology is spread rather than passed as `undefined`, so a run without one
      // calls extraction with exactly the two arguments it always did. Call arity is
      // observable to spies and mocks, and "no ontology changes nothing" has to hold at
      // the call boundary, not just in the result. Installed around this call alone,
      // exactly like the embedding backend and independently of it: the override decides
      // the extraction endpoint, credential and model, and is cleared again even when
      // extraction throws.
      const extraction = await withChatBackend(backends.chat.backend, () =>
        extractGraphFromChunks(chunks, options.stackName, ...ontologyArgs(ontology)),
      );
      const handle: KgHandle = {
        documentId: chunkLabel,
        registration: { source: input.source, body: input.body, title: input.title },
        chunks,
        entities: extraction.entities,
        relationships: extraction.relationships,
        rejected: extraction.rejected ?? [],
        failedChunks: extraction.failedChunks ?? 0,
        mangledChunks: extraction.mangledChunks ?? 0,
        schemaViolations: extraction.schemaViolations ?? 0,
      };
      return { unchanged: chunks.length === 0, handle };
    },

    async commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite> {
      const handle = prepared.handle as KgHandle;
      if (options.dryRun === true || handle.chunks.length === 0) {
        return { idempotencyKey: `kg:${handle.documentId}`, summary: summaryFor("dry-run", handle) };
      }
      // `writeGraph` replaces the placeholder with the id Postgres assigned, and
      // stamps `extracted_by_model` from the same override the extraction used,
      // so the descriptor has to be installed for the WRITE as well: the scope in
      // `prepare` is closed by now, and a row stamped with the configured default
      // names a model that never ran (L15). Re-resolved here rather than carried
      // on the handle, so no credential outlives the call that needed it;
      // `prepare` already refused any unusable backend, so a problem at this
      // point leaves today's env-derived path in place.
      const writeRun = resolveChatBackendRun(options);
      await withChatBackend(writeRun.backend, () =>
        writeGraph(options, handle, scope?.tx as DatabaseHandle | undefined),
      );
      return {
        // Keyed on the real row id, so the outbox replay targets the same document
        // rather than the label it was prepared under.
        idempotencyKey: `kg:${handle.documentId}`,
        summary: summaryFor("commit", handle),
      };
    },

    async discard(): Promise<void> {
      // `prepare` writes no graph rows, so there is nothing to undo. A `commit`
      // that fails partway is handled by the outbox replay, which re-runs the
      // consolidation under its idempotency key rather than deleting rows.
    },

    async forget(source: string): Promise<void> {
      if (options.dryRun === true) return;
      await deleteGraphRows(options, source);
    },
  };
}
