/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-pages.test.ts
 * @description The page endpoints with the LLM stubbed.
 */

import { describe, expect, it, beforeEach, afterAll , vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { ENTITY_PAGE_KEYS, createFixture, createTestApp, database, deleteFixtureRows, readZipArchive, state, useDomainPrefix } from "./pages-harness.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * Issues a GET and buffers the raw body, for the ZIP endpoints.
 *
 * supertest parses JSON by default; a ZIP needs the bytes, so the parser is
 * replaced with one that concatenates chunks.
 */
function requestBinary(app: Express, path: string): request.Test {
  return request(app)
    .get(`/${path}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
}

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
useDomainPrefix("pages");

describe.skipIf(state.skipReason !== false)("pages endpoints (LLM stubbed)", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    completeMock.enabled = true;
    completeMock.calls.length = 0;
    // A recognizable marker so the assertions can prove the stored markdown is
    // whatever the model returned, unmodified.
    completeMock.reply = "# Stub\n\nStub summary.\n\n## Relationships\n\n**Outgoing**\n- x\n";
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("generates a page on the first read and serves it from cache on the second", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    // Key order comes from the DTO, so it is asserted exactly, not as a set.
    expect(Object.keys(first.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
    expect(first.body).toMatchObject({
      entity_name: "Billing Service",
      markdown: completeMock.reply,
      source_entity_id: fixture.entityIds.billing,
      source_type: "compiled",
      cached: false,
    });
    // Six fractional digits and a `Z`, like every other timestamptz here.
    expect(String((first.body as { generated_at: string }).generated_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    expect(String((first.body as { graph_version: string }).graph_version)).toMatch(/^[0-9a-f]{16}$/);

    expect(completeMock.calls).toHaveLength(1);
    // `complete(prompt, max_tokens=2048)` — the page budget, not the module
    // default of 1024.
    expect(completeMock.calls[0]?.maxTokens).toBe(2048);

    const second = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect(Object.keys(second.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
    expect((second.body as { cached: boolean }).cached).toBe(true);
    // Same hash, same text: the cache hit is not a regeneration.
    expect((second.body as { graph_version: string }).graph_version).toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect((second.body as { markdown: string }).markdown).toBe(completeMock.reply);
    expect((second.body as { generated_at: string }).generated_at).toBe(
      (first.body as { generated_at: string }).generated_at,
    );
    // The decisive assertion: no second model call.
    expect(completeMock.calls).toHaveLength(1);
  });

  it("finds an entity by case-insensitive exact name and 404s on anything else", async () => {
    const fixture = await createFixture();

    const lower = await request(app)
      .get(`/aks/v1/pages/billing%20service?stack_id=${fixture.stackId}`)
      .expect(200);
    expect((lower.body as { entity_name: string }).entity_name).toBe("Billing Service");

    // Equality on the whole name, not a prefix: the 404 echoes the request.
    const partial = await request(app)
      .get(`/aks/v1/pages/Billing?domain=${fixture.domain}`)
      .expect(404);
    expect(partial.body).toEqual({ detail: "Entity 'Billing' not found in Stack" });
  });

  it("regenerates when the entity's own data changes", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    await database().execute(sql`
      update ontology_entities
      set description = ${"Now with a richer description"}
      where id = ${fixture.entityIds.billing}
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("regenerates when a new relationship is written", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);
    expect(completeMock.calls).toHaveLength(1);

    await database().execute(sql`
      insert into ontology_relationships (
        id, stack_id, from_entity_id, to_entity_id, type, description,
        confidence, verified, extracted_by_model, source_kind, pipeline
      )
      values (
        ${randomUUID()}, ${fixture.stackId}, ${fixture.entityIds.gateway},
        ${fixture.entityIds.limit}, ${"RESPECTS"}, ${null}, ${0.65}, ${false},
        ${"model-b"}, ${"document"}, ${"llamaindex-schema-extraction"}
      )
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("regenerates when a contributing document is attached", async () => {
    const fixture = await createFixture();

    const first = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    await database().execute(sql`
      insert into entity_source_documents (entity_id, document_id, stack_id)
      values (${fixture.entityIds.gateway}, ${fixture.documentId}, ${fixture.stackId})
    `);

    const second = await request(app)
      .get(`/aks/v1/pages/Payment%20Gateway?domain=${fixture.domain}`)
      .expect(200);

    // The entity row itself did not change; only its contributing-document set
    // did, which the hash covers separately.
    expect((second.body as { cached: boolean }).cached).toBe(false);
    expect((second.body as { graph_version: string }).graph_version).not.toBe(
      (first.body as { graph_version: string }).graph_version,
    );
    expect(completeMock.calls).toHaveLength(2);
  });

  it("writes the page to entity_pages, upserting on repeat generation", async () => {
    const fixture = await createFixture();

    await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    const rows = await database().execute<{
      entity_name: string;
      graph_version: string;
      source_type: string;
      generated_by_model: string | null;
    }>(sql`
      select entity_name, graph_version, source_type, generated_by_model
      from entity_pages
      where entity_id = ${fixture.entityIds.billing}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_name).toBe("Billing Service");
    expect(rows[0]?.source_type).toBe("compiled");
    expect(rows[0]?.generated_by_model).toBe("hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");

    // A forced regeneration must replace the row, not add one: the table's
    // primary key is `entity_id`.
    await database().execute(sql`
      update ontology_entities set confidence = ${0.91} where id = ${fixture.entityIds.billing}
    `);
    await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    const after = await database().execute<{ count: string }>(sql`
      select count(*) as count from entity_pages where entity_id = ${fixture.entityIds.billing}
    `);
    expect(Number(after[0]?.count)).toBe(1);
  });

  it("answers a ZIP archive with the oracle's headers and file list", async () => {
    const fixture = await createFixture();

    const response = await requestBinary(app, `aks/v1/pages?domain=${fixture.domain}`);

    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename=${fixture.domain}-entity-pages.zip`,
    );
    // The oracle streams its in-memory buffer, so it chunks rather than sending a
    // length. `res.end(buffer)` would set `content-length`; `write` + `end` does
    // not. Asserted because it is observable and was wrong before being measured.
    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(response.headers["content-length"]).toBeUndefined();

    const archive = response.body as Buffer;
    const entries = readZipArchive(archive);

    // README first, then `order by name`.
    expect(entries.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
      "Rate_Limit.md",
    ]);

    const readme = entries[0]?.content ?? "";
    expect(readme.startsWith(`# ${fixture.stackName} — Entity Pages\n\n`)).toBe(true);
    expect(readme).toContain(`Generated from AKS Stack \`${fixture.domain}\` on `);
    expect(readme).toContain("+00:00.\n\n");
    expect(readme).toContain("Total entities: 3\n\n");
    expect(readme).toContain(
      "Each `.md` file is a wiki-style page for one entity, generated from the compiled knowledge graph.\n",
    );

    // Three entities, no pages cached yet: three model calls, and the stored
    // markdown reaches the archive verbatim.
    expect(completeMock.calls).toHaveLength(3);
    expect(entries[1]?.content).toBe(completeMock.reply);
  });

  it("reuses cached pages when building a second archive", async () => {
    const fixture = await createFixture();

    await request(app).get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`).expect(200);
    expect(completeMock.calls).toHaveLength(1);

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    // Three entities, one already cached: exactly two more model calls.
    expect(completeMock.calls).toHaveLength(3);
    expect(readZipArchive(response.body as Buffer)).toHaveLength(4);
  });

  it("honours min_confidence, dropping entities below the bound", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}&min_confidence=0.5`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    // Rate Limit sits at 0.4, so it is excluded — and its page is never
    // generated, so it costs no model call.
    expect(readZipArchive(response.body as Buffer).map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
    ]);
    expect(completeMock.calls).toHaveLength(2);
  });

  it("404s on an archive request when no entity meets the filter", async () => {
    const fixture = await createFixture();

    const response = await request(app)
      .get(`/aks/v1/pages?domain=${fixture.domain}&min_confidence=1`)
      .expect(404);
    expect(response.body).toEqual({
      detail: "Stack has no entities meeting the filter criteria",
    });
    expect(completeMock.calls).toHaveLength(0);
  });

  it("rejects malformed query parameters before resolving the Stack", async () => {
    // Measured: FastAPI reports both failing parameters together, in declaration
    // order, so a bad `stack_id` does not mask a bad `min_confidence`.
    const response = await request(app)
      .get("/aks/v1/pages?stack_id=nope&min_confidence=2")
      .expect(422);

    expect((response.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "uuid_parsing",
        loc: ["query", "stack_id"],
        msg: "Input should be a valid UUID, invalid character: found `n` at 0",
        input: "nope",
        ctx: { error: "invalid character: found `n` at 0" },
      },
      {
        type: "less_than_equal",
        loc: ["query", "min_confidence"],
        msg: "Input should be less than or equal to 1",
        input: "2",
        // Known divergence: Python emits `1.0`, JavaScript cannot distinguish
        // the two (see `odd/findings/float-bound-json-limit.md`).
        ctx: { le: 1 },
      },
    ]);
  });

  it("treats an empty min_confidence as the parser failure Python reports", async () => {
    const response = await request(app).get("/aks/v1/pages?min_confidence=").expect(422);
    expect((response.body as { detail: unknown[] }).detail).toEqual([
      {
        type: "float_parsing",
        loc: ["query", "min_confidence"],
        msg: "Input should be a valid number, unable to parse string as a number",
        input: "",
      },
    ]);
  });

  it("requires a Stack reference on both endpoints", async () => {
    for (const path of ["/aks/v1/pages", "/aks/v1/pages/Gateway"]) {
      const response = await request(app).get(path).expect(422);
      expect(response.body, path).toEqual({
        detail: "Either stack_id (UUID) or domain (slug) must be provided",
      });
    }
  });
});
