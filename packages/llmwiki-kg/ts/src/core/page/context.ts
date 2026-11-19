/**
 * @file packages/llmwiki-kg/ts/src/core/page/context.ts
 * @description The row shapes a page is generated from.
 *
 * Split out of `core/page_generator.ts` as its own unit because the prompt
 * builder, the hasher and the graph reads all speak these shapes, and the tests
 * import them as types without pulling in a database client.
 */

import type { RejectionReason } from "../ontology.js";
import type { OntologyVerdict } from "../../schema.js";

// ---------------------------------------------------------------------------
// Graph version
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the page generator reads it. */
export type PageEntityRow = {
  id: string;
  stack_id: string;
  name: string;
  type: string;
  description: string | null;
  /** `properties` in its jsonb text form; `null` for SQL NULL. */
  properties_text: string | null;
  confidence: number;
  verified: boolean;
  last_seen_at: string | null;
  /**
   * The ontology's verdict on this entity, or `undefined`/`null` when no readable value
   * was stored.
   *
   * Optional rather than required because a context may be assembled without a stored
   * row (the page harness builds them by hand), and because absence can only ever mean
   * "nothing was recorded": no code path may read an absent value as `rejected`.
   */
  ontology_verdict?: OntologyVerdict | null;
  ontology_rejection_reason?: RejectionReason | null;
  ontology_offending_type?: string | null;
};

/**
 * One relationship with the other endpoint's name resolved.
 *
 * The three ontology columns travel with it because the prompt this row feeds is a
 * reasoning surface: an edge the ontology refused, handed to a model with nothing to
 * distinguish it, becomes wiki prose that later reads as a fact. The snake_case names
 * are the stored columns' own, so this shape and the row it came from cannot drift.
 */
export type PageRelationshipRow = {
  type: string;
  confidence: number;
  description: string | null;
  other_name: string;
  other_type: string;
  direction: "outgoing" | "incoming";
  /** The three columns, optional for the same reason as on {@link PageEntityRow}. */
  ontology_verdict?: OntologyVerdict | null;
  ontology_rejection_reason?: RejectionReason | null;
  ontology_offending_type?: string | null;
};

/** One contributing document. */
export type PageDocumentRow = {
  id: string;
  filename: string;
  ingested_at: string;
};

/** Everything needed to generate one entity's page. */
export interface EntityPageContext {
  readonly entity: PageEntityRow;
  readonly outgoing: readonly PageRelationshipRow[];
  readonly incoming: readonly PageRelationshipRow[];
  readonly documents: readonly PageDocumentRow[];
}
