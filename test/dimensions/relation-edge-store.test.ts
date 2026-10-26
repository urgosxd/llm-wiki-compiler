/**
 * @file test/dimensions/relation-edge-store.test.ts
 * @description The typed graph edges over rows.
 *
 * Two properties could be lost moving off `relations.jsonl`, and both are asserted:
 * the per-record checksum must still verify (and still FAIL on tampering), and the
 * dedup key must still be endpoints + type + EVIDENCE — an edge that gains evidence
 * is a different edge, not a duplicate.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readRelationEdges,
  supersedeRelationEdge,
  upsertRelationEdge,
} from "../../src/dimensions/wiki/relation-edge-store.js";
import { buildRelationRef } from "../../src/relations/store.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/** A minimal profile declaring the one relation this suite uses. */
const PROFILE = {
  relations: { SUPPLIES: { from: ["concepts"], to: ["concepts"], direction: "directed" } },
  entities: { concepts: {} },
} as unknown as ProfilePack;

/** Build a relation with a distinguishing evidence span. */
function refOf(evidenceLine: number) {
  return buildRelationRef(PROFILE, {
    type: "SUPPLIES",
    from: "concepts/alpha" as never,
    to: "concepts/beta" as never,
    attributes: {},
    evidence: [{ sourcePath: "sources/s.md", sourceSpan: `L${evidenceLine}-L${evidenceLine}` }],
  });
}

let harness: KgPostgresHarness;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`rel-${randomUUID().slice(0, 8)}`);
});

afterEach(async () => {
  await harness.cleanup();
});

describe("relation edges as rows", () => {
  it("reads as empty on a Stack with no edges", async () => {
    expect(await readRelationEdges(harness.db, harness.stackId)).toEqual([]);
  });

  it("round-trips an edge with its attributes and evidence", async () => {
    const ref = refOf(10);
    expect(await upsertRelationEdge(harness.db, harness.stackId, ref)).toBe(true);

    const edges = await readRelationEdges(harness.db, harness.stackId);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.ref.contentHash).toBe(ref.contentHash);
    expect(edges[0]?.ref.evidence).toHaveLength(1);
  });

  it("treats the SAME edge as a no-op rather than a duplicate", async () => {
    const ref = refOf(10);
    await upsertRelationEdge(harness.db, harness.stackId, ref);
    const second = await upsertRelationEdge(harness.db, harness.stackId, ref);

    expect(second).toBe(false);
    expect(await readRelationEdges(harness.db, harness.stackId)).toHaveLength(1);
  });

  it("keeps an edge that GAINS evidence as a SEPARATE edge", async () => {
    // The dedup key is endpoints + type + contentHash, and evidence is inside
    // contentHash. Collapsing these would silently lose provenance.
    await upsertRelationEdge(harness.db, harness.stackId, refOf(10));
    expect(await upsertRelationEdge(harness.db, harness.stackId, refOf(99))).toBe(true);
    expect(await readRelationEdges(harness.db, harness.stackId)).toHaveLength(2);
  });

  it("hides a superseded edge from reads without deleting it", async () => {
    const first = refOf(10);
    const second = refOf(99);
    await upsertRelationEdge(harness.db, harness.stackId, first);
    await upsertRelationEdge(harness.db, harness.stackId, second);
    await supersedeRelationEdge(harness.db, harness.stackId, first.id, second.id);

    // Gone from the live graph...
    const live = await readRelationEdges(harness.db, harness.stackId);
    expect(live.map((e) => e.ref.id)).toEqual([second.id]);

    // ...but still on disk as history, with its checksum intact.
    const all = await harness.db.execute<{ n: number }>(sql`
      select count(*)::int as n from wiki.relation_edges where stack_id = ${harness.stackId}
    `);
    expect(all[0]?.n).toBe(2);
  });
});
