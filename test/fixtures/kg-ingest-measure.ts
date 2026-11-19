/**
 * @file test/fixtures/kg-ingest-measure.ts
 * @description The instrument this branch measures with: ONE ingest, reduced to the
 * numbers `odd/tasks/kg-ingest-speed-only.md` requires per item (S7), plus the graph
 * hash that makes S2's "the extracted result must be IDENTICAL" checkable instead of
 * asserted in prose.
 *
 * ## Why the measurement runs the PRODUCTION entry, not the dimension by hand
 *
 * Five of the six fields can be taken from a dimension driven directly. `lockHeldMs`
 * cannot, and it is the field this branch exists for: the mutation lock is NOT part of
 * the dimension contract, because no dimension takes it. It is
 * taken once, around the whole fan-out, in `writeToDimensions`
 * (`packages/wiki/src/services/ingest/service.ts:255`), inside
 * `tryWithOrdinaryMutationLock` (`packages/wiki/src/utils/mutation-lock.ts:152`).
 * A harness that called `prepare` and `commit` itself would therefore report a lock
 * span of ZERO — and would keep reporting zero after the lock is narrowed, since the
 * production lock is not in that path at all. A number that cannot tell "before" from
 * "after" is not an instrument.
 *
 * So the ingest under measurement goes through `ingestTextSource`, the entry every
 * client's ingest passes through, with both dimensions enabled exactly as a
 * deployment runs them. Whatever span production holds is the span reported here,
 * which is the only shape that measures the "after" without editing this file.
 *
 * ## Why the lock is timed by wrapping it, not by timing the ingest
 *
 * Wall clock and lock hold are two different facts and this file keeps them apart.
 * Wall clock is when the whole ingest returned; lock hold is how long another
 * mutation was locked out. Today they are nearly equal — the lock wraps the provider
 * fan-out — and after the narrowing they must not be, which is precisely the claim
 * T7 has to check. Consulting one number for the other is how a refactor looks like
 * a speed-up.
 *
 * The wrapping is TEST-ONLY, and deliberately not a seam in production code: a
 * timing hook in `mutation-lock.ts` would be a production behaviour added to observe
 * production behaviour. The suite installs a wrapper that records `performance.now()`
 * around the real call and delegates, which measures the same span without changing
 * it, and hands the recorded spans to {@link measureKgIngest} in `lockSpans`.
 *
 * ## Why the counts arrive from the wire, and are REQUIRED
 *
 * `chatRequests` and `embeddingRequests` used to be read from a counter inside the KG core.
 * That import is a `wiki → kg` reach the boundary gate counts for `test/**` too, and its
 * ratchet takes no new allowance for a file whose rules have not moved — so this file reads
 * the capture the calling suite's `fetch` stub keeps instead, and applies the same two URL
 * predicates the KG counter applied. The wiring is a required argument for the reason
 * `lockSpans` is: an omitted probe would report a plausible-looking `0` for a run that paid
 * for every chunk, and a silent zero in the numbers this branch is judged by is worse than
 * no number at all.
 *
 * ## Why the caller installs the spy, and this file only reads it
 *
 * `vi.mock` is hoisted above the imports of the module that declares it, and the
 * module graph is built import-by-import: a mock registered HERE is too late for a
 * suite that already imported `services/ingest/service.js` for its own reasons, and
 * the failure is silent — the real lock runs, nothing is recorded, and the span is a
 * plausible-looking `0`. That was measured, not theorised (the first run of the T1
 * baseline reported `lockHeldMs: 0` with a lock that was demonstrably held). A mock
 * hoisted in the suite is registered before anything in that suite's graph loads, so
 * that is where it belongs, and the live span array is a REQUIRED argument here.
 *
 * A `0` in `lockHeldMs` therefore means exactly one thing: the caller installed no
 * spy. It never means "the lock was held for no time".
 *
 * ## What the wall clock contains, stated so nobody has to re-derive it
 *
 * `ingestTextSource` does more than the fan-out: it derives the source identity,
 * opens and closes the dimensions' database handle, resolves the Stack authority,
 * runs the wiki projection, and appends the journal entry after the lock is released.
 * All of it is in `wallClockMs`, because all of it is real time a re-ingest costs.
 * The provider work dominates it by orders of magnitude; the rest is a few file and
 * row writes whose cost does not move with the changes this branch makes.
 *
 * ## Why the chunk count is observed at `prepare` and not read back from a table
 *
 * `document_chunks` is written by the HTTP pipeline route, NOT by the kg dimension's
 * `commit` — `writeGraphRows` registers the document, consolidates entities and
 * consolidates relationships, and persists no chunks
 * (`packages/wiki/src/dimensions/kg/index.ts:415-425`). Counting rows there would
 * report zero for every ingest this file measures. The chunks exist only on the
 * prepared handle, so that is where they are counted, through the port the service
 * already accepts — no production file learns about this file.
 *
 * ## Why the graph hash is over ENTITY AND RELATIONSHIP IDENTITIES
 *
 * S2 and S3 name exactly what may not move: entities, relationships, types and
 * endpoints. A hash over `id` would change on every re-ingest (Postgres assigns
 * them), over `confidence` would react to a replay that changed nothing a reader can
 * see, and over timestamps would never be stable. So the canonical form is the graph
 * as a reader reads it: each entity's name and type, each relationship's two endpoint
 * names and its type, sorted so row order cannot leak into the hash.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { DatabaseHandle, DimensionsPort } from "@repo/foundation";

import { resolveDimensions } from "../../packages/wiki/src/dimensions/index.js";
import type { Dimension, DimensionName, PreparedWrite } from "../../packages/wiki/src/dimensions/types.js";
import { INGEST_DIMENSIONS, ingestTextSource } from "../../packages/wiki/src/services/ingest/service.js";
import {
  isChatCompletionRequest,
  isEmbeddingRequest,
  type CapturedKgRequest,
} from "./kg-provider-fetch.js";

/** The five measurements S7 asks for, per ingest, plus the chunk count S2 pins. */
export interface IngestMeasurement {
  /** Real time the whole ingest took, from call to return, in milliseconds. */
  readonly wallClockMs: number;
  /** Chat-completion requests the provider received (one per chunk, sequentially). */
  readonly chatRequests: number;
  /** Embedding requests the provider received. */
  readonly embeddingRequests: number;
  /** Chunks `prepare` produced; the unit every per-chunk claim is counted in. */
  readonly chunkCount: number;
  /** SHA-256 over the Stack's canonicalised graph; stable until the graph changes. */
  readonly graphHash: string;
  /** How long the production mutation lock was held across this ingest. */
  readonly lockHeldMs: number;
}

/** Everything the instrument needs, all of it owned by the calling suite. */
export interface MeasureKgIngestRequest {
  /** Absolute project root the ingest writes into; the caller owns its lifecycle. */
  readonly root: string;
  /** The database handle the caller owns and closes. */
  readonly db: DatabaseHandle;
  /** The Stack the environment names; used to scope the graph hash. */
  readonly stackId: string;
  /** The one environment this run reads: database, dimension switch and Stack id. */
  readonly env: NodeJS.ProcessEnv;
  /** Document title, as an ingest would carry it. */
  readonly title: string;
  /** Document body: the only input S2 lets a change hide in. */
  readonly body: string;
  /**
   * The live array the suite's mutation-lock spy appends to, in call order.
   *
   * Required rather than optional: an omitted probe would report `lockHeldMs: 0` for a
   * lock that was held for minutes, and a silent zero in the one number this branch
   * exists to move is worse than no number at all. Spans recorded before this call are
   * ignored, so one suite may measure several ingests in sequence.
   */
  readonly lockSpans: readonly number[];
  /**
   * The live array the suite's provider stub appends to, in call order.
   *
   * Required for the same reason `lockSpans` is: this file reads the requests one ingest
   * made by slicing what was appended during it, and an omitted probe would report
   * `chatRequests: 0` for a run that paid for every chunk. The two counts below are taken
   * with the predicates the KG counter used, so they mean what they always meant.
   */
  readonly providerRequests: readonly CapturedKgRequest[];
}

/**
 * Run one ingest and reduce it to the numbers S7 requires.
 *
 * The caller scripts the provider responses before calling, because they are the
 * ingest's INPUT and not part of what is being timed.
 *
 * @param request - Project root, database handle, Stack, environment, title and body.
 * @returns Wall clock, request counts, chunk count, graph hash and lock hold duration.
 */
export async function measureKgIngest(
  request: MeasureKgIngestRequest,
): Promise<IngestMeasurement> {
  const observed = { chunks: 0 };
  const requestsBefore = request.providerRequests.length;
  const lockReadingsBefore = request.lockSpans.length;

  const startedAt = performance.now();
  await ingestTextSource(
    request.root,
    { title: request.title, text: request.body },
    request.env,
    observingPort(observed),
  );
  const wallClockMs = performance.now() - startedAt;
  const requests = request.providerRequests.slice(requestsBefore);

  return {
    wallClockMs,
    chatRequests: requests.filter(isChatCompletionRequest).length,
    embeddingRequests: requests.filter(isEmbeddingRequest).length,
    chunkCount: observed.chunks,
    graphHash: await graphHashFor(request.db, request.stackId),
    lockHeldMs: sumOf(request.lockSpans.slice(lockReadingsBefore)),
  };
}

/**
 * The dimensions port the service accepts, with this module's counter bolted on.
 *
 * It resolves the SAME set the service would resolve for itself — same root, handle,
 * environment and Stack — and wraps the kg dimension so its prepared chunk count is
 * observable. Nothing is added, removed or reordered; S8 forbids touching a route's
 * dimension composition, and a fixture that reordered it would measure a different
 * program.
 *
 * @param observed - Counter the wrapped kg `prepare` reports its chunk count into.
 * @returns A port the ingest service can use in place of the internal resolution.
 */
function observingPort(observed: { chunks: number }): DimensionsPort<Dimension> {
  return {
    resolve: (request) =>
      resolveDimensions({
        root: request.root,
        db: request.db,
        env: request.env,
        ...(request.stackId === undefined ? {} : { stackId: request.stackId }),
        only: whoseNamesTheEngineMayWrite(request.only),
      }).map((dimension) =>
        dimension.name === "kg" ? withChunkCount(dimension, observed) : dimension,
      ),
  };
}

/**
 * The requested names this build can actually write, in the caller's order.
 *
 * `DimensionsRequest.only` is `readonly string[]` at the seam, so it cannot be handed
 * to `resolveDimensions` unchanged; narrowing it here, rather than dropping it, keeps
 * the port's "narrow, never enable" contract for the one unexpected case.
 *
 * @param requested - The names the caller asked for.
 * @returns Those of them that name a dimension this build writes.
 */
function whoseNamesTheEngineMayWrite(requested: readonly string[]): readonly DimensionName[] {
  return requested.filter((name): name is DimensionName =>
    INGEST_DIMENSIONS.some((known) => known === name),
  );
}

/**
 * The same dimension, with its prepared chunk count reported to `observed`.
 *
 * Every other member — `commit`, `discard`, `forget`, the name — is passed through
 * untouched, so the wrapper cannot change what the ingest does.
 *
 * @param dimension - The real kg dimension.
 * @param observed - Counter that receives the chunk count `prepare` produced.
 * @returns A dimension with the identical contract and one observation point.
 */
function withChunkCount(dimension: Dimension, observed: { chunks: number }): Dimension {
  return {
    ...dimension,
    prepare: async (input): Promise<PreparedWrite> => {
      const prepared = await dimension.prepare(input);
      observed.chunks = chunkCountOf(prepared.handle);
      return prepared;
    },
  };
}

/**
 * How many chunks a prepared handle carries, without naming the dimension's handle type.
 *
 * A handle with no `chunks` array counts as zero chunks, which is what the coordinator
 * itself treats as "nothing to write" (`unit.unchanged`).
 *
 * @param handle - The opaque compensation token a dimension's `prepare` returned.
 * @returns The number of chunks it holds.
 */
function chunkCountOf(handle: unknown): number {
  const chunks = (handle as { chunks?: unknown } | null | undefined)?.chunks;
  return Array.isArray(chunks) ? chunks.length : 0;
}

/**
 * SHA-256 over the Stack's graph in canonical form.
 *
 * Entities are identified by name and type, relationships by their two endpoint names
 * and their type — exactly the facts S2 and S3 forbid an optimisation from moving.
 * Both lists are sorted by their own serialised form, so the hash depends on the graph
 * and not on the order Postgres happened to return rows in.
 *
 * The function is EXPORTED because it is the instrument, not a detail of one measurement:
 * `test/dimensions/kg-graph-hash-includes-class.test.ts` pins that both queries read every
 * row of the Stack regardless of its ontology class. A `where ontology_verdict = 'accepted'`
 * added to either query would silently narrow what the baseline covers, and only a test
 * calling this function can see that.
 *
 * @param db - Handle bound to the Stack's database.
 * @param stackId - The Stack to hash; another Stack's rows are never included.
 * @returns 64 lowercase hex characters.
 */
export async function graphHashFor(db: DatabaseHandle, stackId: string): Promise<string> {
  const entities = await db.execute<{ name: string; type: string }>(
    `select name, type from ontology_entities where stack_id = '${stackId}'`,
  );
  const relationships = await db.execute<{ from_name: string; type: string; to_name: string }>(
    `select source.name as from_name, relationship.type as type, target.name as to_name
       from ontology_relationships relationship
       join ontology_entities source on source.id = relationship.from_entity_id
       join ontology_entities target on target.id = relationship.to_entity_id
      where relationship.stack_id = '${stackId}'`,
  );
  const canonical = {
    entities: sortedByName(entities.map((row) => ({ name: row.name, type: row.type }))),
    relationships: sortedByName(
      relationships.map((row) => ({ from: row.from_name, type: row.type, to: row.to_name })),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The rows in a stable order that does not depend on the driver's.
 *
 * @param rows - Rows in whatever order they arrived.
 * @returns A sorted copy; the input is never mutated.
 */
function sortedByName<T>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  });
}

/**
 * The total of the lock spans recorded during one ingest.
 *
 * @param spans - The spans this ingest produced, in call order.
 * @returns Their sum in milliseconds; `0` when the lock was never taken.
 */
function sumOf(spans: readonly number[]): number {
  return spans.reduce((total, span) => total + span, 0);
}
