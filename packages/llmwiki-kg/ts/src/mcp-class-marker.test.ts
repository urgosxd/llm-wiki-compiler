/**
 * @file packages/llmwiki-kg/ts/src/mcp-class-marker.test.ts
 * @description S4's prose half: a rejected item is visibly different in the text.
 *
 * An agent reading bullets does not parse a nested key it was never told to look for,
 * so the class has to reach the rendered line. What matters here is BOTH halves of the
 * contract: a rejected edge/entity changes shape, and an accepted one keeps the exact
 * line it produced before this feature — the accepted rendering is quoted byte for byte.
 *
 * The edge index is passed in rather than read from the payload because AKS closes a
 * relationship: the class is resolved from this package's own graph projection (see
 * `mcp/handlers.ts`), and an empty index must render exactly as before.
 */

import { describe, expect, it } from "vitest";

import { formatContextResponse, formatEntitiesResponse, formatTraverseResponse } from "./mcp.js";
import { refusedEdgeKey } from "./mcp/format.js";

const GATEWAY = "11111111-1111-4111-8111-111111111111";
const MODEL = "22222222-2222-4222-8222-222222222222";
const EDGE = "33333333-3333-4333-8333-333333333333";

/** One entity as the AKS context answer carries it. */
function entity(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: name === "Gateway" ? GATEWAY : MODEL,
    name,
    type: name === "Gateway" ? "SYSTEM" : "TECHNOLOGY",
    description: null,
    confidence: 0.75,
    properties,
  };
}

/** One `POST /aks/v1/context` answer carrying a single edge. */
function context(edgeType: string): Record<string, unknown> {
  return {
    query: "how are refunds handled?",
    confidence: "HIGH",
    reasoning: "one edge connects them",
    entities: [entity("Gateway"), entity("Embedding Model")],
    relationships: [
      {
        id: EDGE,
        from_entity_id: GATEWAY,
        to_entity_id: MODEL,
        type: edgeType,
        description: null,
        confidence: 0.75,
      },
    ],
  };
}

/** The relationship line of a formatted context answer, last line only. */
function relationshipLine(text: string): string {
  const lines = text.split("\n");
  return lines[lines.length - 1] ?? "";
}

/** The index a refused `Gateway -> Embedding Model` edge produces. */
const REFUSED = new Map([
  [refusedEdgeKey("Gateway", "ABSORBS", "Embedding Model"), "UNKNOWN_RELATIONSHIP_TYPE"],
]);

describe("the relationship bullet", () => {
  it("keeps the accepted bullet exactly as it was before the marker existed", () => {
    const text = formatContextResponse(context("USED_BY"));

    expect(relationshipLine(text)).toBe("  • Gateway —[USED_BY]→ Embedding Model");
  });

  it("marks a refused edge in the bullet itself, resolved from the graph projection", () => {
    const text = formatContextResponse(context("ABSORBS"), REFUSED);

    expect(relationshipLine(text)).toBe(
      "  • Gateway —[ABSORBS (REJECTED by ontology: UNKNOWN_RELATIONSHIP_TYPE)]→ Embedding Model",
    );
  });

  it("leaves an edge unmarked when the index could not be resolved", () => {
    // The pinned gap: with no index the class is simply not on the wire at all, so the
    // line is the plain one. The handler discloses this instead of hiding it.
    expect(relationshipLine(formatContextResponse(context("ABSORBS")))).toBe(
      "  • Gateway —[ABSORBS]→ Embedding Model",
    );
  });
});

describe("the entity bullet", () => {
  const refused = {
    ontology_classification: {
      verdict: "rejected",
      reason: "UNKNOWN_ENTITY_TYPE",
      offending_type: "WIDGET",
    },
  };

  it("marks a refused entity from the block inside its properties", () => {
    const text = formatContextResponse({
      ...context("USED_BY"),
      entities: [entity("Gateway", refused)],
    });

    expect(text).toContain(
      "  • Gateway [SYSTEM (REJECTED by ontology: UNKNOWN_ENTITY_TYPE), conf 0.75]",
    );
  });

  it("keeps the accepted entity bullet unchanged in the entity list", () => {
    expect(formatEntitiesResponse([entity("Gateway")])).toContain("• Gateway [SYSTEM, conf 0.75]");
  });

  it("marks a refused entity in the entity list the same way", () => {
    expect(formatEntitiesResponse([entity("Gateway", refused)])).toContain(
      "• Gateway [SYSTEM (REJECTED by ontology: UNKNOWN_ENTITY_TYPE), conf 0.75]",
    );
  });
});

describe("the traversal step line", () => {
  /** One traverse answer carrying a single step with the given class. */
  function traverse(verdict: "accepted" | "rejected"): Record<string, unknown> {
    return {
      start: "Gateway",
      max_depth: 2,
      entity_count: 2,
      steps: [
        {
          from_entity: "Gateway",
          relationship: "ABSORBS",
          to_entity: "Embedding Model",
          depth: 1,
          confidence: 0.75,
          ontology_classification: {
            verdict,
            reason: verdict === "rejected" ? "UNKNOWN_RELATIONSHIP_TYPE" : null,
            offending_type: verdict === "rejected" ? "ABSORBS" : null,
          },
        },
      ],
    };
  }

  it("keeps the accepted step line exactly as it was", () => {
    expect(formatTraverseResponse(traverse("accepted"))).toContain(
      "\n  • Gateway —[ABSORBS]→ Embedding Model (depth 1, conf 0.75)",
    );
  });

  it("marks a refused step, because a walk crosses refused edges by default", () => {
    expect(formatTraverseResponse(traverse("rejected"))).toContain(
      "\n  • Gateway —[ABSORBS (REJECTED by ontology: UNKNOWN_RELATIONSHIP_TYPE)]→ Embedding Model" +
        " (depth 1, conf 0.75)",
    );
  });
});
