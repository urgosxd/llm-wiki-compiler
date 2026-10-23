/**
 * @file packages/llmwiki-kg/ts/src/core/page/context.ts
 * @description The row shapes a page is generated from.
 *
 * Split out of `core/page_generator.ts` as its own unit because the prompt
 * builder, the hasher and the graph reads all speak these shapes, and the tests
 * import them as types without pulling in a database client.
 */

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
};

/** One relationship with the other endpoint's name resolved. */
export type PageRelationshipRow = {
  type: string;
  confidence: number;
  description: string | null;
  other_name: string;
  other_type: string;
  direction: "outgoing" | "incoming";
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
