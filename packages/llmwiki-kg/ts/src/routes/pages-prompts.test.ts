/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-prompts.test.ts
 * @description The page and description-synthesis prompts.
 */

import { describe, expect, it , vi } from "vitest";
import { buildPagePrompt } from "../core/page_generator.js";
import type { EntityPageContext } from "../core/page_generator.js";
import { buildSynthesisPrompt } from "./synthesize.js";
import { entityRow, relationshipRow, useDomainPrefix } from "./pages-harness.js";

// The provider env and the `complete` stub must be in place before the modules
// under test are imported; `vi.hoisted`/`vi.mock` are hoisted above imports.
vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

const completeMock = vi.hoisted(() => ({
  /** When false, the real `complete` is called. */
  enabled: true,
  /** Calls the stub intercepted, in order. */
  calls: [] as { prompt: string; maxTokens: number | undefined }[],
  /** Text the stub returns. */
  reply: "",
}));

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    complete: async (prompt: string, maxTokens?: number): Promise<string> => {
      if (!completeMock.enabled) {
        return actual.complete(prompt, maxTokens);
      }
      completeMock.calls.push({ prompt, maxTokens });
      return completeMock.reply;
    },
  };
});

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("prompts");

/**
 * The exact prompt text the oracle sent, captured by replacing `complete` with a
 * recorder.
 *
 * Kept as a module constant rather than inline in the test so the test body
 * states only the fixture and the comparison.
 */
const ORACLE_PAGE_PROMPT = [
  "You are writing a wiki-style markdown page for one entity in a compiled",
  "knowledge graph. Use ONLY the information given. Do not invent facts.",
  "Do not speculate beyond what the graph supports.",
  "",
  "ENTITY:",
  "  Name: Billing Service",
  "  Type: SYSTEM",
  "  Confidence: 0.70",
  "  Existing description: Processes invoices",
  "",
  "RELATIONSHIPS:",
  "  - This entity USESs Payment Gateway (SYSTEM, confidence 0.75)",
  "  - This entity HASs Rate Limit (CONCEPT, confidence 0.55)",
  "  - Alerting Pipeline (SYSTEM) TRIGGERSs this entity (confidence 0.60)",
  "",
  "CONTRIBUTING SOURCE DOCUMENTS:",
  "  - runbook.md (ingested 2026-10-21)",
  "  - billing.txt (ingested 2026-10-22)",
  "",
  "Write a markdown page following this structure:",
  "",
  "# Billing Service",
  "",
  "A 2-4 sentence summary of what this entity is and its role in the domain.",
  "Reference its key relationships naturally. Do not list relationships verbatim;",
  "weave them into prose.",
  "",
  "## Relationships",
  "",
  "A bulleted list grouping outgoing and incoming relationships, written in",
        'plain English (e.g., "Triggers an On-Call response when declared", not',
        '"triggers --> On-Call"). Group by direction. Skip this section entirely',
  "if no relationships exist.",
  "",
  "## Sources",
  "",
  "A bulleted list of contributing documents with their filenames and",
  "ingestion dates. Skip this section entirely if no documents contributed.",
  "",
  "Return ONLY the markdown. No preamble, no explanation, no code fences.",
      ].join("\n");

/** The graph the oracle prompt was captured from. */
function pagePromptFixture(): EntityPageContext {
  return {
    entity: entityRow(),
    outgoing: [
      relationshipRow({ type: "USES", confidence: 0.75, other_name: "Payment Gateway" }),
      relationshipRow({
        type: "HAS",
        confidence: 0.5512,
        other_name: "Rate Limit",
        other_type: "CONCEPT",
      }),
    ],
    incoming: [
      relationshipRow({
        type: "TRIGGERS",
        confidence: 0.6,
        other_name: "Alerting Pipeline",
        direction: "incoming",
      }),
    ],
    documents: [
      { id: "1", filename: "runbook.md", ingested_at: "2026-10-21T03:04:05.000000Z" },
      { id: "2", filename: "billing.txt", ingested_at: "2026-10-22T01:02:03.456789Z" },
    ],
  };
}

describe("page prompt", () => {
  /**
   * The prompt is the only input to a non-deterministic step, so holding it
   * constant is the strongest guarantee this port can offer about page *content*.
   *
   * Captured from the oracle by replacing `page_generator.complete` with a
   * recorder. The awkward bits are deliberate: the Python f-string produces
   * `USESs` and `HASs` (it appends `s` to a verb that is often already plural),
   * and confidence is `.2f`-formatted.
   */
  it("is byte-identical to the prompt the oracle sent", () => {
    expect(buildPagePrompt(pagePromptFixture())).toBe(ORACLE_PAGE_PROMPT);
  });

  it("uses the oracle's placeholder branches for an empty graph", () => {
    const prompt = buildPagePrompt({
      entity: entityRow({ name: "Lonely", description: null, confidence: 1 }),
      outgoing: [],
      incoming: [],
      documents: [],
    });

    expect(prompt).toContain("  Existing description: (none)\n");
    expect(prompt).toContain("  Confidence: 1.00\n");
    expect(prompt).toContain("RELATIONSHIPS:\n  (No relationships recorded)\n");
    expect(prompt).toContain("CONTRIBUTING SOURCE DOCUMENTS:\n  (No contributing documents)\n");
  });

  it("takes the ingestion date from the timestamp's date part", () => {
    // Python formats `datetime.date()`, so the time and zone never appear.
    const prompt = buildPagePrompt({
      entity: entityRow(),
      outgoing: [],
      incoming: [],
      documents: [
        { id: "1", filename: "a.md", ingested_at: "2026-01-02T23:59:59.999999Z" },
      ],
    });
    expect(prompt).toContain("  - a.md (ingested 2026-01-02)");
  });
});

describe("synthesis prompt", () => {
  it("is byte-identical to the prompt the oracle sent, with sorted domain names", () => {
    expect(
      buildSynthesisPrompt(
        "Billing Service",
        "SYSTEM",
        ["Payment Gateway", "Alerting Pipeline", "Rate Limit"],
        "short passage mentioning Billing Service",
      ),
    ).toBe(
      [
        "You are writing a compiled description for one entity in a knowledge graph.",
        "",
        "ENTITY: Billing Service",
        "TYPE: SYSTEM",
        "",
        "OTHER ENTITIES IN THIS DOMAIN (reference them naturally if relevant):",
        "Alerting Pipeline, Payment Gateway, Rate Limit",
        "",
        "SOURCE PASSAGES THAT MENTION THIS ENTITY:",
        "short passage mentioning Billing Service",
        "",
        "Write a description that is 2-4 sentences, reflects what the passages",
        "say, references siblings naturally when relevant, and contains no",
        "filler. Return ONLY the description as plain prose.",
      ].join("\n"),
    );
  });
});
