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

// ============================================================
// Response formatting
// ============================================================
// MCP tool results are text. The AKS endpoints return JSON. These mirror
// `_format_context_response`, `_format_traverse_response`,
// `_format_entities_response` and the inline Stack loop in `_list_stacks`,
// including the bullet character (U+2022) and the exact indentation.

/** Format `/aks/v1/context` output into a compact readable response. */
export function formatContextResponse(data: unknown): string {
  const record = asRecord(data);
  if (record === null) throw new Error("Context response is not an object");

  const lines = [
    `Query: ${asText(requireField(record, "query"))}`,
    `Confidence: ${asText(requireField(record, "confidence"))}`,
    `Reasoning: ${asText(requireField(record, "reasoning"))}`,
    "",
  ];

  const entities = asArray(record["entities"]);
  if (entities.length > 0) {
    lines.push(`Relevant entities (${entities.length}):`);
    for (const entity of entities) {
      const e = asRecord(entity);
      if (e === null) throw new Error("Context entity is not an object");
      const descriptionRaw = e["description"];
      const description =
        typeof descriptionRaw === "string" && descriptionRaw.length > 0
          ? descriptionRaw
          : "(no description)";
      const confidence = asNumber(e["confidence"], "confidence");
      lines.push(
        `  • ${asText(requireField(e, "name"))} [${asText(
          requireField(e, "type"),
        )}, conf ${formatFixed2(confidence)}]`,
      );
      if (description !== "(no description)") {
        lines.push(`    ${description}`);
      }
    }
  } else {
    lines.push("No relevant entities found.");
  }

  const relationships = asArray(record["relationships"]);
  if (relationships.length > 0) {
    lines.push("");
    lines.push(`Relationships (${relationships.length}):`);
    // Relationships carry IDs only; the entity list above is the name lookup.
    const nameMap = new Map<string, string>();
    for (const entity of entities) {
      const e = asRecord(entity);
      if (e === null) continue;
      const id = requireField(e, "id");
      if (typeof id !== "string") throw new Error("Context entity 'id' is not a string");
      nameMap.set(id, asText(requireField(e, "name")));
    }
    for (const relationship of relationships) {
      const r = asRecord(relationship);
      if (r === null) throw new Error("Context relationship is not an object");
      const fromId = asText(requireField(r, "from_entity_id"));
      const toId = asText(requireField(r, "to_entity_id"));
      const fromName = nameMap.get(fromId) ?? fromId;
      const toName = nameMap.get(toId) ?? toId;
      lines.push(`  • ${fromName} —[${asText(requireField(r, "type"))}]→ ${toName}`);
    }
  }

  return lines.join("\n");
}

/** Format `/aks/v1/traverse` output. */
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
      )}]→ ${asText(requireField(s, "to_entity"))} (depth ${asText(depth)}, conf ${formatFixed2(
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
      )}, conf ${formatFixed2(asNumber(requireField(e, "confidence"), "confidence"))}]${verifiedMarker}`,
    );
    const description = e["description"];
    if (typeof description === "string" && description.length > 0) {
      lines.push(`  ${description}`);
    }
  }

  return lines.join("\n");
}

/** Format `GET /stacks` output — the inline loop from `_list_stacks`. */
export function formatStacksResponse(data: unknown): string {
  const stacks = asArray(data);
  if (stacks.length === 0) return "No Stacks exist on this AKS server yet.";

  const lines = [`Found ${stacks.length} Stack(s):`, ""];
  for (const stack of stacks) {
    const s = asRecord(stack);
    if (s === null) throw new Error("Stack is not an object");
    lines.push(`• ${asText(requireField(s, "name"))} (domain: ${asText(requireField(s, "domain"))})`);
    const description = s["description"];
    if (typeof description === "string" && description.length > 0) {
      lines.push(`    ${description}`);
    }
  }

  return lines.join("\n");
}
