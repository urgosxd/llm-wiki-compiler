/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-synthesis.test.ts
 * @description The synthesis endpoints with the LLM stubbed.
 */

import { describe, expect, it, beforeEach, afterAll , vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { BACKFILL_KEYS, SYNTHESIZE_ONE_KEYS, createFixture, createTestApp, database, deleteFixtureRows, state, useDomainPrefix } from "./pages-harness.js";
import { sql } from "drizzle-orm";

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
useDomainPrefix("synthesis");

describe.skipIf(state.skipReason !== false)("synthesis endpoints (LLM stubbed)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    completeMock.enabled = true;
    completeMock.calls.length = 0;
    completeMock.reply = "A synthesized description.";
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("synthesizes one entity and reports the stored description", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/aks/v1/entities/Billing%20Service/synthesize-description?domain=${fixture.domain}`)
      .expect(200);

    // Plain-dict insertion order from the Python handler.
    expect(Object.keys(response.body as object)).toEqual([...SYNTHESIZE_ONE_KEYS]);
    expect(response.body).toEqual({
      entity_name: "Billing Service",
      description: "A synthesized description.",
      synthesized: true,
    });

    expect(completeMock.calls).toHaveLength(1);
    // `complete(prompt, max_tokens=300)` — the description budget.
    expect(completeMock.calls[0]?.maxTokens).toBe(300);
    // The prompt carries the chunk that mentions the entity, and the domain
    // context lists every sibling name.
    const prompt = completeMock.calls[0]?.prompt ?? "";
    expect(prompt).toContain("The Billing Service processes invoices and calls the Payment Gateway");
    expect(prompt).toContain("Payment Gateway, Rate Limit");

    // The write is committed, not just reported.
    const rows = await database().execute<{ description: string }>(sql`
      select description from ontology_entities where id = ${fixture.entityIds.billing}
    `);
    expect(rows[0]?.description).toBe("A synthesized description.");
  });

  it("reports synthesized: false and skips the model when nothing grounds the entity", async () => {
    const fixture = await createFixture();

    // `Payment Gateway` has no contributing documents, so no chunk can mention
    // it: the handler returns before calling the model.
    const response = await request(app)
      .post(`/aks/v1/entities/Payment%20Gateway/synthesize-description?domain=${fixture.domain}`)
      .expect(200);

    expect(response.body).toEqual({
      entity_name: "Payment Gateway",
      description: null,
      synthesized: false,
    });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("404s for an entity outside the Stack, without spending a call", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/aks/v1/entities/Nope/synthesize-description?domain=${fixture.domain}`)
      .expect(404);
    expect(response.body).toEqual({ detail: "Entity 'Nope' not found in Stack" });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("backfills the Stack, counting every candidate as synthesized or skipped", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      // `{}` is the whole-over-body default: `only_missing` becomes true.
      .send({})
      .expect(200);

    expect(Object.keys(response.body as object)).toEqual([...BACKFILL_KEYS]);
    const body = response.body as {
      stack_id: string;
      entities_considered: number;
      entities_synthesized: number;
      entities_skipped: number;
    };
    expect(body.stack_id).toBe(fixture.stackId);

    // Only `Payment Gateway` has a short description (`null`), so it is the sole
    // candidate under `only_missing`. It has no chunks, so it is skipped — which
    // is the honest outcome, and it costs no model call.
    expect(body.entities_considered).toBe(2);
    expect(body.entities_synthesized).toBe(0);
    expect(body.entities_skipped).toBe(2);
    expect(body.entities_considered).toBe(body.entities_synthesized + body.entities_skipped);
    expect(completeMock.calls).toHaveLength(0);
  });

  it("backfills everything when only_missing is false, calling the model per grounded entity", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ only_missing: false })
      .expect(200);

    const body = response.body as {
      entities_considered: number;
      entities_synthesized: number;
      entities_skipped: number;
    };
    expect(body.entities_considered).toBe(3);
    expect(body.entities_synthesized).toBe(1);
    expect(body.entities_skipped).toBe(2);
    expect(completeMock.calls).toHaveLength(1);
  });

  it("scopes a backfill to entity_ids when the list is non-empty", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: [fixture.entityIds.billing], only_missing: false })
      .expect(200);

    expect(response.body).toMatchObject({
      entities_considered: 1,
      entities_synthesized: 1,
      entities_skipped: 0,
    });

    // An unknown id narrows to nothing rather than failing.
    const empty = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: ["11111111-1111-1111-1111-111111111111"], only_missing: false })
      .expect(200);
    expect(empty.body).toMatchObject({
      entities_considered: 0,
      entities_synthesized: 0,
      entities_skipped: 0,
    });
  });

  it("treats an empty entity_ids list as no filter, because Python's `if` is truthiness", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ entity_ids: [], only_missing: false })
      .expect(200);

    // Measured: `{"entity_ids":[]}` considers every entity.
    expect(response.body).toMatchObject({ entities_considered: 3 });
  });

  it("404s on an unknown Stack and 422s on a malformed id", async () => {
    const missing = await request(app)
      .post("/stacks/11111111-1111-1111-1111-111111111111/synthesize-descriptions")
      .send({})
      .expect(404);
    expect(missing.body).toEqual({
      detail: "Stack '11111111-1111-1111-1111-111111111111' not found",
    });

    // Path and body failures are reported together, path first (measured).
    const both = await request(app)
      .post("/stacks/nope/synthesize-descriptions")
      .send({ only_missing: null })
      .expect(422);
    expect((both.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "uuid_parsing",
        loc: ["path", "stack_id"],
        msg: "Input should be a valid UUID, invalid character: found `n` at 0",
        input: "nope",
        ctx: { error: "invalid character: found `n` at 0" },
      },
      {
        type: "bool_type",
        loc: ["body", "only_missing"],
        msg: "Input should be a valid boolean",
        input: null,
      },
    ]);

    // Nothing was written.
    expect(completeMock.calls).toHaveLength(0);
  });

  it("reports FastAPI's `missing` for a request with no body at all", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .expect(422);
    expect(response.body).toEqual({
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  });

  it("reports `missing` for an explicitly empty JSON body, not `{}`", async () => {
    const fixture = await createFixture();

    // body-parser's "empty json body" special case yields `{}`, which would
    // otherwise look like a valid `BackfillRequest`. FastAPI answers `missing`,
    // so `content-length: 0` is what separates the two.
    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .set("Content-Type", "application/json")
      .send("")
      .expect(422);
    expect(response.body).toEqual({
      detail: [{ type: "missing", loc: ["body"], msg: "Field required", input: null }],
    });
  });

  it("passes a non-JSON body through as the raw text, like Starlette", async () => {
    const fixture = await createFixture();

    // Measured: `text/plain` body `{}` -> `model_attributes_type` with
    // `input: "{}"` (the string), because no JSON parser claimed the body.
    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .set("Content-Type", "text/plain")
      .send("{}")
      .expect(422);
    expect(response.body).toEqual({
      detail: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: "{}",
        },
      ],
    });
    // Key order, not just key set: every 422 entry in this app emits
    // `type, loc, msg, input` and this hand-built one must not drift.
    const detail = (response.body as { detail: Record<string, unknown>[] }).detail;
    expect(Object.keys(detail[0] ?? {})).toEqual(["type", "loc", "msg", "input"]);
  });

  it("rejects a JSON body that is not an object", async () => {
    const fixture = await createFixture();

    for (const value of [null, 5, []]) {
      const response = await request(app)
        .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
        // `supertest` types `send` as a string, an object, or nothing; a bare
        // `null` / `5` / `[]` top-level JSON value is what FastAPI must reject.
        .set("Content-Type", "application/json")
        .send(JSON.stringify(value))
        .expect(422);
      expect(response.body, JSON.stringify(value)).toEqual({
        detail: [
          {
            type: "model_attributes_type",
            loc: ["body"],
            msg: "Input should be a valid dictionary or object to extract fields from",
            input: value,
          },
        ],
      });
    }
  });

  it("ignores unknown body keys, as Pydantic does by default", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .post(`/stacks/${fixture.stackId}/synthesize-descriptions`)
      .send({ bogus: 1, only_missing: false })
      .expect(200);
    expect(response.body).toMatchObject({ entities_considered: 3 });
  });

  it("requires a Stack reference on the single-entity endpoint", async () => {
    const response = await request(app)
      .post("/aks/v1/entities/Gateway/synthesize-description")
      .expect(422);
    expect(response.body).toEqual({
      detail: "Either stack_id (UUID) or domain (slug) must be provided",
    });
  });
});
