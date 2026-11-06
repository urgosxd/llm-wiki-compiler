/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-classification.test.ts
 * @description A generated page and a synthesized description state the entity's
 * classification status, so uncertain knowledge is never presented as confirmed.
 *
 * Covers S42 on the page surfaces: the page body carries a classification notice
 * for an entity that is not confirmed classified, the synthesis prompt says the
 * same thing to the model, and the page route resolves a homonym to the same row
 * the entity endpoint resolves instead of an arbitrary one.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFixture, createTestApp, database, deleteFixtureRows, state, useDomainPrefix } from "./pages-harness.js";
import { buildSynthesisPrompt } from "./synthesize.js";

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

/** The one markdown body every stubbed completion returns. */
const STUB_MARKDOWN = "# Stub\n\nStub summary.\n";

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    complete: async (): Promise<string> => STUB_MARKDOWN,
  };
});

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("pgclass");

/** Marks one entity with a classification decision. */
async function decide(
  entityId: string,
  decision: { state: string; canonical: string | null },
): Promise<void> {
  await database().execute(sql`
    update ontology_entities
    set classification_state = ${decision.state}, canonical_type = ${decision.canonical}
    where id = ${entityId}
  `);
}

/** Inserts one homonym with an explicit identity key and description. */
async function seedTwin(
  stackId: string,
  twin: { name: string; state: string; canonical: string | null; description: string; identityKey: string },
): Promise<string> {
  const id = randomUUID();
  await database().execute(sql`
    insert into ontology_entities (
      id, stack_id, name, type, confidence, description,
      identity_key, proposed_type, classification_state, canonical_type
    )
    values (
      ${id}, ${stackId}, ${twin.name}, ${"SYSTEM"}, ${0.9}, ${twin.description},
      ${twin.identityKey}, ${"SYSTEM"}, ${twin.state}, ${twin.canonical}
    )
  `);
  return id;
}

describe("the synthesis prompt states the classification status", () => {
  const names = ["Billing Service", "Payment Gateway"];
  const chunks = "Billing processes invoices.";

  it("is byte-identical to the pinned prompt when no decision was recorded", () => {
    const withNothing = buildSynthesisPrompt("Billing", "SYSTEM", names, chunks);
    const withNullState = buildSynthesisPrompt("Billing", "SYSTEM", names, chunks, null);
    expect(withNullState).toBe(withNothing);
    expect(withNullState).not.toContain("CLASSIFICATION:");
  });

  it("tells the model the label is a proposal when the entity is free", () => {
    const prompt = buildSynthesisPrompt("Billing", "SYSTEM", names, chunks, {
      state: "free_no_match",
      canonicalType: null,
      proposedType: "SYSTEM",
    });

    expect(prompt).toContain(
      'CLASSIFICATION: unclassified (free_no_match) — "SYSTEM" is the extractor\'s ' +
        "proposal; no canonical type in this Stack's catalog matched it. Do not present " +
        "it as a settled type.",
    );
    // The prompt's existing body is unchanged around the added line.
    expect(prompt).toContain("ENTITY: Billing\nTYPE: SYSTEM\n");
    expect(prompt.endsWith("Return ONLY the description as plain prose.")).toBe(true);
  });
});

describe.skipIf(state.skipReason !== false)("page surfaces over classified and free entities", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  it("marks a page built for a free entity as unclassified", async () => {
    const fixture = await createFixture();
    await decide(fixture.entityIds.billing, { state: "free_no_match", canonical: null });

    const response = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect((response.body as { markdown: string }).markdown).toBe(
      '> **Classification: unclassified (free_no_match).** The label "SYSTEM" is the ' +
        "extractor's proposal; no canonical type in this Stack's catalog matched it. " +
        "Read this page as source-backed but unclassified, not as a settled type.\n\n" +
        STUB_MARKDOWN,
    );
  });

  it("leaves the markdown of a classified page untouched", async () => {
    const fixture = await createFixture();
    await decide(fixture.entityIds.billing, { state: "classified", canonical: "SYSTEM" });

    const response = await request(app)
      .get(`/aks/v1/pages/Billing%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect((response.body as { markdown: string }).markdown).toBe(STUB_MARKDOWN);
  });

  it("serves the page of the classified homonym, not the first row found", async () => {
    const fixture = await createFixture();
    // The free twin is inserted first, so an unstated order would serve its page.
    await seedTwin(fixture.stackId, {
      name: "Twin Service",
      state: "free_no_match",
      canonical: null,
      description: "free twin",
      identityKey: "twin service#free",
    });
    const classified = await seedTwin(fixture.stackId, {
      name: "Twin Service",
      state: "classified",
      canonical: "SYSTEM",
      description: "classified twin",
      identityKey: "twin service#classified",
    });

    const response = await request(app)
      .get(`/aks/v1/pages/Twin%20Service?domain=${fixture.domain}`)
      .expect(200);

    expect((response.body as { source_entity_id: string }).source_entity_id).toBe(classified);
  });

  it("synthesizes the description of the classified homonym", async () => {
    const fixture = await createFixture();
    await seedTwin(fixture.stackId, {
      name: "Twin Service",
      state: "free_no_match",
      canonical: null,
      description: "free twin description",
      identityKey: "twin service#free",
    });
    const classified = await seedTwin(fixture.stackId, {
      name: "Twin Service",
      state: "classified",
      canonical: "SYSTEM",
      description: "classified twin description",
      identityKey: "twin service#classified",
    });

    const response = await request(app)
      .post(`/aks/v1/entities/Twin%20Service/synthesize-description?domain=${fixture.domain}`)
      .expect(200);

    // No chunk grounds the name, so nothing is written and the row that was picked
    // is visible in the description it already carried.
    expect(response.body).toEqual({
      entity_name: "Twin Service",
      description: "classified twin description",
      synthesized: false,
    });
    const rows = await database().execute<{ id: string; description: string | null }>(sql`
      select id, description from ontology_entities
      where stack_id = ${fixture.stackId} and name = 'Twin Service'
      order by identity_key
    `);
    expect(rows.map((row) => row.description)).toEqual([
      "classified twin description",
      "free twin description",
    ]);
    expect(rows.some((row) => row.id === classified && row.description?.startsWith("classified"))).toBe(
      true,
    );
  });
});
