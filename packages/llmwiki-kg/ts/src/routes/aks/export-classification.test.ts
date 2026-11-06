/**
 * @file packages/llmwiki-kg/ts/src/routes/aks/export-classification.test.ts
 * @description The AKS projection of classified and free entities and relations.
 *
 * Covers T11's behavioural rules (S37-S40): a classified item exports its canonical
 * type while a free one keeps what the extractor proposed, a free relation keeps its
 * original predicate verbatim on the wire, the emitted `confidence` follows the one
 * documented formula rather than any raw JEV number, and `source.verified` is only
 * ever whatever a human review already stored.
 *
 * Every classification fact is written with SQL because the ingest pipeline is a
 * different task's surface: this suite tests the projection, not the classifier.
 */

import { sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFixture,
  createTestApp,
  database,
  deleteFixtureRows,
  state,
  useDomainPrefix,
} from "../aks-harness.js";
import { withFixtureTenant } from "../fixture-tenant.js";

useDomainPrefix("export-classification");

/** One entity as the export emits it. */
interface WireEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly confidence: number;
  readonly properties: Record<string, unknown>;
  readonly source: { readonly verified: boolean; readonly source_kind: string | null };
}

/** One relationship as the export emits it. */
interface WireRelationship {
  readonly id: string;
  readonly type: string;
  readonly confidence: number;
  readonly source: { readonly verified: boolean };
}

/** The parts of a bundle these tests read. */
interface WireBundle {
  readonly entities: readonly WireEntity[];
  readonly relationships: readonly WireRelationship[];
}

/** Values a fixture row is patched with; keys are column names. */
type Patch = Record<string, string | number | boolean | null>;

/**
 * Writes classification columns onto one fixture row.
 *
 * The tenant is bound in the same transaction as the write, because the RLS policies
 * validate writes as well as reads.
 */
async function patchRow(
  stackId: string,
  table: "ontology_entities" | "ontology_relationships",
  id: string,
  patch: Patch,
): Promise<void> {
  await withFixtureTenant(database(), { stackId }, async (tx) => {
    const assignments = Object.entries(patch).map(
      ([column, value]) => sql`${sql.identifier(column)} = ${value}`,
    );
    await tx.execute(
      sql`update ${sql.identifier(table)} set ${sql.join(assignments, sql`, `)} where id = ${id}`,
    );
  });
}

describe.skipIf(state.skipReason !== false)("aks export classification projection", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = createTestApp();
  });

  afterAll(async () => {
    await deleteFixtureRows();
  });

  /** Reads the bundle for one fixture Stack. */
  async function readBundle(domain: string): Promise<WireBundle> {
    const response = await request(app).get(`/aks/v1/export?domain=${domain}`).expect(200);
    return response.body as WireBundle;
  }

  /** Finds an exported entity by name. */
  function entityNamed(bundle: WireBundle, name: string): WireEntity {
    const found = bundle.entities.find((entity) => entity.name === name);
    expect(found).toBeDefined();
    return found as WireEntity;
  }

  /** Finds an exported relationship by its stored id. */
  function relationshipById(bundle: WireBundle, id: string): WireRelationship {
    const found = bundle.relationships.find((relationship) => relationship.id === id);
    expect(found).toBeDefined();
    return found as WireRelationship;
  }

  it("exports a classified entity with its canonical type and keeps its metadata in properties", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.gateway, {
      classification_state: "classified",
      canonical_type: "System",
      proposed_type: "SYSTEM",
      support_state: "supported",
      catalog_version: "1.0.0",
      classifier_version: "classifier-1",
      jev_choice: "System",
      jev_confidence: 0.91,
      jev_top_probability: 0.91,
      jev_model: "jev-latest",
    });

    const gateway = entityNamed(await readBundle(fixture.domain), "Gateway");

    expect(gateway.type).toBe("System");
    // A user property survives: the projection adds one key, it does not replace the object.
    expect(gateway.properties["tier"]).toBe("edge");
    // The read path's block, plus only what a bundle needs on top of it.
    expect(gateway.properties["kg_classification"]).toEqual({
      state: "classified",
      classified: true,
      is_free: false,
      reason: null,
      canonical_type: "System",
      proposed_type: "SYSTEM",
      support_state: "supported",
      catalog_version: "1.0.0",
      classifier_version: "classifier-1",
      jev_choice: "System",
      jev_confidence: 0.91,
      jev_top_probability: 0.91,
      jev_model: "jev-latest",
      jev_classified_at: null,
    });
  });

  it("exports a free entity with the type the extractor proposed, not a stand-in", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.model, {
      classification_state: "free_no_match",
      canonical_type: null,
      proposed_type: "TECHNOLOGY",
      support_state: "supported",
    });

    const model = entityNamed(await readBundle(fixture.domain), "Embedding Model");

    // S27: `Concept` is never substituted for "unclassified"; the proposal survives.
    expect(model.type).toBe("TECHNOLOGY");
    // S3: being free does not discount the evidence, so the extraction value stands.
    expect(model.confidence).toBe(0.6);
    expect(model.properties["kg_classification"]).toMatchObject({
      state: "free_no_match",
      classified: false,
      is_free: true,
      reason: "no_canonical_type_matched",
      canonical_type: null,
      proposed_type: "TECHNOLOGY",
    });
  });

  it("exports the reserved Unclassified label when a free entity proposed nothing", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.limit, {
      classification_state: "free_uncertain",
      canonical_type: null,
      proposed_type: null,
    });

    const limit = entityNamed(await readBundle(fixture.domain), "Rate Limit");

    expect(limit.type).toBe("Unclassified");
    expect(limit.properties["kg_classification"]).toMatchObject({
      state: "free_uncertain",
      classified: false,
      is_free: true,
      reason: "classification_uncertain",
      proposed_type: null,
    });
  });

  it("exports a free relation with its original predicate verbatim", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_relationships", fixture.relationshipIds.uses, {
      predicate: "deja sin efecto",
      classification_state: "free_no_match",
      canonical_type: null,
      support_state: "supported",
    });

    const bundle = await readBundle(fixture.domain);
    const uses = relationshipById(bundle, fixture.relationshipIds.uses);

    // S31: the verb is never collapsed into `related_to`, and it is not re-spelled.
    expect(uses.type).toBe("deja sin efecto");
  });

  it("exports a classified relation with its canonical type and no smuggled metadata", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_relationships", fixture.relationshipIds.uses, {
      predicate: "deja sin efecto",
      classification_state: "classified",
      canonical_type: "invalidates",
      support_state: "supported",
    });

    const bundle = await readBundle(fixture.domain);
    const uses = relationshipById(bundle, fixture.relationshipIds.uses);

    expect(uses.type).toBe("invalidates");
    // AKSRelationship forbids extra fields, so classification stays in our columns.
    expect(Object.keys(uses).sort()).toEqual(
      ["confidence", "description", "from_entity_id", "id", "source", "to_entity_id", "type"].sort(),
    );
    expect(uses).not.toHaveProperty("properties");
  });

  it("scales the extraction confidence by the support state", async () => {
    const fixture = await createFixture();
    const states = [
      [fixture.entityIds.gateway, "supported", 0.5],
      [fixture.entityIds.model, "uncertain", 0.6],
      [fixture.entityIds.limit, "unsupported", 0.5],
    ] as const;
    for (const [id, support, confidence] of states) {
      await patchRow(fixture.stackId, "ontology_entities", id, {
        confidence,
        support_state: support,
      });
    }

    const bundle = await readBundle(fixture.domain);

    // 0.5 x 1.0, 0.6 x 0.75, 0.5 x 0.25 — the documented formula, pinned exactly.
    expect(entityNamed(bundle, "Gateway").confidence).toBe(0.5);
    // Rounded to six places: the raw IEEE product is 0.44999999999999996.
    expect(entityNamed(bundle, "Embedding Model").confidence).toBe(0.45);
    expect(entityNamed(bundle, "Rate Limit").confidence).toBe(0.125);
  });

  it("never reads the JEV numbers when computing confidence", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.model, {
      confidence: 0.5,
      classification_state: "free_no_match",
      proposed_type: "TECHNOLOGY",
      support_state: "uncertain",
      jev_confidence: 0.99,
      jev_top_probability: 0.99,
    });

    const model = entityNamed(await readBundle(fixture.domain), "Embedding Model");

    // S40: a high JEV confidence is not the AKS confidence.
    expect(model.confidence).toBe(0.375);
    expect(model.properties["kg_classification"]).toMatchObject({ jev_confidence: 0.99 });
  });

  it("passes verified through, so an ingested row exports false and a reviewed one true", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.model, {
      verified: false,
      source_kind: "document",
      pipeline: "llamaindex-schema-extraction",
    });
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.gateway, {
      verified: true,
      source_kind: "backfeed",
      pipeline: "human-review",
    });

    const bundle = await readBundle(fixture.domain);

    // S39: no automatic decision sets `verified`; the stored value is the only source.
    expect(entityNamed(bundle, "Embedding Model").source.verified).toBe(false);
    expect(entityNamed(bundle, "Gateway").source.verified).toBe(true);
    expect(entityNamed(bundle, "Gateway").source.source_kind).toBe("backfeed");
  });

  it("filters min_confidence on the projected confidence, not on the raw column", async () => {
    const fixture = await createFixture();
    // 0.6 x 0.25 = 0.15 unsupported, 0.4 x 1.0 = 0.4 supported.
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.model, {
      confidence: 0.6,
      support_state: "unsupported",
    });
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.limit, {
      confidence: 0.4,
      support_state: "supported",
    });

    const response = await request(app)
      .get(`/aks/v1/export?domain=${fixture.domain}&min_confidence=0.3`)
      .expect(200);
    const bundle = response.body as WireBundle;

    // A client asking for 0.3 never receives the 0.15 item it would see as below its bar.
    expect(bundle.entities.map((entity) => entity.name)).toEqual(["Gateway", "Rate Limit"]);
    expect(entityNamed(bundle, "Rate Limit").confidence).toBe(0.4);
  });

  it("publishes no classification block for a row with no recorded decision", async () => {
    const fixture = await createFixture();

    const bundle = await readBundle(fixture.domain);
    const model = entityNamed(bundle, "Embedding Model");

    // A hollow block would be a claim nobody made, so the key is simply absent.
    expect(model.properties).toEqual({});
    expect(model).not.toHaveProperty("properties.kg_classification");
    // The label it was accepted with still says what it is.
    expect(model.type).toBe("TECHNOLOGY");
  });

  it("keeps free and pending items in the bundle, each carrying its own state", async () => {
    const fixture = await createFixture();
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.model, {
      classification_state: "free_no_match",
      proposed_type: "TECHNOLOGY",
      support_state: "supported",
    });
    await patchRow(fixture.stackId, "ontology_entities", fixture.entityIds.limit, {
      classification_state: "pending",
      proposed_type: "CONCEPT",
    });

    const bundle = await readBundle(fixture.domain);

    // The export is not a type filter: an unanswered classification is exported, with
    // the state that says nobody decided yet, never as free and never dropped.
    expect(bundle.entities.map((entity) => entity.name)).toEqual([
      "Embedding Model",
      "Gateway",
      "Rate Limit",
    ]);
    const pending = entityNamed(bundle, "Rate Limit");
    expect(pending.type).toBe("CONCEPT");
    expect(pending.properties["kg_classification"]).toMatchObject({
      state: "pending",
      classified: false,
      is_free: false,
      reason: "classification_pending",
    });
    const free = entityNamed(bundle, "Embedding Model");
    expect(free.properties["kg_classification"]).toMatchObject({
      is_free: true,
      reason: "no_canonical_type_matched",
    });
  });
});
