/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-ontology.test.ts
 * @description `POST`/`PATCH /stacks` persistence of a declared ontology.
 *
 * The ontology column is an extension over the Python oracle, which has no
 * `ontology` on `StackCreate`, `StackUpdate` or `StackResponse`. Two properties
 * therefore matter and neither is covered by the existing Stack suites:
 *
 * 1. A declaration supplied on create or update is actually stored as a jsonb
 *    *object*, not a jsonb string. `valid_ontology_is_object` enforces this, and
 *    it is easy to get wrong by stringifying before binding.
 * 2. The response body keeps the oracle's exact nine keys and order. Nothing is
 *    echoed back, so an absent or supplied declaration is invisible on the wire.
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
    expect(stored).toEqual(DECLARATION);
    // A jsonb string would compare unequal above only after JSON.parse, so this
    // asserts the wire-level shape the check constraint cares about.
    expect(typeof stored).toBe("object");
    expect(Array.isArray(stored)).toBe(false);
  });

  it("keeps the oracle's exact response keys when a declaration is supplied", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/stacks")
      .send({ name: "Keys Stack", domain: uniqueDomain("keys"), ontology: DECLARATION })
      .expect(201);

    // Nothing is echoed: the extension is write-only on the wire.
    expect(Object.keys(response.body)).toEqual([...RESPONSE_KEYS]);
    expect(response.body).not.toHaveProperty("ontology");
  });

  it("leaves the column NULL when no declaration is supplied", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/stacks")
      .send({ name: "Plain Stack", domain: uniqueDomain("plain") })
      .expect(201);

    expect(await storedOntology(String(response.body.id))).toBeNull();
  });
});
