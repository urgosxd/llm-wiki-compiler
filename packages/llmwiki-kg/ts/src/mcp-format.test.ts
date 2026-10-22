/**
 * @file packages/llmwiki-kg/ts/src/mcp-format.test.ts
 * @description Python-compatible number formatting and response formatting.
 */

import { describe, expect, it } from "vitest";
import { formatContextResponse, formatEntitiesResponse, formatFixed2, formatStacksResponse, formatTraverseResponse } from "./mcp.js";
import { EXPECTED_CTX, EXPECTED_CTX_NO_ENTITIES, EXPECTED_ENTS, EXPECTED_ENTS_EMPTY, EXPECTED_STACKS, EXPECTED_STACKS_EMPTY, EXPECTED_TRAV, EXPECTED_TRAV_NO_STEPS, ORACLE_ENTITIES_EMPTY_BODY, ORACLE_STACKS_BODY, SYNTHETIC_CONTEXT_RESPONSE, SYNTHETIC_ENTITIES_RESPONSE, SYNTHETIC_TRAVERSE_RESPONSE } from "./mcp-harness.js";

describe("formatFixed2", () => {
  it("rounds half to even like Python, where toFixed rounds half away from zero", () => {
    // These four are the cases where toFixed(2) differs: 0.125 -> "0.13",
    // 0.625 -> "0.63", 1.125 -> "1.13", 0.995 -> "1.00"(Intl) / "0.99"(py).
    expect(formatFixed2(0.125)).toBe("0.12");
    expect(formatFixed2(0.375)).toBe("0.38");
    expect(formatFixed2(0.625)).toBe("0.62");
    expect(formatFixed2(1.125)).toBe("1.12");
    // Sanity: toFixed really does disagree, so this test is load-bearing.
    expect((0.125).toFixed(2)).toBe("0.13");
  });

  it("matches Python on the values the oracle actually stores", () => {
    // Verbatim format(v, ".2f") output from CPython for each input.
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "0.00"],
      [0.5, "0.50"],
      [0.51, "0.51"],
      [0.62, "0.62"],
      [0.75, "0.75"],
      [0.85, "0.85"],
      [0.87, "0.87"],
      [0.9, "0.90"],
      [1, "1.00"],
      [0.005, "0.01"],
      [0.0625, "0.06"],
      [0.9375, "0.94"],
      [2.675, "2.67"],
      [1.005, "1.00"],
      [0.995, "0.99"],
      [33.333333, "33.33"],
      [123456.785, "123456.79"],
      [-0.001, "-0.00"],
    ];
    for (const [input, expected] of cases) {
      expect(formatFixed2(input), `format(${String(input)}, ".2f")`).toBe(expected);
    }
  });

  it("keeps the negative sign on negative zero, as Python does", () => {
    expect(formatFixed2(-0)).toBe("-0.00");
    expect(formatFixed2(-1e-9)).toBe("-0.00");
  });

  it("handles values far outside any confidence range without exponent notation", () => {
    // Python switches to fixed notation for ".2f" at every magnitude.
    expect(formatFixed2(1e21)).toBe("1000000000000000000000.00");
    expect(formatFixed2(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991.00");
  });

  it("reproduces Python's spellings for the non-finite values", () => {
    expect(formatFixed2(Number.NaN)).toBe("nan");
    expect(formatFixed2(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(formatFixed2(Number.NEGATIVE_INFINITY)).toBe("-inf");
  });
});

describe("formatStacksResponse", () => {
  it("formats the REAL oracle GET /stacks body exactly as Python does", () => {
    // Live body captured from localhost:8000; expected text from the Python
    // `_list_stacks` loop. This is a genuine oracle-parity assertion.
    expect(formatStacksResponse(JSON.parse(ORACLE_STACKS_BODY))).toBe(EXPECTED_STACKS);
  });

  it("reports the empty case the way Python does", () => {
    // REAL oracle body `[]` (the DB was reset and had no Stacks at one point).
    expect(formatStacksResponse(JSON.parse(ORACLE_ENTITIES_EMPTY_BODY))).toBe(
      EXPECTED_STACKS_EMPTY,
    );
  });

  it("indents a Stack description under the bullet when present", () => {
    const body = [
      { name: "Alpha", domain: "alpha", description: "First Stack" },
      { name: "Beta", domain: "beta", description: null },
    ];
    // Python: `    {description}` (four spaces) under the bullet.
    expect(formatStacksResponse(body)).toBe(
      "Found 2 Stack(s):\n\n• Alpha (domain: alpha)\n    First Stack\n• Beta (domain: beta)",
    );
  });
});

describe("formatEntitiesResponse", () => {
  it("formats a REAL empty oracle GET /aks/v1/entities body", () => {
    expect(formatEntitiesResponse(JSON.parse(ORACLE_ENTITIES_EMPTY_BODY))).toBe(
      EXPECTED_ENTS_EMPTY,
    );
  });

  it("formats the documented-shape entity list exactly as Python does", () => {
    // SYNTHETIC (no oracle entities exist): the oracle's only Stacks are empty.
    // The expected text is real Python output for this JSON.
    expect(formatEntitiesResponse(JSON.parse(SYNTHETIC_ENTITIES_RESPONSE))).toBe(EXPECTED_ENTS);
  });

  it("marks verified entities and skips the description line when absent", () => {
    // The second fixture entity has `source.verified: false` and a null
    // description: no ✓ and no indented line, matching Python.
    const text = formatEntitiesResponse(JSON.parse(SYNTHETIC_ENTITIES_RESPONSE));
    expect(text.split("\n")).toContain("  Handles card payments.");
    expect(text).not.toContain("Refund Flow [Process, conf 0.50] ✓");
  });

  it("omits the marker entirely when `source` is missing, as Python's .get does", () => {
    const body = [
      { name: "Bare", type: "Thing", description: null, confidence: 0.5 },
    ];
    expect(formatEntitiesResponse(body)).toBe(
      "Found 1 entities:\n\n• Bare [Thing, conf 0.50]",
    );
  });
});

describe("formatTraverseResponse", () => {
  it("formats the documented-shape traverse response exactly as Python does", () => {
    // SYNTHETIC body (oracle has no entities to traverse from); real Python text.
    expect(formatTraverseResponse(JSON.parse(SYNTHETIC_TRAVERSE_RESPONSE))).toBe(EXPECTED_TRAV);
  });

  it("indents each step by two spaces per depth level", () => {
    const lines = formatTraverseResponse(JSON.parse(SYNTHETIC_TRAVERSE_RESPONSE)).split("\n");
    const steps = lines.filter((line) => line.includes("•"));
    expect(steps).toEqual([
      "• Payment Service —[requires]→ Refund Flow (depth 0, conf 0.75)",
      "  • Refund Flow —[triggers]→ Audit Log (depth 1, conf 0.62)",
      "    • Audit Log —[notifies]→ Ops (depth 2, conf 0.12)",
    ]);
    // The last step's 0.125 confidence prints as 0.12, not 0.13.
    expect(lines[lines.length - 1]).toContain("conf 0.12");
  });

  it("reports the no-steps case the way Python does", () => {
    const body = { start: "Payment Service", max_depth: 2, steps: [], entity_count: 4 };
    expect(formatTraverseResponse(body)).toBe(EXPECTED_TRAV_NO_STEPS);
  });
});

describe("formatContextResponse", () => {
  it("formats the documented-shape context response exactly as Python does", () => {
    // SYNTHETIC body: POST /aks/v1/context answers 500 in this environment
    // (no LLM credentials), so no real context body could be recorded.
    expect(formatContextResponse(JSON.parse(SYNTHETIC_CONTEXT_RESPONSE))).toBe(EXPECTED_CTX);
  });

  it("resolves relationship endpoints by id, falling back to the raw id", () => {
    // The second relationship points from an id absent from `entities`; Python
    // prints the raw id. The em dash and arrow are U+2014 / U+2192.
    const text = formatContextResponse(JSON.parse(SYNTHETIC_CONTEXT_RESPONSE));
    expect(text).toContain("• Payment Service —[requires]→ Refund Flow");
    expect(text).toContain("• EEEE-MISSING —[triggers]→ Payment Service");
  });

  it("reports no-entities the way Python does, and omits the relationships block", () => {
    const body = {
      query: "how are refunds handled?",
      entities: [],
      relationships: [],
      reasoning: "Matched on refund keywords.",
      confidence: "HIGH",
    };
    expect(formatContextResponse(body)).toBe(EXPECTED_CTX_NO_ENTITIES);
  });

  it("prints '(no description)' never, matching Python's masked-branch behaviour", () => {
    // Python sets desc to "(no description)" and then skips the line by
    // comparing against that sentinel, so the placeholder never reaches output.
    const body = {
      query: "q",
      entities: [{ id: "id-1", name: "E", type: "T", description: null, confidence: 0.5 }],
      relationships: [],
      reasoning: "r",
      confidence: "LOW",
    };
    const text = formatContextResponse(body);
    expect(text).toContain("  • E [T, conf 0.50]");
    expect(text).not.toContain("(no description)");
  });
});
