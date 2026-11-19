/**
 * @file packages/llmwiki-kg/ts/src/core/page/prompt.ts
 * @description The page-generation prompt, verbatim, and its response budget.
 *
 * Split out of `core/page_generator.ts` as its own unit because the prompt is a
 * contract: it is the only input to a non-deterministic step, so it is pinned
 * against the text the oracle actually sent, byte for byte.
 */

import { formatFixed2 } from "./fixed2.js";
import type {
  EntityPageContext,
  PageDocumentRow,
  PageEntityRow,
  PageRelationshipRow,
} from "./context.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Response budget for one page. `complete(prompt, max_tokens=2048)`. */
export const PAGE_MAX_TOKENS = 2048;

/**
 * The marker a REFUSED item carries, or nothing at all.
 *
 * Additive by construction: an accepted edge renders exactly the line the oracle pinned,
 * and only an edge the ontology refused changes shape. Trailing rather than inline
 * because this is prose a model reads end to end, and the reason is stated so the model
 * can say WHY the source's claim was not admitted instead of quietly omitting it.
 */
function refusedMarker(relationship: {
  readonly ontology_verdict?: string | null;
  readonly ontology_rejection_reason?: string | null;
}): string {
  if (relationship.ontology_verdict !== "rejected") return "";
  const reason = relationship.ontology_rejection_reason;
  return reason === null
    ? " [REJECTED by the ontology]"
    : ` [REJECTED by the ontology: ${reason}]`;
}

/** One outgoing edge, as the prompt renders it. */
function outgoingLine(relationship: PageRelationshipRow): string {
  return (
    `  - This entity ${relationship.type}s ${relationship.other_name} ` +
    `(${relationship.other_type}, confidence ${formatFixed2(Number(relationship.confidence))})` +
    refusedMarker(relationship)
  );
}

/** One incoming edge, as the prompt renders it. */
function incomingLine(relationship: PageRelationshipRow): string {
  return (
    `  - ${relationship.other_name} (${relationship.other_type}) ${relationship.type}s this entity ` +
    `(confidence ${formatFixed2(Number(relationship.confidence))})` +
    refusedMarker(relationship)
  );
}

/** The RELATIONSHIPS block: outgoing edges first, then incoming, or a marker. */
function relationshipLines(
  outgoing: readonly PageRelationshipRow[],
  incoming: readonly PageRelationshipRow[],
): string {
  const lines = [
    ...outgoing.map(outgoingLine),
    ...incoming.map(incomingLine),
  ];
  return lines.length === 0 ? "  (No relationships recorded)" : lines.join("\n");
}

/**
 * The extra ENTITY line a refused entity carries, or nothing at all.
 *
 * An entity the ontology refused is still stored, and a page about it is still
 * generated — the human's decision is "included, but marked". This is the marking: the
 * model is told the item did not pass the ontology, so it does not present the refused
 * type as a settled classification of the thing.
 */
function entityOntologyNote(entity: PageEntityRow): string {
  if (entity.ontology_verdict !== "rejected") return "";
  const reason = entity.ontology_rejection_reason ?? "no reason recorded";
  const offending = entity.ontology_offending_type ?? entity.type;
  return (
    `\n  Ontology: REJECTED by the ontology (${reason}); refused type ${offending}`
  );
}

/** The SOURCE DOCUMENTS block, or a marker when nothing contributed. */
function documentLines(documents: readonly PageDocumentRow[]): string {
  if (documents.length === 0) {
    return "  (No contributing documents)";
  }
  return documents
    .map((document) => `  - ${document.filename} (ingested ${document.ingested_at.slice(0, 10)})`)
    .join("\n");
}

/**
 * The generation prompt, verbatim.
 *
 * Captured from the oracle by replacing `page_generator.complete` with a
 * recorder, so this text — including the awkward `{type}s` pluralisation the
 * Python f-string produces (`USESs`, `HASs`) and the double space in
 * `(SYSTEM, confidence …)` — is measured rather than transcribed by eye.
 *
 * The two placeholder branches are part of the contract as well:
 * `(No relationships recorded)` and `(No contributing documents)` are what the
 * model sees when the graph has nothing to offer.
 *
 * ## One deliberate, additive deviation: refused items are marked
 *
 * The oracle's text is reproduced byte for byte for everything it could produce. It
 * could not produce a row the ontology refused — those rows did not exist then — so the
 * marker is scoped to exactly that case and to nothing else: a refused edge gains a
 * trailing `[REJECTED by the ontology: <reason>]`, and a refused entity gains one line
 * after its description. Every accepted prompt is unchanged, character for character.
 *
 * The reason this deviation is worth making: without it the model is handed a claim the
 * ontology did not admit, with nothing to tell it apart from an admitted one, and it
 * writes that claim into a wiki page where it later reads as a fact.
 */
export function buildPagePrompt(context: EntityPageContext): string {
  const { entity, outgoing, incoming, documents } = context;
  const relationshipText = relationshipLines(outgoing, incoming);
  const documentText = documentLines(documents);

  return `You are writing a wiki-style markdown page for one entity in a compiled
knowledge graph. Use ONLY the information given. Do not invent facts.
Do not speculate beyond what the graph supports.

ENTITY:
  Name: ${entity.name}
  Type: ${entity.type}
  Confidence: ${formatFixed2(Number(entity.confidence))}
  Existing description: ${entity.description ?? "(none)"}${entityOntologyNote(entity)}

RELATIONSHIPS:
${relationshipText}

CONTRIBUTING SOURCE DOCUMENTS:
${documentText}

Write a markdown page following this structure:

# ${entity.name}

A 2-4 sentence summary of what this entity is and its role in the domain.
Reference its key relationships naturally. Do not list relationships verbatim;
weave them into prose.

## Relationships

A bulleted list grouping outgoing and incoming relationships, written in
plain English (e.g., "Triggers an On-Call response when declared", not
"triggers --> On-Call"). Group by direction. Skip this section entirely
if no relationships exist.

## Sources

A bulleted list of contributing documents with their filenames and
ingestion dates. Skip this section entirely if no documents contributed.

Return ONLY the markdown. No preamble, no explanation, no code fences.`;
}
