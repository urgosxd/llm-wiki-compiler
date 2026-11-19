/**
 * @file packages/llmwiki-kg/ts/src/mcp/format.ts
 * @description Turning API responses into the text an MCP client shows a model.
 *
 * These formatters are why the output is readable rather than a JSON dump, and
 * their exact wording is asserted by tests — a reworded line is a behavioural
 * change for any agent reading it.
 */

import { asArray, asNumber, asRecord, asText, requireField } from "./narrow.js";
import { formatFixed2 } from "./py-format.js";

/** What an entity with no description is rendered as. */
const NO_DESCRIPTION = "(no description)";

// ============================================================
// Response formatting
// ============================================================
// MCP tool results are text. The AKS endpoints return JSON. The bullet character
// (U+2022) and the exact indentation are part of that text, not cosmetic.

/** The context entity's description, or the placeholder for an empty one. */
function contextDescription(entity: Record<string, unknown>): string {
  const raw = entity["description"];
  return typeof raw === "string" && raw.length > 0 ? raw : NO_DESCRIPTION;
}

/**
 * An edge the ontology refused, keyed by what a rendered line actually knows.
 *
 * The MCP server formats AKS JSON, and AKS closes a relationship
 * (`SCHEMA.json:562`, `additionalProperties: false`, no `properties` map), so the class
 * of an edge is nowhere in the payload being formatted. It is resolved from this
 * package's own graph projection instead — `GET /domain/kg/stacks/:id/graph`, whose
 * edges DO carry the class — and handed here as a set of
 * `from label | type | to label` keys.
 *
 * Empty by construction when the caller could not resolve the index, so a formatter
 * never invents a marker and never fails because one is missing.
 */
export type RefusedEdges = ReadonlyMap<string, string | null>;

/** The key one rendered edge line matches against. */
export function refusedEdgeKey(from: string, type: string, to: string): string {
  return `${from}\u0000${type}\u0000${to}`;
}

/** The disclosure appended when the ontology classes could not be resolved. */
export const UNRESOLVED_CLASS_DISCLOSURE =
  "Note: the ontology classification of these relationships could not be resolved, so a" +
  " refused edge may appear here unmarked. Call the tool again, or use accepted_only: true" +
  " to exclude refused items.";

/**
 * The marker a REFUSED edge carries in rendered text, or nothing at all.
 *
 * The class must be visible at a glance, so it is not a trailing key a reader has to
 * know to look for: it sits inside the edge's own type bracket, where the reader is
 * already looking. The rendering is additive — an accepted edge produces the exact line
 * it produced before this marker existed.
 */
function refusedEdgeMarker(from: string, type: string, to: string, refused: RefusedEdges): string {
  const key = refusedEdgeKey(from, type, to);
  if (!refused.has(key)) return "";
  const reason = refused.get(key) ?? null;
  // The reason is stated when it is known: "refused" without it does not tell a reader
  // whether the verb or one of the endpoints was the problem.
  return reason === null ? " (REJECTED by ontology)" : ` (REJECTED by ontology: ${reason})`;
}

/**
 * The marker a REFUSED traversal step carries, or nothing at all.
 *
 * A step carries its class inline (`ontology_classification`), because a traversal step
 * is not an AKS `$defs` type — the vendored schema defines no step object — so no
 * external index is needed here, unlike on a relationship.
 */
function refusedStepMarker(step: Record<string, unknown>): string {
  const block = asRecord(step["ontology_classification"]);
  if (block === null || block["verdict"] !== "rejected") return "";
  const reason = block["reason"];
  return typeof reason === "string" && reason.length > 0
    ? ` (REJECTED by ontology: ${reason})`
    : " (REJECTED by ontology)";
}

/**
 * The marker a REFUSED entity carries, or nothing at all.
 *
 * An entity's class DOES travel on the wire, inside `properties`
 * (`SCHEMA.json:520` leaves that map open) under the reserved
 * `ontology_classification` key. Its absence means the ontology raised nothing against
 * this entity, which is the same convention `kg_classification` follows.
 */
function refusedEntityMarker(entity: Record<string, unknown>): string {
  const properties = asRecord(entity["properties"]);
  const block = properties === null ? null : asRecord(properties["ontology_classification"]);
  if (block === null || block["verdict"] !== "rejected") return "";
  const reason = block["reason"];
  return typeof reason === "string" && reason.length > 0
    ? ` (REJECTED by ontology: ${reason})`
    : " (REJECTED by ontology)";
}

/** Renders the "Relevant entities" block, or the not-found marker. */
function entityLines(entities: readonly unknown[]): string[] {
  if (entities.length === 0) {
    return ["No relevant entities found."];
  }

  const lines = [`Relevant entities (${entities.length}):`];
  for (const entity of entities) {
    const e = asRecord(entity);
    if (e === null) throw new Error("Context entity is not an object");
    const description = contextDescription(e);
    const confidence = asNumber(e["confidence"], "confidence");
    lines.push(
      `  • ${asText(requireField(e, "name"))} [${asText(
        requireField(e, "type"),
      )}${refusedEntityMarker(e)}, conf ${formatFixed2(confidence)}]`,
    );
    if (description !== NO_DESCRIPTION) {
      lines.push(`    ${description}`);
    }
  }
  return lines;
}

/** Maps entity id → name, which is how relationships recover their endpoints. */
function entityNameMap(entities: readonly unknown[]): Map<string, string> {
  // Relationships carry IDs only; the entity list above is the name lookup.
  const nameMap = new Map<string, string>();
  for (const entity of entities) {
    const e = asRecord(entity);
    if (e === null) continue;
    const id = requireField(e, "id");
    if (typeof id !== "string") throw new Error("Context entity 'id' is not a string");
    nameMap.set(id, asText(requireField(e, "name")));
  }
  return nameMap;
}

/** Renders the "Relationships" block, or nothing when there are none. */
function relationshipLines(
  record: Record<string, unknown>,
  entities: readonly unknown[],
  refused: RefusedEdges,
): string[] {
  const relationships = asArray(record["relationships"]);
  if (relationships.length === 0) {
    return [];
  }

  const lines = ["", `Relationships (${relationships.length}):`];
  const nameMap = entityNameMap(entities);
  for (const relationship of relationships) {
    const r = asRecord(relationship);
    if (r === null) throw new Error("Context relationship is not an object");
    const fromId = asText(requireField(r, "from_entity_id"));
    const toId = asText(requireField(r, "to_entity_id"));
    const fromName = nameMap.get(fromId) ?? fromId;
    const toName = nameMap.get(toId) ?? toId;
    const type = asText(requireField(r, "type"));
    lines.push(
      `  • ${fromName} —[${type}${refusedEdgeMarker(fromName, type, toName, refused)}]→ ${toName}`,
    );
  }
  return lines;
}

/**
 * Format `/aks/v1/context` output into a compact readable response.
 *
 * @param data - The AKS context answer.
 * @param refused - Edges this package resolved as ontology-refused, from its own graph
 *   projection. Empty means "nothing known", never "nothing refused".
 */
export function formatContextResponse(data: unknown, refused: RefusedEdges = new Map()): string {
  const record = asRecord(data);
  if (record === null) throw new Error("Context response is not an object");

  const entities = asArray(record["entities"]);
  const lines = [
    `Query: ${asText(requireField(record, "query"))}`,
    `Confidence: ${asText(requireField(record, "confidence"))}`,
    `Reasoning: ${asText(requireField(record, "reasoning"))}`,
    "",
    ...entityLines(entities),
    ...relationshipLines(record, entities, refused),
  ];

  return lines.join("\n");
}
/**
 * Format `/aks/v1/traverse` output.
 *
 * A step carries its own class (`ontology_classification`), because a traversal step is
 * not an AKS `$defs` type — the vendored schema defines no step object at all — so this
 * surface needs no external index.
 */
export function formatTraverseResponse(data: unknown): string {
  const record = asRecord(data);
  if (record === null) throw new Error("Traverse response is not an object");

  const lines = [
    `Traversal from: ${asText(requireField(record, "start"))}`,
    `Max depth: ${asText(requireField(record, "max_depth"))}`,
    `Entities reached: ${asText(requireField(record, "entity_count"))}`,
    "",
  ];

  const steps = asArray(record["steps"]);
  if (steps.length === 0) {
    lines.push("(No relationships found from this entity)");
    return lines.join("\n");
  }

  lines.push(`Path (${steps.length} steps):`);
  for (const step of steps) {
    const s = asRecord(step);
    if (s === null) throw new Error("Traverse step is not an object");
    const depth = asNumber(requireField(s, "depth"), "depth");
    // `"  " * s["depth"]`. Python's `str * int` repeats (a negative count yields
    // "", and a float count is a TypeError), while JS `String.repeat` throws
    // RangeError on a negative count. Clamping to 0 reproduces the Python for
    // the integer case; the schema types `depth` as an integer, and BFS emits
    // depths starting at 0.
    if (!Number.isInteger(depth)) {
      throw new Error(`Traverse step 'depth' is not an integer: ${String(depth)}`);
    }
    const indent = "  ".repeat(Math.max(0, depth));
    lines.push(
      `${indent}• ${asText(requireField(s, "from_entity"))} —[${asText(
        requireField(s, "relationship"),
      )}${refusedStepMarker(s)}]→ ${asText(requireField(s, "to_entity"))} (depth ${asText(depth)}, conf ${formatFixed2(
        asNumber(requireField(s, "confidence"), "confidence"),
      )})`,
    );
  }

  return lines.join("\n");
}

/** Format `/aks/v1/entities` output (list of entities). */
export function formatEntitiesResponse(data: unknown): string {
  const entities = asArray(data);
  if (entities.length === 0) return "(No entities matched the filter)";

  const lines = [`Found ${entities.length} entities:`, ""];
  for (const entity of entities) {
    const e = asRecord(entity);
    if (e === null) throw new Error("Entity is not an object");
    // `e.get("source", {}).get("verified")` — a missing or non-object `source`
    // is falsy in Python, so it yields no marker rather than an error.
    const source = asRecord(e["source"]);
    const verifiedMarker = source !== null && source["verified"] === true ? " ✓" : "";
    lines.push(
      `• ${asText(requireField(e, "name"))} [${asText(
        requireField(e, "type"),
      )}${refusedEntityMarker(e)}, conf ${formatFixed2(
        asNumber(requireField(e, "confidence"), "confidence"),
      )}]${verifiedMarker}`,
    );
    const description = e["description"];
    if (typeof description === "string" && description.length > 0) {
      lines.push(`  ${description}`);
    }
  }

  return lines.join("\n");
}
