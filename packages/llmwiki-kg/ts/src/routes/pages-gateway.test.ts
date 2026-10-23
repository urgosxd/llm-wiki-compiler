/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-gateway.test.ts
 * @description The live-gateway page and synthesis calls.
 */

import { describe, expect, it, beforeEach, afterAll , vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { ENTITY_PAGE_KEYS, SYNTHESIZE_ONE_KEYS, createFixture, createTestApp, database, deleteFixtureRows, readZipArchive, state, useDomainPrefix } from "./pages-harness.js";
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
useDomainPrefix("gateway");

/**
 * Enabled only with `AKS_TEST_GATEWAY=1`, like `aks.test.ts`.
 *
 * **Three model calls**, the minimum that exercises all four endpoints' LLM
 * paths: one page generation, one un-cached page inside the ZIP, and one
 * single-entity synthesis. The cache assertion between the two page reads is what
 * proves the cache without a fourth call.
 *
 * Only structure is asserted. Measured on the oracle: three identical runs
 * returned five, three and four entities, and the page text differs every time —
 * so any assertion on the text or on an entity count would flake.
 */
describe.skipIf(state.skipReason !== false || process.env["AKS_TEST_GATEWAY"] !== "1")(
  "pages and synthesis (live gateway)",
  () => {
    let app: Express;

    beforeEach(async () => {
      await deleteFixtureRows();
      // Turn the stub off: this block is the only one that reaches a provider.
      completeMock.enabled = false;
      completeMock.calls.length = 0;
      app = createTestApp();
    });

    afterAll(async () => {
      completeMock.enabled = true;
      await deleteFixtureRows();
    });

    it("generates a real page, caches it, and archives it", async () => {
      const fixture = await createFixture();

      const first = await request(app)
        .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
        .expect(200);

      expect(Object.keys(first.body as object)).toEqual([...ENTITY_PAGE_KEYS]);
      const body = first.body as {
        entity_name: string;
        markdown: string;
        generated_at: string;
        source_entity_id: string;
        graph_version: string;
        source_type: string;
        cached: boolean;
      };

      expect(body.entity_name).toBe("Billing Service");
      expect(body.source_entity_id).toBe(fixture.entityIds.billing);
      expect(body.source_type).toBe("compiled");
      expect(body.cached).toBe(false);
      expect(body.graph_version).toMatch(/^[0-9a-f]{16}$/);
      expect(body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

      // Structure only. The model is told to start with `# <name>` and to use
      // the two section headings, but it is free prose after that; asserting the
      // headings is asserting the prompt's contract, which is stable, while the
      // prose is not.
      expect(body.markdown.trimStart().startsWith("# Billing Service")).toBe(true);

      const second = await request(app)
        .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
        .expect(200);
      expect((second.body as { cached: boolean }).cached).toBe(true);
      expect((second.body as { markdown: string }).markdown).toBe(body.markdown);

      const archive = await request(app)
        .get(`/aks/v1/pages?domain=${fixture.domain}`)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(archive.headers["content-type"]).toBe("application/zip");
      const entries = readZipArchive(archive.body as Buffer);
      expect(entries.map((entry) => entry.name)).toEqual([
        "README.md",
        "Billing_Service.md",
        "Payment_Gateway.md",
        "Rate_Limit.md",
      ]);
      expect(entries[0]?.content).toContain(`Total entities: 3`);
    }, 240_000);

    it("synthesizes a real description and writes it back", async () => {
      const fixture = await createFixture();

      const response = await request(app)
        .post(`/aks/v1/entities/Billing%20Service/synthesize-description?domain=${fixture.domain}`)
        .expect(200);

      expect(Object.keys(response.body as object)).toEqual([...SYNTHESIZE_ONE_KEYS]);
      const body = response.body as {
        entity_name: string;
        description: string | null;
        synthesized: boolean;
      };
      expect(body.entity_name).toBe("Billing Service");
      expect(body.synthesized).toBe(true);
      // Non-empty, and that is all: the text is model output.
      expect(typeof body.description).toBe("string");
      expect((body.description ?? "").length).toBeGreaterThan(0);

      const rows = await database().execute<{ description: string | null }>(sql`
        select description from ontology_entities where id = ${fixture.entityIds.billing}
      `);
      expect(rows[0]?.description).toBe(body.description);
    }, 240_000);
  },
);
