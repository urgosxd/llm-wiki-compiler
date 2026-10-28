/**
 * @file test/fixtures/event-audit-fixture.ts
 * @description Shared scaffolding for the event-emit / event-audit-content suites:
 * the research-lite relations endpoints + profile, a temp-root lifecycle pair, and
 * a `readChainVerified` helper that reads the event store and asserts the chain +
 * head anchor are intact (the assertion both suites repeat).
 */

import { expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import type { EventRecord } from "../../src/events/types.js";
import type { RelationRef } from "../../src/relations/types.js";
import { appendRelation } from "../../src/relations/store.js";
import { readEvents, verifyEventChain, verifyHeadAnchor } from "../../src/events/store-read.js";
import { buildResearchLiteRelationsProject, RESEARCH_LITE_RELATIONS_PROFILE } from "./profile-fixtures.js";

/** The `experiments` endpoint the relations suites create `tests` edges from. */
export const EXP = "experiments/ablation-batch-size" as EntityId;
/** The `ideas` endpoint the relations suites create `tests` edges to. */
export const IDEA = "ideas/sparse-routing" as EntityId;

/** The research-lite profile that declares the `tests` relation type. */
export const relationsProfile = (): ProfilePack => RESEARCH_LITE_RELATIONS_PROFILE as ProfilePack;

/** Create a fresh research-lite relations project under a temp dir; returns its root. */
export async function makeRelationsRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await buildResearchLiteRelationsProject(root);
  return root;
}

/** Remove a temp root (no-op on empty string), for `afterEach` teardown. */
export async function cleanupRoot(root: string): Promise<void> {
  if (root) await rm(root, { recursive: true, force: true });
}

/**
 * Write a `tests` relation through the surviving relation store and return the
 * single emitted `relation-create` event (asserting exactly one landed). The two
 * suites then assert their distinct property of it (`decision` vs `payload`).
 *
 * This used to go through `wiki.createRelation`, which the SDK stopped exposing
 * with the staging facade. `appendRelation` is the path the CLI and the rest of
 * the relations dimension use, so the event-emission property is asserted against
 * the real writer rather than dropped with the SDK method.
 */
export async function createTestRelationEvent(root: string): Promise<{ ref: RelationRef; event: EventRecord }> {
  const ref = await appendRelation(root, RESEARCH_LITE_RELATIONS_PROFILE, { type: "tests", from: EXP, to: IDEA });
  const { events } = await readEvents(root);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("relation-create");
  return { ref, event: events[0] };
}

/** Read the event store and ASSERT the chain + head anchor verify intact; return the events. */
export async function readChainVerified(root: string): Promise<EventRecord[]> {
  const { events, problems } = await readEvents(root);
  expect(problems).toEqual([]);
  expect(verifyEventChain(events).ok).toBe(true);
  expect((await verifyHeadAnchor(root, events)).ok).toBe(true);
  return events;
}
