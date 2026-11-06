/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/export-conformance.test.ts
 * @description Validates the exported bundle against the vendored AKS schema.
 *
 * This is S45.14 done with a REAL validator rather than a hand-written structural
 * check: `ajv` is already a runtime dependency of this repository and the vendored
 * specification is draft 2020-12, so `ajv/dist/2020.js` compiles
 * `oracle/aks-specification-v0.1.0/SCHEMA.json` directly. No schema is restated here.
 *
 * Two deviations from the vendored schema are known and pre-existing, and neither is
 * this task's to change:
 *
 * 1. `aks_version` — the vendored schema pins `const: "0.1.0"` and this service emits
 *    `"0.2.0"` (the feature document's L4 decision). Changing a public version string
 *    is a contract break nobody asked for.
 * 2. `documents[].audit` — the schema types it as an object with no `null` form, while
 *    a document that was never audited stores SQL NULL.
 *
 * The first test therefore asserts what this task must guarantee: no entity and no
 * relationship object violates the schema, and every reported violation belongs to the
 * documented set. The second removes both documented deviations from the same data and
 * requires a completely clean validation.
 */

import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv/dist/2020.js";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CLASSIFICATION_PROPERTY_KEY } from "../../core/graph_read.js";
import { RELATIONSHIP_KEYS } from "../aks-harness.js";
import {
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  state,
  useDomainPrefix,
} from "../aks-harness.js";
import type { Fixture } from "../aks-harness.js";
import { withFixtureTenant } from "../fixture-tenant.js";

useDomainPrefix("export-conformance");

/** The vendored specification, resolved next to this file rather than from the cwd. */
const SCHEMA_URL = new URL("../../../oracle/aks-specification-v0.1.0/SCHEMA.json", import.meta.url);

/** A document audit the schema accepts, so the audit deviation can be excluded. */
const VALID_AUDIT = {
  duplicate_score: 0,
  staleness_score: 0,
  quality_classification: "healthy",
  contradiction_count: 0,
  contradiction_flags: [],
  passed: true,
  recommendation: "proceed",
};

/** One exported entity, as much of it as these tests read. */
interface WireEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

describe.skipIf(state.skipReason !== false)("aks export schema conformance", () => {
  let app: Express;
  let schema: AnySchemaObject;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
    schema = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as AnySchemaObject;
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  /** Keys `AKSEntity` permits, read from the vendored schema rather than restated. */
  function entityKeys(): readonly string[] {
    const defs = schema["$defs"] as Record<string, { properties: Record<string, unknown> }>;
    return Object.keys(defs["AKSEntity"]?.properties ?? {});
  }

  /** Seeds one Stack holding a classified entity, a free entity and a free relation. */
  async function seedProjectedStack(): Promise<Fixture> {
    const fixture = await createFixture();
    await withFixtureTenant(database(), { stackId: fixture.stackId }, async (tx) => {
      await tx.execute(sql`
        update ontology_entities
        set classification_state = 'free_no_match', proposed_type = 'TECHNOLOGY',
            support_state = 'uncertain'
        where id = ${fixture.entityIds.model}
      `);
      await tx.execute(sql`
        update ontology_entities
        set classification_state = 'classified', canonical_type = 'System',
            proposed_type = 'SYSTEM', support_state = 'supported'
        where id = ${fixture.entityIds.gateway}
      `);
      await tx.execute(sql`
        update ontology_relationships
        set predicate = 'deja sin efecto', classification_state = 'free_no_match'
        where id = ${fixture.relationshipIds.uses}
      `);
    });
    return fixture;
  }

  /** Reads the bundle for one fixture Stack. */
  async function readBundle(fixture: Fixture): Promise<Record<string, unknown> & { aks_version: string }> {
    const response = await request(app).get(`/aks/v1/export?domain=${fixture.domain}`).expect(200);
    return response.body as Record<string, unknown> & { aks_version: string };
  }

  /** Compiles the vendored schema, optionally relaxing the version pin. */
  function compile(aksVersion?: string) {
    const copy = structuredClone(schema) as AnySchemaObject;
    if (aksVersion !== undefined) {
      const properties = copy["properties"] as Record<string, Record<string, unknown>>;
      const version = properties["aks_version"] as Record<string, unknown>;
      version["const"] = aksVersion;
    }
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      logger: false,
      validateFormats: false,
    });
    return ajv.compile(copy);
  }

  it("reports no schema violation for any entity or relationship", async () => {
    const bundle = await readBundle(await seedProjectedStack());
    const validate = compile();

    expect(validate(bundle)).toBe(false);
    const paths = (validate.errors ?? []).map((error) => error.instancePath);
    for (const path of paths) {
      // The documented set only: the pinned version and a null document audit.
      expect(path === "/aks_version" || /^\/documents\/\d+\/audit$/.test(path)).toBe(true);
    }
    expect(paths.some((path) => path.startsWith("/entities"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/relationships"))).toBe(false);
  });

  it("validates completely once the documented deviations are excluded", async () => {
    const fixture = await seedProjectedStack();
    await withFixtureTenant(database(), { stackId: fixture.stackId }, async (tx) => {
      await tx.execute(sql`
        update stack_documents set audit = ${JSON.stringify(VALID_AUDIT)}::jsonb
        where id = ${fixture.documentId}
      `);
    });

    const bundle = await readBundle(fixture);
    const validate = compile(bundle.aks_version);

    expect(bundle.aks_version).toBe("0.2.0");
    expect(validate(bundle)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("adds nothing to an entity beyond the read path's classification key", async () => {
    const bundle = await readBundle(await seedProjectedStack());
    const entities = bundle["entities"] as WireEntity[];
    const allowed = entityKeys();

    expect(entities).toHaveLength(3);
    for (const entity of entities) {
      for (const key of Object.keys(entity)) {
        expect(allowed).toContain(key);
      }
      // One stored property exists in the fixture (`tier` on `Gateway`), and only the
      // two entities with a recorded decision carry the reserved classification key.
      const expected =
        entity.name === "Gateway"
          ? ["tier", CLASSIFICATION_PROPERTY_KEY]
          : entity.name === "Embedding Model"
            ? [CLASSIFICATION_PROPERTY_KEY]
            : [];
      expect(Object.keys(entity.properties).sort()).toEqual([...expected].sort());
    }
  });

  it("carries no relationship key outside the set AKSRelationship allows", async () => {
    const bundle = await readBundle(await seedProjectedStack());
    const relationships = bundle["relationships"] as Array<Record<string, unknown>>;

    expect(relationships).toHaveLength(2);
    for (const relationship of relationships) {
      expect(Object.keys(relationship).sort()).toEqual([...RELATIONSHIP_KEYS].sort());
      expect(relationship).not.toHaveProperty("properties");
      expect(String(relationship["type"]).length).toBeGreaterThan(0);
    }
  });

  it("keeps the documented export order for entities and relationships", async () => {
    const bundle = await readBundle(await seedProjectedStack());
    const entities = bundle["entities"] as Array<{ name: string; id: string }>;
    const relationships = bundle["relationships"] as Array<{
      type: string;
      from_entity_id: string;
      to_entity_id: string;
    }>;

    expect(entities).toEqual(
      [...entities].sort((left, right) =>
        left.name === right.name
          ? left.id.localeCompare(right.id)
          : left.name.localeCompare(right.name),
      ),
    );
    const tuple = (row: (typeof relationships)[number]): string =>
      `${row.type}\u0000${row.from_entity_id}\u0000${row.to_entity_id}`;
    expect(relationships.map(tuple)).toEqual([...relationships].map(tuple).sort());
  });
});
