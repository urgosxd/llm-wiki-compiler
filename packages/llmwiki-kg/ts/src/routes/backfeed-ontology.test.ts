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
 * REFUSAL NOW HAPPENS AT BOTH ENDS. It used to happen only at approval, which
 * made `flag`'s `201 Created` a lie: the queue accepted an item that could never
 * be approved, and the caller learned their type was undeclared only after a human
 * had spent attention on it — from a different endpoint than the one that said the
 * proposal was fine. `flag` now refuses with the same 422, and the approval gate is
 * kept as defence in depth because the declaration can change between the two
 * calls and approval is the moment a write happens. Both are pinned below.
 *
 * A Stack with no declaration is enforced against the documented default, not
 * left total. `null` used to mean the oracle's behaviour, and that was reversed
 * together with ingest: the graph a Stack accumulates must have one vocabulary
 * whether or not the caller wrote one down. Both halves are pinned below — the
 * default admits `COMPANY`, and it refuses `ALIEN_CONSTRUCT`.
 *
 * What this gives up: an undeclared type can no longer be queued as a proposal.
 * The queue is a review surface for viable work, not an inbox for vocabulary
 * changes; proposing a new type means amending the Stack's declaration.
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

  /** Create a Stack, optionally with a declaration, returning its id. */
  async function createStack(ontology?: unknown): Promise<string> {
    stackDomain = uniqueDomain("case");
    const rows = await database().execute<{ id: string }>(sql`
      insert into stacks (name, domain, ontology)
      values (
        ${"Backfeed ontology fixture"}, ${stackDomain},
        ${ontology === undefined ? null : JSON.stringify(ontology)}::jsonb
      )
      returning id
    `);
    const row = rows[0];
    if (row === undefined) throw new Error("insert into stacks returned no row");
    return row.id;
  }

  /** Flags one item against the current Stack and returns its id. */
  async function flag(app: Express, proposal: Record<string, unknown>): Promise<string> {
    const response = await request(app)
      .post("/aks/v1/backfeed/flag")
      .send({ domain: stackDomain, proposal });
    expect(response.status).toBe(201);
    return String(asRecord(response.body)["id"]);
  }

  /**
   * Flags a proposal without asserting the status, for the cases where the
   * refusal IS the assertion.
   */
  async function flagRaw(app: Express, proposal: Record<string, unknown>) {
    return request(app).post("/aks/v1/backfeed/flag").send({ domain: stackDomain, proposal });
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

  it("refuses an undeclared entity type at flag, before it reaches the queue", async () => {
    // The asymmetry this closes: `flag` used to answer 201 for a type `approve`
    // would refuse, so a caller learned their proposal was impossible only after a
    // human had reviewed it. Now both endpoints refuse with the same 422.
    await createStack(DECLARATION);
    const app = buildApp();

    const response = await flagRaw(app, {
      entities: [{ name: "Vex", type: "ALIEN_CONSTRUCT" }],
    });

    expect(response.status).toBe(422);
    const detail = response.body.detail as Array<{ type: string; loc: string[]; msg: string }>;
    expect(detail[0]).toMatchObject({ type: "value_error", loc: ["body", "proposal"] });
    expect(detail[0]?.msg).toContain("ALIEN_CONSTRUCT");
  });

  it("writes nothing to the queue when flag refuses", async () => {
    // A refusal must not leave a row behind: the queue is a review surface for
    // viable work, not an inbox for vocabulary changes.
    await createStack(DECLARATION);
    const app = buildApp();

    await flagRaw(app, { entities: [{ name: "Vex", type: "ALIEN_CONSTRUCT" }] }).catch(
      () => undefined,
    );

    const rows = await database().execute<{ n: number }>(sql`
      select count(*)::int as n from backfeed_queue
      where stack_id in (select id from stacks where domain = ${stackDomain})
    `);
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses an undeclared relationship type at flag", async () => {
    await createStack(DECLARATION);
    const app = buildApp();

    const response = await flagRaw(app, {
      entities: [
        { name: "Acme", type: "COMPANY" },
        { name: "Ada", type: "PERSON" },
      ],
      relationships: [{ from_entity: "Acme", to_entity: "Ada", type: "ACQUIRES" }],
    });

    expect(response.status).toBe(422);
    expect((response.body.detail as Array<{ msg: string }>)[0]?.msg).toContain("ACQUIRES");
  });

  it("still refuses at approve, so a declaration changed after flagging is enforced", async () => {
    // Defence in depth, and the reason the approve gate was not deleted: the
    // declaration can change between flagging and approval, and approval is the
    // moment a write happens. Flagging while EMPLOYS is declared, then narrowing
    // the Stack, must not let the item through.
    const stackId = await createStack(DECLARATION);
    const app = buildApp();
    const id = await flag(app, {
      entities: [
        { name: "Acme", type: "COMPANY" },
        { name: "Ada", type: "PERSON" },
      ],
      relationships: [{ from_entity: "Acme", to_entity: "Ada", type: "EMPLOYS" }],
    });

    // Narrowed directly: this harness mounts only the backfeed router, and what
    // matters is that `approve` re-reads the column rather than trusting the state
    // that existed when the item was flagged.
    await database().execute(sql`
      update stacks
      set ontology = ${JSON.stringify({ entityTypes: ["COMPANY", "PERSON"], relationshipTypes: ["SUPPLIES"] })}::jsonb
      where id = ${stackId}
    `);

    const response = await approve(app, id);

    expect(response.status).toBe(422);
    expect((response.body.detail as Array<{ msg: string }>)[0]?.msg).toContain("EMPLOYS");
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

  it("admits the default vocabulary for a Stack with no declaration", async () => {
    // A Stack that never declared an ontology is still constrained: it admits the
    // documented default. This is the case that used to be total, and the reversal
    // is deliberate — an undeclared Stack accumulated whatever the model emitted,
    // so two Stacks could disagree forever about what a company is called.
    await createStack(undefined);
    const app = buildApp();
    const id = await flag(app, { entities: [{ name: "Acme", type: "COMPANY" }] });

    const response = await approve(app, id);

    expect(response.status).toBe(200);
    expect(await entityTypes()).toEqual(["COMPANY"]);
  });

  it("refuses a type outside the default at flag, for a Stack with no declaration", async () => {
    // The other half of the same contract: the default is a real allowlist, not a
    // suggestion. Without this test the previous one would also pass if the gate
    // had silently gone back to being total.
    await createStack(undefined);
    const app = buildApp();

    const response = await flagRaw(app, {
      entities: [{ name: "Vex", type: "ALIEN_CONSTRUCT" }],
    });

    expect(response.status).toBe(422);
    expect(asRecord(response.body)).toMatchObject({
      detail: [
        expect.objectContaining({
          loc: ["body", "proposal"],
          msg: expect.stringContaining("ALIEN_CONSTRUCT") as string,
        }),
      ],
    });
  });
});
