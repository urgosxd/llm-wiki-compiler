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
 * A dimension never decides whether the overall ingest succeeded; it reports
 * what it did and the coordinator owns the decision.
 */

/** Stable identifier for a dimension. The env switch names these. */
export type DimensionName = "wiki" | "kg";

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

  /** Make a prepared write visible. */
  commit(prepared: PreparedWrite): Promise<CommittedWrite>;

  /**
   * Undo a prepared-but-uncommitted write.
   *
   * Called by the coordinator when a later dimension fails. Must be idempotent:
   * discarding an already-discarded handle is not an error.
   */
  discard(prepared: PreparedWrite): Promise<void>;
}
