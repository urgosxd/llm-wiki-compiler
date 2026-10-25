/**
 * @file packages/llmwiki-kg/ts/src/core/llm/strict-mode.test.ts
 * @description `strict: true` on the wire, and the schema shape it requires.
 *
 * WHY THIS FILE EXISTS. Adding `enum` to the tool schema only guides the model
 * if the request tells the provider to enforce the schema. On OpenAI that is the
 * `strict` flag; without it, structured outputs are not enabled and an `enum` is
 * the same advisory hint the description always was.
 *
 * The flag is sent only for `EXTRACTION_PROVIDER=openai`. `gateway` is any
 * OpenAI-compatible server and cannot be assumed to implement the extension,
 * while `anthropic` has no such field and enforces tool schemas always. This file
 * pins all three, because sending the flag to a gateway that rejects it would
 * turn a schema hint into an outage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callTool } from "./tool-call.js";
import type { ToolDefinition } from "./tool-call.js";

/** A minimal tool, so the assertions are about the payload and nothing else. */
const TOOL: ToolDefinition = {
  name: "KGSchema",
  description: "Knowledge Graph Schema.",
  parameters: { type: "object", properties: {}, required: [] },
};

/** Replaces `fetch` and captures the parsed request body. */
function captureRequest(): { body: () => Record<string, unknown> | undefined } {
  let sent: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const payload = {
      content: [{ type: "tool_use", input: { triplets: [], entities: [] } }],
      choices: [
        { message: { tool_calls: [{ function: { arguments: '{"triplets":[],"entities":[]}' } }] } },
      ],
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    } as unknown as Response;
  });
  return { body: () => sent };
}

/** The `function` object of the first advertised tool. */
function firstFunction(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const tools = (body?.["tools"] ?? []) as Array<Record<string, Record<string, unknown>>>;
  return tools[0]?.["function"] ?? {};
}

/** Points config at one extraction provider without touching the environment. */
async function useProvider(provider: "openai" | "gateway" | "anthropic"): Promise<void> {
  vi.resetModules();
  vi.doMock("../../config.js", async () => {
    const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
    return {
      ...actual,
      config: {
        ...actual.config,
        EXTRACTION_PROVIDER: provider,
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: "test-key",
        GATEWAY_URL: "https://gateway.example/v1",
        GATEWAY_API_KEY: "gateway-key",
      },
    };
  });
}

describe("strict mode on the wire", () => {
  beforeEach(() => {
    captureRequest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../config.js");
    vi.resetModules();
  });

  it("sends strict: true to OpenAI, so the schema is enforced rather than hinted", async () => {
    const capture = captureRequest();
    await useProvider("openai");
    const { callTool: freshCallTool } = await import("./tool-call.js");

    await freshCallTool("prompt", TOOL);

    expect(firstFunction(capture.body())["strict"]).toBe(true);
  });

  it("does not send strict to a gateway, whose support cannot be assumed", async () => {
    // A gateway that does not implement the extension would reject the whole
    // request, turning a schema hint into an outage on an unknown backend.
    const capture = captureRequest();
    await useProvider("gateway");
    const { callTool: freshCallTool } = await import("./tool-call.js");

    await freshCallTool("prompt", TOOL);

    expect(firstFunction(capture.body())).not.toHaveProperty("strict");
  });

  it("never sends strict to Anthropic, which has no such field", async () => {
    const capture = captureRequest();
    await useProvider("anthropic");
    const { callTool: freshCallTool } = await import("./tool-call.js");

    await freshCallTool("prompt", TOOL);

    expect(JSON.stringify(capture.body())).not.toContain('"strict"');
  });
});

describe("the shipped tool schema satisfies strict mode", () => {
  it("is closed at every level and requires every property", async () => {
    // OpenAI rejects a strict-mode schema that leaves an object open or a
    // property optional, so this is a precondition for the flag above.
    const { buildToolSchema } = await import("../graph-prompt.js");
    const defined = buildToolSchema();

    expect(defined.parameters.additionalProperties).toBe(false);
    for (const [name, definition] of Object.entries(
      defined.parameters.$defs as Record<string, Record<string, unknown>>,
    )) {
      expect(definition["additionalProperties"], `${name} should be closed`).toBe(false);
      expect(definition["required"], `${name} should require all properties`).toEqual(
        Object.keys(definition["properties"] as Record<string, unknown>),
      );
    }
  });
});

// Keeps the imported binding referenced so the module-level import is not dead
// when every test re-imports a fresh copy.
void callTool;
