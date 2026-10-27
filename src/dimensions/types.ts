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
 * ## An ingest is ATOMIC, and this port is its participant contract
 *
 * v3 replaced recoverability with atomicity. The earlier revision stated that a
 * shared transaction was unavailable because `wiki` wrote a local directory and
 * `kg` a remote database. That premise expired: `wiki.pages`,
 * `wiki.source_documents`, `stack_documents` and `ingest_outbox` are four tables
 * of ONE database reached through one pooled client, and
 * `test/dimensions/kg-runtime-cross-dimension-transaction.test.ts` measures that a
 * single transaction can span both (with a negative control showing the old
 * two-connection topology diverging).
 *
 * So the coordinator opens ONE transaction per attempt, binds the tenant on it,
 * and hands it to every dimension through {@link CommitScope}. What the port
 * promises now:
 *
 *   1. `prepare` may fail freely. It must not leave anything a reader can see, so
 *      a failure here needs no compensation and leaves no outbox record. It stays
 *      OUTSIDE the transaction on purpose: it runs provider calls measured in
 *      seconds, and holding a transaction open across them would pin a connection.
 *   2. `commit` joins the provided transaction when one is given. A dimension that
 *      ignores the scope and opens its own connection silently breaks atomicity --
 *      this is the single rule every implementation must honour.
 *   3. `commit` must still be idempotent, but for a weaker reason than before: the
 *      coordinator retries the whole transaction (up to two attempts) reusing the
 *      prepared handles, so a retried commit re-runs inside a fresh transaction.
 *   4. `discard` is best-effort compensation for a `prepare` that will not commit.
 *      Inside one transaction there is usually nothing to undo, which is why both
 *      shipped dimensions leave it empty.
 *
 * ## What still cannot join: a file write
 *
 * The wiki dimension also writes `sources/<slug>.md`, which no Postgres
 * transaction can cover. That write is a PROJECTION: it runs after the commit
 * through {@link CommittedWrite.afterCommit}, owned by the dimension that knows
 * the path, and it compensates itself when it fails. The rows are the truth; the
 * projection re-runs on the next compile.
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
 *
 * v3 added {@link CommitScope}: `commit` may join a transaction the coordinator
 * owns, which is what turned the saga into an atomic write, and
 * {@link CommittedWrite.afterCommit} for the one effect that cannot join one.
 */
export const DIMENSION_PORT_VERSION = 3 as const;

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

/**
 * The transaction a dimension's `commit` must join.
 *
 * `tx` is `unknown` because the port names no storage: naming a concrete
 * database type here would import `drizzle-orm` into a contract both dimensions
 * share, and would make the port unusable by any future dimension that is not
 * Postgres. Each implementation narrows `tx` to its own handle and fails closed on
 * a shape it cannot use.
 *
 * The TENANT IS DELIBERATELY ABSENT. Both dimensions already hold their Stack from
 * construction (`options.stackId`) and use it for every `stack_id` value, so a
 * second copy here would be a field a caller can forget. A tenant captured at
 * construction cannot be omitted later; a tenant threaded through calls can be
 * missed at exactly one site and silently write the wrong Stack. The coordinator
 * owns the bind because it already receives `stackId` as a parameter.
 */
export interface CommitScope {
  /** Opaque transaction handle, narrowed by each implementation. */
  readonly tx: unknown;
}

/**
 * What a post-commit projection produced.
 *
 * Separate from {@link CommittedWrite} because it is known at a different time: a
 * commit that joins a transaction has not produced its file when the transaction
 * is still open.
 */
export interface AfterCommitEffect {
  /** Path the projection wrote, for the caller that reports a saved filename. */
  readonly artifactPath?: string;
  /** Outcome of the projection, in the same vocabulary as a direct write. */
  readonly writeStatus?: "created" | "updated" | "unchanged";
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
  /**
   * Work that must run AFTER the transaction commits, when it cannot join one.
   *
   * The wiki dimension writes `sources/<slug>.md`, which no Postgres transaction
   * can cover. Running it post-commit has two consequences that are both wanted:
   *
   *   - When the transaction fails, the file was NEVER TOUCHED. "Clean up the
   *     source after a failed ingest" is therefore a no-op in the case that
   *     matters, instead of a delete that could destroy good content.
   *   - When the projection itself fails, the rows are already committed and the
   *     dimension owns undoing its own half -- see the wiki implementation.
   *
   * Omitted by a dimension whose whole write joined the transaction.
   */
  readonly afterCommit?: (
    scope: CommitScope,
  ) => Promise<AfterCommitEffect | void>;
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
   * Make a prepared write visible, joining `scope.tx` when one is supplied.
   *
   * ## The one rule: a supplied scope MUST be joined
   *
   * A dimension that receives `scope` and opens its own connection instead breaks
   * atomicity silently -- the coordinator's transaction commits, this dimension's
   * writes commit separately, and a later failure leaves exactly the half state
   * this port exists to prevent. It is silent because both commits succeed.
   *
   * With no scope the dimension behaves as it always did: opens its own connection
   * and commits alone. That keeps the port able to describe a participant that
   * shares no transaction, which is why the scope is optional rather than
   * required.
   *
   * MUST be idempotent. The coordinator retries the whole transaction up to two
   * attempts reusing the same prepared handles, so a second `commit` can run
   * against a transaction that already rolled back. A second call must report the
   * same outcome the first would have: no duplicate row, and no forked slug.
   *
   * MUST NOT be relied on to undo itself. Once the transaction commits, the
   * dimension can no longer compensate.
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
   * which is correct: the record says this ingest committed, so reconciliation
   * restores it. When `forget` gains teeth, that second case must start failing --
   * the wiki store suite pins it precisely so whoever gives `forget` teeth sees it go
   * red instead of discovering the interaction in production.
   */
  commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite>;

  /**
   * Undo a prepared-but-uncommitted write.
   *
   * Called by the coordinator when the run will not commit. Must be idempotent:
   * discarding an already-discarded handle is not an error.
   *
   * With v3 atomicity this is mostly vacuous, and both shipped dimensions leave it
   * empty: inside one transaction a rollback already undid everything, and a
   * `prepare` that only reads and computes left nothing behind. It stays in the
   * port for a dimension whose `prepare` allocates something outside the
   * transaction -- a staged upload, a temp file -- which is a real shape even
   * though neither current implementation has it.
   *
   * ## What this does NOT promise
   *
   * A returned promise means "I did what I could", not "the write is gone". The
   * coordinator therefore never reads a quiet return as proof of a clean rollback
   * for a dimension whose writes are already visible -- that misreading once
   * deleted the only record of a half-applied ingest. A dimension that can truly
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
