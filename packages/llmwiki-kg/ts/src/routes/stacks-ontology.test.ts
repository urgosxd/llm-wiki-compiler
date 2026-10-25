/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-ontology.test.ts
 * @description `POST`/`PATCH /stacks` persistence and exposure of a declared
 * ontology.
 *
 * The ontology column is an extension over the Python oracle, which has no
 * `ontology` on `StackCreate` or `StackUpdate`. The human chose to expose it on
 * the response as well, which is a deliberate departure from the oracle's nine
 * keys, so four properties matter and none are covered by the other Stack suites:
 *
 * 1. A declaration supplied on create or update is stored as a jsonb *object*,
 *    not a jsonb string. `valid_ontology_is_object` enforces this, and it is easy
 *    to get wrong by stringifying before binding.
 * 2. The response echoes the declaration back, so "was my config stored" is a
 *    question the API answers. `null` means unconfigured and is still emitted.
 * 3. A declaration that cannot be enforced is refused with a 422 at the point of
 *    writing, instead of being stored and then throwing on every later ingest.
 * 4. The response keeps the oracle's nine keys in their original order, with
 *    `ontology` appended last.
 *
 * `null` and absence are distinct on PATCH: `null` clears the declaration,
 * absence leaves it untouched. That distinction is what lets an unconfigured
 * Stack keep the oracle's permissive extraction behaviour.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";

import { RESPONSE_KEYS, buildApp, currentDomainPrefix, database, deleteFixtureRows, skipReason, useDomainPrefix } from "./stacks-harness.js";

useDomainPrefix("ontology");

/** A minimal, structurally valid declaration. */
const DECLARATION = {
  entityTypes: ["ORGANIZATION", "PERSON"],
  relationshipTypes: ["WORKS_AT"],
};

/** The stored form of {@link DECLARATION}: `subtypes` is always present. */
const STORED_DECLARATION = { ...DECLARATION, subtypes: [], relationships: [] };

describe.skipIf(skipReason !== false)("/stacks ontology (live database)", () => {
  let sequence = 0;

  /** Unique domain per call, carrying the cleanup prefix. */
  function uniqueDomain(label: string): string {
    sequence += 1;
    return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  beforeEach(deleteFixtureRows);

  /** Reads the stored column back as the database actually holds it. */
  async function storedOntology(id: string): Promise<unknown> {
    const rows = await database().execute<{ ontology: unknown }>(
      sql`select ontology from stacks where id = ${id}`,
    );
    return rows[0]?.ontology;
  }

  it("stores a declaration supplied on create as a jsonb object", async () => {
    const app = buildApp();
    const domain = uniqueDomain("create");

    const response = await request(app)
      .post("/stacks")
      .send({ name: "Ontology Stack", domain, ontology: DECLARATION })
      .expect(201);

    const stored = await storedOntology(String(response.body.id));
    // Compared against the STORED form: type names are normalised and `subtypes`
    // is always present, so create and ingest agree on what the column means.
    expect(stored).toEqual(STORED_DECLARATION);
    // A jsonb string would compare unequal above only after JSON.parse, so this
    // asserts the wire-level shape the check constraint cares about.
    expect(typeof stored).toBe("object");
    expect(Array.isArray(stored)).toBe(false);
  });

  it("echoes the declaration back and keeps the oracle's key order", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/stacks")
      .send({ name: "Keys Stack", domain: uniqueDomain("keys"), ontology: DECLARATION })
      .expect(201);

    expect(Object.keys(response.body)).toEqual([...RESPONSE_KEYS]);
    expect(response.body.ontology).toEqual(STORED_DECLARATION);

    // The oracle's nine keys keep their positions; the extension is last.
    expect(Object.keys(response.body).slice(0, 9)).toEqual([...RESPONSE_KEYS].slice(0, 9));
  });

  it("leaves the column NULL and reports null when no declaration is supplied", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/stacks")
      .send({ name: "Plain Stack", domain: uniqueDomain("plain") })
      .expect(201);

    expect(await storedOntology(String(response.body.id))).toBeNull();
    // The key is still emitted, so "unconfigured" is not "this server has no
    // such field".
    expect(response.body.ontology).toBeNull();
  });

  it("refuses a cyclic declaration with a 422 instead of storing it", async () => {
    const app = buildApp();
    const domain = uniqueDomain("cycle");

    const response = await request(app)
      .post("/stacks")
      .send({
        name: "Cyclic Stack",
        domain,
        ontology: {
          entityTypes: ["A", "B"],
          relationshipTypes: ["R"],
          subtypes: [
            { child: "A", parent: "B" },
            { child: "B", parent: "A" },
          ],
        },
      })
      .expect(422);

    expect(response.body.detail[0]).toMatchObject({
      type: "value_error",
      loc: ["body", "ontology"],
    });

    // Nothing was created: a refused Stack must not exist in the rejected state.
    const rows = await database().execute<{ n: number }>(
      sql`select count(*)::int as n from stacks where domain = ${domain}`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
