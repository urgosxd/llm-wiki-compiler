/**
 * @file src/dimensions/types.ts
 * @description The dimension port: the contract every ingest target implements.
 *
 * A **dimension** is one destination an ingest writes to. Today there are two:
 *
 *   - `wiki` — the compiler's own `sources/` markdown store.
 *   - `kg`   — the Agent Knowledge Standard knowledge graph.
 *
 * A dimension is written in three steps rather than one, because a dimension may
 * span systems that cannot share a transaction (a local directory and a remote
 * database, say). Splitting the write into `prepare` / `commit` / `discard` is
 * what lets the coordinator decide the order and compensate a half-finished
 * ingest:
 *
 *   1. `prepare`  — do the reversible work and return a handle. A handle that
 *      throws leaves the dimension untouched.
 *   2. `commit`   — make the prepared work visible. The only step that must not
 *      be retried blindly.
 *   3. `discard`  — undo a `prepare` that will not be committed.
 *
 * Removal is a SEPARATE lifecycle step, not a fourth phase of the same write:
 * {@link Dimension.forget} retires a source that no longer exists. It takes a
 * source identity rather than a prepared handle because by the time a removal is
 * detected there is nothing prepared — the bytes are already gone.
 *
 * A dimension never decides whether the overall ingest succeeded; it reports
 * what it did and the coordinator owns the decision.
 *
 * ## This file is a frozen contract (v1)
 *
 * Two dimensions are developed concurrently, each by a different role, and both
 * depend on this interface. So the interface is versioned and frozen rather than
 * edited opportunistically:
 *
 *   - **v1.** `wiki` and `kg` each own a directory under `src/dimensions/` and
 *     implement this port. Neither writes here.
 *   - **Changing it is a contract change.** A role that needs a different shape
 *     sends a `work_request` to the integration role; it does not edit this file.
 *     Editing it unilaterally means the other dimension compiles against a shape
 *     nobody agreed to.
 *   - **Additive changes are still changes.** The two optional fields added
 *     during Phase 0 (`writeStatus`, `artifactPath`) exist because the ingest
 *     caller needs them and only a file-backed dimension knows them. They were
 *     added while this surface was still being established, which is exactly the
 *     window that closes now.
 *
 * Nothing here knows about any concrete dimension, which is what keeps it
 * freezable: the port names no file path, no database, and no provider.
 *
 * ## An ingest is a SAGA, and this port is its participant contract
 *
 * Once both dimensions became remote, an ingest stopped being one atomic write and
 * became a saga: an ordered sequence of local commits with a compensating action
 * and a durable record to finish what a failure interrupted. There is no shared
 * transaction to fall back on -- `wiki` writes rows through its own tenant-bound
 * transaction and `kg` opens its own connection and commits separately -- so a
 * single transaction spanning both is not available without rebuilding both
 * dimensions around a handle neither currently accepts.
 *
 * So the guarantee this port offers is RECOVERABILITY, not atomicity, and every
 * participant is written against that:
 *
 *   1. `prepare` may fail freely. It must not leave anything a reader can see, so
 *      a failure here needs no compensation and leaves no outbox record.
 *   2. `commit` is the point of no return. A dimension that committed is COMMITTED
 *      even if a later dimension fails; that is accepted, not tolerated.
 *   3. `discard` is best-effort compensation, and a quiet return does not mean the
 *      write is gone -- see {@link Dimension.discard}.
 *   4. The OUTBOX owns the gap. When a dimension committed and a later one failed,
 *      the record stays `pending` and `reconcileOutbox` finishes the ingest by
 *      replaying `commit`. That is why `commit` MUST be idempotent: replay is the
 *      recovery mechanism, not an exceptional path.
 *
 * The window this accepts is real and must be stated rather than implied: between
 * the first `commit` and the last, a reader can observe a wiki page whose graph
 * document does not exist yet. That state is recoverable by replay and observable
 * by anyone reading during the window. Choosing atomicity over this would mean
 * coupling both dimensions to one transaction, which buys that window away at the
 * cost of the independence the port exists to provide.
 */

/**
 * Stable identifier for a dimension. The env switch names these, and the
 * coordinator uses them as ordering and outbox keys, so the domain is closed:
 * adding a name is an interface change, not a convention.
 */
export type DimensionName = "wiki" | "kg";

/**
 * The version of this port. Bumped only through an agreed contract change.
 *
 * v2 added {@link Dimension.forget}: a source can be REMOVED, and until v2 the
 * port could only express writes, so a deleted source left its graph document and
 * entities behind forever.
 */
export const DIMENSION_PORT_VERSION = 2 as const;

/**
 * Where a document comes from and what it is called. Dimensions receive the
 * same input so the wiki page and the graph document describe one source.
 */
export interface DimensionInput {
  /** Stable source identity (URL, path, or synthesized digest). */
  readonly source: string;
  /** Human-readable title used for the wiki filename and the graph document. */
  readonly title: string;
  /** Full markdown document, frontmatter included, as written to the wiki. */
  readonly document: string;
  /** Extracted body text without frontmatter, for downstream extraction. */
  readonly body: string;
}

/**
 * What one dimension prepared. `handle` is opaque to the coordinator and is
 * only ever passed back to the same dimension's `commit` or `discard`.
 */
export interface PreparedWrite {
  /** True when the write would change nothing (`writeStatus === "unchanged"`). */
  readonly unchanged: boolean;
  /** Opaque compensation token, interpreted only by the producing dimension. */
  readonly handle: unknown;
}

/** What a committed dimension reports back to the coordinator. */
export interface CommittedWrite {
  /**
   * Deterministic identity of what was written, used as the idempotency key
   * when the outbox is replayed after a crash. Two ingests of identical
   * content produce the same key and therefore do not double-write.
   */
  readonly idempotencyKey: string;
  /** Short human-facing description for status output. */
  readonly summary: string;
  /**
   * Outcome of the underlying write, when the dimension writes files.
   *
   * The wiki dimension distinguishes created / updated / unchanged, and callers
   * of `ingest` report that distinction to the user. It belongs here rather than
   * being recovered by parsing {@link summary}: `summary` is presentation text
   * for status output and is free to change wording, so deriving a behavioural
   * fact from it would break silently the first time someone reworded it.
   *
   * Optional because a dimension backed by a remote store (the graph) has no
   * file-write status to report.
   */
  readonly writeStatus?: "created" | "updated" | "unchanged";
  /**
   * Where the dimension's output landed, for dimensions that write a file.
   *
   * The ingest caller builds its activity-log entry and its result filename from
   * this path, and the file-backed dimension is the only component that knows it.
   * Optional for the same reason as {@link writeStatus}.
   */
  readonly artifactPath?: string;
}

/**
 * One ingest destination.
 *
 * Implementations are responsible for their own safety (path confinement for
 * the wiki, credentials for the graph) and must be safe to call twice with the
 * same input: `prepare` may be retried by the reconciler.
 */
export interface Dimension {
  /** Which dimension this is. */
  readonly name: DimensionName;

  /**
   * Perform the reversible half of the write.
   *
   * Must not make the write visible to readers. On failure the implementation
   * is responsible for cleaning up whatever it created.
   */
  prepare(input: DimensionInput): Promise<PreparedWrite>;

  /**
   * Make a prepared write visible.
   *
   * MUST be idempotent, and this is stronger than it looks: replay is how a
   * committed-but-unpaired ingest is recovered, so `reconcileOutbox` calls this
   * again with the same input after the fact. A second call must report the same
   * outcome the first would have: no duplicate row, and no forked slug.
   *
   * MUST NOT be relied on to undo itself. Once this returns, the dimension can no
   * longer compensate; the outbox record is what makes the rest recoverable.
   *
   * ## Idempotency is about REPLAY, not about resurrection
   *
   * An earlier version of this comment also promised a second `commit` would "not
   * resurrect work a `forget` has since removed". That was measured and is FALSE,
   * because it assumed `forget` removes something. The wiki's `forget` is
   * deliberately a no-op -- `compile` owns removal by marking orphaned pages -- so
   * there is no removal for a replay to undo.
   *
   * The distinction is worth stating because the two cases look alike and behave
   * oppositely. A replay after `forget` leaves exactly one row, because `forget`
   * deleted nothing. A replay after ANOTHER actor deleted the row DOES recreate it,
   * which is correct: the outbox record says this ingest committed, so reconciliation
   * restores it. When `forget` gains teeth, that second case must start failing --
   * the wiki store suite pins it precisely so whoever gives `forget` teeth sees it go
   * red instead of discovering the interaction in production.
   */
  commit(prepared: PreparedWrite): Promise<CommittedWrite>;

  /**
   * Undo a prepared-but-uncommitted write.
   *
   * Called by the coordinator when a later dimension fails. Must be idempotent:
   * discarding an already-discarded handle is not an error.
   *
   * ## What this does NOT promise, and why the coordinator stopped assuming it
   *
   * A returned promise means "I did what I could", not "the write is gone". A
   * database-backed dimension commits inside its own transaction, so its
   * `discard` is a no-op by design: there is no open transaction to abandon and
   * nothing it can undo after `commit`. The coordinator therefore treats a
   * dimension that COMMITTED as unresolved even when `discard` returns quietly,
   * keeps the outbox record `pending`, and lets `reconcileOutbox` finish the
   * ingest by replaying the idempotent `commit`.
   *
   * That distinction is load-bearing: reading a quiet return as "rolled back"
   * once caused the coordinator to delete the only record of a half-applied
   * ingest, leaving unrecoverable data and no trail. A dimension that can truly
   * compensate (the file-backed writer reverts its journal batch) is still safe,
   * because keeping a `pending` record only costs a replay that its idempotency
   * key collapses.
   */
  discard(prepared: PreparedWrite): Promise<void>;

  /**
   * Retire every trace of a source that no longer exists.
   *
   * WHY THIS IS NOT A PHASE OF THE WRITE. `prepare`/`commit`/`discard` all take a
   * handle produced by a write that is in flight. A removal has no such handle:
   * the source file is already gone, so the only thing left to name it is its
   * source identity.
   *
   * MUST be idempotent and MUST tolerate an unknown source. Forgetting something
   * that was never ingested, or was already forgotten, is a SUCCESS — the desired
   * end state ("this source is not here") already holds. A reconciler retries, and
   * a retry of a completed removal must not fail.
   *
   * MUST NOT throw for a source it cannot identify. A dimension that never knew
   * the source has nothing to retire.
   *
   * @param source - The source identity the dimension recorded at ingest time.
   */
  forget(source: string): Promise<void>;
}
