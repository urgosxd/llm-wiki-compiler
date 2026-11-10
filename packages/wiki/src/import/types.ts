/**
 * @file Shared types for the OKF import subsystem: the tolerantly-parsed source
 * doc shape, the mapped llmwiki page record, and the resource caps that bound
 * untrusted-bundle ingestion.
 */

/** A tolerantly-parsed OKF concept doc, ready for inverse mapping. */
export interface RawOkfDoc {
  /** Bundle-relative POSIX path, e.g. "concepts/a.md". */
  relPath: string;
  /** Parsed frontmatter (default safe YAML schema). */
  meta: Record<string, unknown>;
  /** Markdown body (frontmatter stripped). */
  body: string;
}

/** A llmwiki page produced from one OKF doc. */
export interface MappedOkfPage {
  slug: string;
  title: string;
  summary: string;
  sources: string[];
  targetDirectory: "concepts" | "queries";
  okfPath: string;
  /** Full page content (frontmatter + body) ready to write verbatim. */
  body: string;
}

/**
 * A profile-entity OKF doc routed through the TYPED staging/promotion leg (CLP
 * 7.6, D-7.6.4). Its `entityType` resolved to a type the ACTIVE profile declares
 * (so it stages through `stageEntityPage` + the trust planner, never the legacy
 * `writeAll`); an ABSENT `entityType` marks an immediate unknown-type fallback
 * (D-7.6.5). Every doc also carries its `untyped` concept form so a contract /
 * lifecycle violation (or an unknown type) can fall back to the existing untyped
 * staging WITHOUT re-mapping.
 */
export interface MappedTypedOkfDoc {
  /** Declared active-profile entity type to attempt typed staging; ABSENT => immediate fallback. */
  entityType?: string;
  /** Wiki-relative entity directory (`wiki/<type>`) for the collision check; present iff `entityType`. */
  directory?: string;
  /** Typed page slug (filename stem), derived from the doc's path. */
  slug: string;
  /** Bundle-relative source path. */
  okfPath: string;
  /** Reconstructed typed page (frontmatter + body); present iff `entityType` is set. */
  typedBody?: string;
  /** The untyped concept form of this doc, used for the mismatch/unknown-type fallback. */
  untyped: MappedOkfPage;
  /** Reason this doc falls back immediately (unknown entity type under the active profile). */
  fallbackReason?: string;
}

/**
 * The per-doc outcome of the typed collision check: a doc the typed leg drops because its
 * `wiki/<entityType>/<slug>` target already exists live, is already a pending candidate, or
 * was claimed earlier in the same bundle.
 */
export interface TypedImportOutcome {
  /** Bundle-relative source path. */
  okfPath: string;
  /** The candidate/page slug the outcome applies to. */
  slug: string;
  /** Declared entity type, when the doc resolved one. */
  entityType?: string;
  /**
   * `skipped`: a collision skip, and the only arm with a producer. The typed staging and
   * promotion outcomes that used to be declared here needed a staging path that no longer
   * exists; an arm nothing can produce describes a surface that is not there.
   */
  outcome: "skipped";
  /** Why the doc was skipped — the collision reason. */
  reason?: string;
}

/** Tunable resource caps for untrusted-bundle ingestion. */
export interface OkfImportLimits {
  maxFiles: number;
  maxDocBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  /** Serialized byte size of the `index.md` `x-llmwiki` value; oversize → the whole block is refused. */
  maxIndexBlockBytes: number;
  /** Maximum bundle-block relation entries; an over-cap list is refused whole (never truncated). */
  maxRelations: number;
  /** Maximum bundle-block workflow-run summaries; an over-cap list is refused whole. */
  maxWorkflowRuns: number;
}
