/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed-ontology.test.ts
 * @description `POST /approve` refuses a proposal the Stack's ontology forbids.
 *
 * WHY THIS FILE EXISTS. Approval used to be the one path into the graph that
 * ignored the declaration: `consolidateBackfeedProposal` wrote whatever types the
 * proposal named. That made the ontology a promise about extraction only, not
 * about the Stack's graph — a human could approve an item naming `ALIEN` and it
 * landed next to the types the caller had declared, with no warning anywhere.
 *
 * The decision taken was to refuse, not to filter. A partial approval is worse
 * than a rejection: a human approves three entities, two are written, and the
 * response says `entities_absorbed: 2` — which reads as success, not as "one of
 * your items was silently dropped". Refusing keeps the invariant that anything in
 * the graph was declared, and puts the correction where the human can act on it.
 *
 * A Stack with no declaration is unaffected: `null` means the oracle's behaviour,
 * exactly as it does for ingest, so approval stays total for every Stack that
 * never opted in.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";

import {
  asRecord,
  buildApp,
  currentDomainPrefix,
  database,
  deleteFixtureRows,
  skipReason,
  useDomainPrefix,
} from "./backfeed-harness.js";

useDomainPrefix("ontology");

/** The declaration the gated Stack carries. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

describe.skipIf(skipReason !== false)("backfeed approve respects the Stack ontology", () => {
  let sequence = 0;
  let stackDomain = "";

  /** Unique domain per call, carrying the cleanup prefix. */
  function uniqueDomain(label: string): string {
    sequence += 1;
    return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  /** Create a Stack, optionally with a declaration, returning its domain. */
  async function createStack(ontology?: unknown): Promise<void> {
    stackDomain = uniqueDomain("case");
    await database().execute(sql`
      insert into stacks (name, domain, ontology)
      values (
        ${"Backfeed ontology fixture"}, ${stackDomain},
        ${ontology === undefined ? null : JSON.stringify(ontology)}::jsonb
      )
    `);
  }

  /** Flags one item against the current Stack and returns its id. */
  async function flag(app: Express, proposal: Record<string, unknown>): Promise<string> {
    const response = await request(app)
      .post("/aks/v1/backfeed/flag")
      .send({ domain: stackDomain, proposal });
    expect(response.status).toBe(201);
    return String(asRecord(response.body)["id"]);
  }

  /** Approves one item, returning the response. */
  async function approve(app: Express, itemId: string) {
    return request(app)
      .post("/aks/v1/backfeed/approve")
      .send({ item_id: itemId, reviewed_by: "alice" });
  }

  /** How many entity rows this Stack has, and of which types. */
  async function entityTypes(): Promise<string[]> {
    const rows = await database().execute<{ type: string }>(sql`
      select distinct type from ontology_entities
      where stack_id in (select id from stacks where domain = ${stackDomain})
      order by type
    `);
    return rows.map((row) => row.type);
  }

  beforeEach(async () => {
    await deleteFixtureRows();
  });

  it("refuses an entity type the Stack never declared", async () => {
    await createStack(DECLARATION);
    const app = buildApp();
    const id = await flag(app, { entities: [{ name: "Vex", type: "ALIEN_CONSTRUCT" }] });

    const response = await approve(app, id);

    expect(response.status).toBe(422);
    const detail = response.body.detail as Array<{ type: string; loc: string[]; msg: string }>;
    expect(detail[0]).toMatchObject({ type: "value_error", loc: ["body", "proposal"] });
    expect(detail[0]?.msg).toContain("ALIEN_CONSTRUCT");

    // Nothing was written, and the item stays pending so a human can fix the
    // ontology or reject it — the refusal must not consume the item.
    expect(await entityTypes()).toEqual([]);
    const stored = await request(app).get(`/aks/v1/backfeed/${id}`);
    expect(asRecord(stored.body)["status"]).toBe("pending");
  });

  it("refuses a relationship type the Stack never declared", async () => {
    await createStack(DECLARATION);
    const app = buildApp();
    const id = await flag(app, {
      entities: [
        { name: "Acme", type: "COMPANY" },
        { name: "Ada", type: "PERSON" },
      ],
      relationships: [{ from_entity: "Acme", to_entity: "Ada", type: "ACQUIRES" }],
    });

    const response = await approve(app, id);

    expect(response.status).toBe(422);
    expect((response.body.detail as Array<{ msg: string }>)[0]?.msg).toContain("ACQUIRES");
    expect(await entityTypes()).toEqual([]);
  });

  it("absorbs a proposal that stays inside the declaration", async () => {
    await createStack(DECLARATION);
    const app = buildApp();
    const id = await flag(app, {
      entities: [
        { name: "Acme", type: "COMPANY" },
        { name: "Ada", type: "PERSON" },
      ],
      relationships: [{ from_entity: "Acme", to_entity: "Ada", type: "EMPLOYS" }],
    });

    const response = await approve(app, id);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      entities_absorbed: 2,
      relationships_absorbed: 1,
      status: "approved",
    });
    expect(await entityTypes()).toEqual(["COMPANY", "PERSON"]);
  });

  it("matches type names case-insensitively, as ingest does", async () => {
    // A proposal written as prose must be admitted when the declaration means the
    // same thing; the gate normalises exactly like the extraction path.
    await createStack(DECLARATION);
    const app = buildApp();
    const id = await flag(app, { entities: [{ name: "Acme", type: "company" }] });

    const response = await approve(app, id);

    expect(response.status).toBe(200);
    expect(await entityTypes()).toEqual(["company"]);
  });

  it("stays total for a Stack with no declaration", async () => {
    await createStack(undefined);
    const app = buildApp();
    const id = await flag(app, { entities: [{ name: "Vex", type: "ALIEN_CONSTRUCT" }] });

    const response = await approve(app, id);

    expect(response.status).toBe(200);
    expect(await entityTypes()).toEqual(["ALIEN_CONSTRUCT"]);
  });
});
