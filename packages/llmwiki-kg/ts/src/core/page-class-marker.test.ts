/**
 * @file packages/llmwiki-kg/ts/src/core/page-class-marker.test.ts
 * @description S4 on the page path — the most dangerous reasoning surface of this
 * feature: a rejected edge that reaches this prompt can be woven into generated wiki
 * prose, where it later reads as a settled fact.
 *
 * The accepted prompt text is asserted BYTE FOR BYTE against what the oracle pinned,
 * because the marker is additive: only a refused item changes shape. Both edge
 * directions and the entity's own block are covered.
 */

import { afterAll, beforeEach, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { gatherEntityContext } from "./page/context-read.js";
import { buildPagePrompt } from "./page/prompt.js";
import {
  createFixture,
  database,
  deleteFixtureRows,
  state,
  useDomainPrefix,
} from "../routes/aks-harness.js";
import { withFixtureTenant } from "../routes/fixture-tenant.js";
import type { Fixture } from "../routes/aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("pagemark");

/** The database gate every case in this file shares. */
const skip = state.skipReason !== false;

beforeEach(async () => {
  await deleteFixtureRows();
});

afterAll(async () => {
  // A suite that never ran must not ask for the database it never had.
  if (skip) return;
  await deleteFixtureRows();
});

/**
 * Mark one stored row as refused by the ontology.
 *
 * One parameterised helper rather than two per-table copies: what the page path cares
 * about is the three columns moving together, and the table they sit on is the only
 * thing that differs between an entity and an edge.
 */
async function markRefused(
  table: "ontology_entities" | "ontology_relationships",
  id: string,
  reason: "UNKNOWN_ENTITY_TYPE" | "UNKNOWN_RELATIONSHIP_TYPE",
  offending: string,
): Promise<void> {
  await database().execute(sql`
    update ${sql.raw(table)}
    set ontology_verdict = 'rejected',
        ontology_rejection_reason = ${reason},
        ontology_offending_type = ${offending}
    where id = ${id}
  `);
}

/** The page context of one fixture entity, read under its own tenant. */
async function contextOf(fixture: Fixture, entityId: string, acceptedOnly = false) {
  return withFixtureTenant(database(), { stackId: fixture.stackId }, (tx) =>
    gatherEntityContext(tx, entityId, { acceptedOnly }),
  );
}

it.skipIf(skip)("carries the class on every edge row the page is built from", async () => {
  const fixture = await createFixture();
  await markRefused("ontology_relationships", fixture.relationshipIds.has, "UNKNOWN_RELATIONSHIP_TYPE", "ABSORBS");

  const context = await contextOf(fixture, fixture.entityIds.model);

  expect(context?.outgoing[0]?.["ontology_verdict"]).toBe("rejected");
  expect(context?.outgoing[0]?.["ontology_rejection_reason"]).toBe("UNKNOWN_RELATIONSHIP_TYPE");
  expect(context?.incoming[0]?.["ontology_verdict"]).toBe("accepted");
  expect(context?.incoming[0]?.["ontology_rejection_reason"]).toBeNull();
});

it.skipIf(skip)("omits the refused edge when the caller asks for accepted only", async () => {
  const fixture = await createFixture();
  await markRefused("ontology_relationships", fixture.relationshipIds.has, "UNKNOWN_RELATIONSHIP_TYPE", "ABSORBS");

  const context = await contextOf(fixture, fixture.entityIds.model, true);

  expect(context?.outgoing).toEqual([]);
  expect(context?.incoming).toHaveLength(1);
});

it.skipIf(skip)("keeps the accepted relationship line exactly as the oracle pinned it", async () => {
  const fixture = await createFixture();

  const context = await contextOf(fixture, fixture.entityIds.model);

  expect(buildPagePrompt(context!)).toContain(
    "  - This entity HASs Rate Limit (CONCEPT, confidence 0.55)",
  );
});

it.skipIf(skip)("marks a refused outgoing edge in the prompt the model reads", async () => {
  const fixture = await createFixture();
  await markRefused("ontology_relationships", fixture.relationshipIds.has, "UNKNOWN_RELATIONSHIP_TYPE", "ABSORBS");

  const context = await contextOf(fixture, fixture.entityIds.model);

  expect(buildPagePrompt(context!)).toContain(
    "  - This entity HASs Rate Limit (CONCEPT, confidence 0.55)" +
      " [REJECTED by the ontology: UNKNOWN_RELATIONSHIP_TYPE]",
  );
});

it.skipIf(skip)("marks a refused incoming edge in the same way", async () => {
  const fixture = await createFixture();
  await markRefused("ontology_relationships", fixture.relationshipIds.uses, "UNKNOWN_RELATIONSHIP_TYPE", "ABSORBS");

  const context = await contextOf(fixture, fixture.entityIds.model);

  expect(buildPagePrompt(context!)).toContain(
    "  - Gateway (SYSTEM) USED_BYs this entity (confidence 0.75)" +
      " [REJECTED by the ontology: UNKNOWN_RELATIONSHIP_TYPE]",
  );
});

it.skipIf(skip)("marks a refused entity in its own block, and leaves an accepted one alone", async () => {
  const fixture = await createFixture();
  await markRefused("ontology_entities", fixture.entityIds.gateway, "UNKNOWN_ENTITY_TYPE", "WIDGET");

  const rejected = await contextOf(fixture, fixture.entityIds.gateway);
  const accepted = await contextOf(fixture, fixture.entityIds.model);

  expect(buildPagePrompt(rejected!)).toContain(
    "  Ontology: REJECTED by the ontology (UNKNOWN_ENTITY_TYPE); refused type WIDGET",
  );
  expect(buildPagePrompt(accepted!)).not.toContain("Ontology:");
});
