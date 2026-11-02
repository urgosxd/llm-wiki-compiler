/**
 * @file The SHAPE of the `x-llmwiki` bundle block, as the IMPORTER reads it.
 *
 * This module exists because the exporter and the importer outlived each other.
 * `bundle-block.ts` used to both declare these types AND produce the block from a
 * loaded profile. The profile substrate was removed, so nothing produces a block
 * any more — but a bundle written by an earlier version still carries one, and
 * `import/bundle-block-read.ts` must keep parsing it.
 *
 * Keeping the declarations here rather than in the deleted producer makes that
 * asymmetry explicit: these types describe what a FOREIGN bundle may contain, not
 * what this build writes. `collectBundleBlock` is gone; the reader is unaffected.
 *
 * Nothing else should import this to construct a block. If a producer ever
 * returns, it belongs beside a new `bundle-block.ts`, not in these types.
 */

/** The bundle profile identity + producer sub-block (D-7.6.2). */
export interface BundleProfileBlock {
  profileId: string;
  /** Omitted when the profile declares no version. */
  profileVersion?: string;
  profileSchemaVersion: number;
  profileContentHash: string;
  entityTypes: string[];
  relationTypes: string[];
  artifactTypes: string[];
  producer: { name: string; version: string };
}

/** One live relation, flattened for the bundle graph (evidence omitted in v0). */
export interface BundleRelationEntry {
  id: string;
  type: string;
  from: string;
  to: string;
  /** Omitted when the relation carries no attributes. */
  attributes?: Record<string, unknown>;
  contentHash: string;
}

/** A BOUNDED per-run workflow summary (D-7.6.7) — no events/inputs/outputs/integrity. */
export interface BundleWorkflowEntry {
  runId: string;
  workflowId: string;
  status: string;
  currentStage: string | null;
  satisfiedGates: string[];
  stages: Array<{ id: string; status: string }>;
  workflowDigest: string;
  profileDigest: string;
}

/** The full `x-llmwiki` bundle block as it appears on `index.md` frontmatter. */
export interface BundleBlock {
  profile: BundleProfileBlock;
  relations: BundleRelationEntry[];
}

/**
 * A rendered entity OKF document, as the bundle importer and index TOC read it.
 *
 * Entity docs came from a non-default profile's declared types. Nothing renders
 * one in this build, so every consumer sees an empty list — but the shape stays
 * declared because `index-log.ts` still groups a TOC by `entityType` and must
 * keep type-checking against a bundle that may be handed to it.
 */
export interface ProfileEntityDoc {
  /** Declared entity type id (e.g. `papers`) — the TOC groups on this. */
  entityType: string;
  /** Bundle-relative output path: `<entityType>/<slug>.md`. */
  rel: string;
  /** Display title for the TOC (frontmatter title, else the slug). */
  title: string;
  /** One-line summary for the TOC (frontmatter `summary`, else empty). */
  summary: string;
  /** The fully rendered OKF document (frontmatter + rewritten body). */
  content: string;
}
