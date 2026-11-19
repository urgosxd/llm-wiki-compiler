/**
 * @file src/dimensions/kg/summary-note.ts
 * @description The `kg` commit summary's wording: the head counts and every degraded-run note.
 *
 * Lifted out of `./index.ts` unchanged so one module owns the sentences a caller reads and
 * the adapter keeps room inside the house file-size ratchet. The move is pure: every note's
 * text, its position in the composed line and its empty-string behaviour are identical, and
 * the status-line suites that assert the rendered string are what pins that.
 *
 * ## Why one composition point
 *
 * The summary is the only per-document signal a caller sees without querying the graph, and
 * it has exactly two producers: the detect-only path and the persist path. Composing it at
 * each call site kept the note ORDER in two template literals at once, so appending a note
 * to one and not the other made a dry run describe a run the real commit does not perform —
 * a divergence no assertion catches, because both strings stay well-formed. One composition
 * point means a new note is added once and both paths report it.
 *
 * ## Why the input type is declared here instead of imported
 *
 * Nothing in this module imports the KG package: it takes counts and renders prose. The
 * handle that carries them lives in `./index.ts`, which is where the `@repo/kg` import
 * belongs, so these interfaces are the SUBSET of it a summary reads — counts and a list
 * length, never a chunk or an entity.
 */

/** Which head a summary renders: the detect-only run, or the persisted one. */
export type SummaryKind = "dry-run" | "commit";

/**
 * What a detect-only run would have sent, all of it derived without a provider call.
 *
 * S10 is the reason this exists: a dry run whose answer is only "ok" has learned nothing,
 * and the numbers an operator needs before approving a real run are exactly these — how
 * many requests the document costs and whether that fits the cap. Every count here comes
 * from the chunker's output, so reporting them costs a tokenisation pass and no network.
 */
export interface DryRunReport {
  /** Chunks the real path would produce, and therefore the unit requests are counted in. */
  readonly chunks: number;
  /** Chat requests extraction would send: one per chunk, sequentially. */
  readonly chatRequests: number;
  /** Embedding requests chunking would send: the whole chunk list in one batch. */
  readonly embeddingRequests: number;
  /** The cap the would-be request count was judged against. */
  readonly cap: number;
}

/**
 * How many rows the SAME ingest stored with class `rejected`, one number per table.
 *
 * Two numbers, not one, because they count two different tables and nothing makes them
 * equal: a refused triplet always becomes a relationship row, and it becomes an ENTITY row
 * as well only when an endpoint is what the ontology refused. So one triplet can store two
 * rejected rows, one, or — when an accepted triplet wins the identity — none.
 */
export interface RejectedRowCounts {
  /** Rows the relationship write reported as `rejected` (`ontology_relationships`). */
  readonly relationships: number;
  /** Rows the entity write reported as `rejected` (`ontology_entities`). */
  readonly entities: number;
}

/**
 * The handle fields a summary renders.
 *
 * Structural rather than the adapter's own handle type, so this module stays free of the
 * `@repo/kg` import `./index.ts` needs for the chunks and entities themselves.
 */
export interface SummaryInput {
  readonly chunks: readonly unknown[];
  readonly entities: readonly unknown[];
  readonly rejected: readonly unknown[];
  /** Absent on a run that wrote nothing at all, which is why the note reads it as `0`. */
  readonly storedRejectedRows?: RejectedRowCounts;
  readonly failedChunks: number;
  readonly mangledChunks: number;
  readonly schemaViolations: number;
  readonly reusedChunks: number;
  readonly extractedChunks: number;
  readonly dryRunReport?: DryRunReport;
}

/** Both counts zero: what a run that wrote no rows reports. */
const NO_REJECTED_ROWS: RejectedRowCounts = { relationships: 0, entities: 0 };

/**
 * Renders the rejection counts for a commit summary, or nothing when clean.
 *
 * A summary is the only per-document signal a caller sees without querying the
 * graph, so a run that silently dropped a third of its triplets must not read
 * the same as a run that found only a third.
 *
 * ## Why the counts are named by TABLE, and why none of them is promised to be equal
 *
 * The first count is TRIPLETS the classifier refused. The rest are ROWS this ingest stored
 * with class `rejected`, read from the writes themselves — a reader can check those against
 * the graph, where the first alone was a claim with nothing behind it. Three different
 * nouns, because the graph holds two different tables:
 *
 * 1. **One refusal can become two rows.** A refused triplet always writes a
 *    `ontology_relationships` row, and it writes an `ontology_entities` row too when an
 *    ENDPOINT is what the ontology refused. So the two row counts are not a split of the
 *    triplet count and never sum to it.
 * 2. **A duplicate identity collapses.** `unique_edge_per_stack
 *    (stack_id, from_entity_id, to_entity_id, type)` admits one row per identity, and
 *    `mergeRelationships` (`core/graph-extraction.ts`) folds two triplets naming the same
 *    subject, relation and object before the write sees them — so two refusals are two
 *    triplets and ONE relationship row.
 * 3. **An accepted triplet on the same identity wins the row.** S7's rule —
 *    `ACCEPTED_WINS_SET` in `core/document-consolidation.ts` — stores the accepted row
 *    when one identity is both refused and admitted, so a refusal can be counted with no
 *    rejected row to show for it, on either table.
 * 4. **A re-ingest does not move a stored class.** The relationship upsert never
 *    downgrades an acceptance, `updateEntity` (`core/document-consolidation.ts`) runs only
 *    on NEW corroboration, and an entity whose contribution was a REPLAY runs no statement
 *    at all — so what a replay's classifier decides is not what the row already stores: a
 *    refusal is counted while the row it names stays accepted, and a byte-identical replay
 *    reports the same refusals again over a graph it did not move.
 *
 * All four are why the line names each count with its own noun instead of asserting an
 * equality the schema makes false.
 *
 * ## Why both row counts are always rendered, zero included
 *
 * `0 ontology_entities rows` is information: it says the refusals were about verbs and
 * pairs, not about endpoint types. Omitting a zero would make the reader guess which table
 * the line declined to mention. Only a run with NO refusals renders nothing at all, which is
 * what keeps a clean ingest byte-identical to what it always printed.
 *
 * ## Why the pair is closed with "and" instead of opened with a colon
 *
 * A `, stored as rejected:` sub-list would run into the notes that follow — the reading
 * `…, 2 chunks failed extraction` as a third member of the sub-list is available, and a
 * count of failed chunks is not a rejected row. Closing the pair with `and`, and letting the
 * phrase end at `rejected`, keeps every later fragment visibly separate.
 *
 * @param rejected - Triplets the ontology turned away.
 * @param storedRows - Rows the same ingest's writes reported as `rejected`, per table.
 * @returns A leading-comma fragment, or an empty string when nothing was rejected.
 */
function rejectionNote(rejected: readonly unknown[], storedRows: RejectedRowCounts | undefined): string {
  if (rejected.length === 0) return "";
  const rows = storedRows ?? NO_REJECTED_ROWS;
  const relationshipRows = pluralize(rows.relationships, "ontology_relationships row");
  const entityRows = pluralize(rows.entities, "ontology_entities row");
  return (
    `, ${pluralize(rejected.length, "triplet")} rejected by ontology, ` +
    `${relationshipRows} and ${entityRows} stored as rejected`
  );
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

/**
 * Renders the reused-versus-extracted split, or nothing when every chunk was extracted.
 *
 * The only fragment conditional on a skip, so a first ingest renders exactly the summary it
 * always did. Both counts are named, because "reused" alone would leave a reader guessing
 * whether the rest was extracted or lost.
 *
 * @param reusedChunks - Chunks skipped because their hash was already extracted.
 * @param extractedChunks - Chunks this run sent to the model.
 * @returns A leading-comma fragment, or an empty string when nothing was reused.
 */
function reuseNote(reusedChunks: number, extractedChunks: number): string {
  if (reusedChunks === 0) return "";
  return `, ${pluralize(reusedChunks, "chunk")} reused, ${pluralize(extractedChunks, "chunk")} extracted`;
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
 * Renders one document's summary: the head counts, then every degraded-run note.
 *
 * The order is load-bearing and is the order of the calls below:
 * {@link rejectionNote} comes FIRST — its exact wording and its position are
 * pinned by callers and predate the other three — then the failed-chunk, mangled
 * envelope and schema-violation notes, then the reuse split. Each note carries its own
 * leading comma and renders nothing when its count is zero, so the head is followed
 * directly by an empty string on a clean run and the summary is the counts alone.
 *
 * The reuse note comes LAST because it is appended to a summary that already exists: a
 * run that reused nothing renders the exact string it always did.
 *
 * @param kind - Which head to render: the detect-only run or the persisted one.
 * @param input - Prepared counts and extraction, for the counts and the notes.
 * @returns The summary string for this document.
 */
export function summaryFor(kind: SummaryKind, input: SummaryInput): string {
  // A detect-only handle holds no chunks: what it would have produced lives in its
  // report. Every other handle counts its own chunks, so a real run whose body chunked
  // to nothing reports `0 chunks` exactly as it did before the report existed.
  const chunkCount = input.dryRunReport?.chunks ?? input.chunks.length;
  const counts = `${chunkCount} chunks, ${input.entities.length} entities`;
  const head =
    kind === "dry-run" ? `kg:dry-run(${counts}${dryRunNote(input.dryRunReport)})` : `kg:${counts}`;
  return `${head}${rejectionNote(input.rejected, input.storedRejectedRows)}${extractionNote(input.failedChunks)}${mangledNote(input.mangledChunks)}${schemaViolationNote(input.schemaViolations)}${reuseNote(input.reusedChunks, input.extractedChunks)}`;
}
