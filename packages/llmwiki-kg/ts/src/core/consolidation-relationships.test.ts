/**
 * @file packages/llmwiki-kg/ts/src/core/consolidation-relationships.test.ts
 * @description Relationship absorption: endpoint resolution and confidence aggregation.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { consolidateBackfeedProposal } from "./consolidation.js";
import { sql } from "drizzle-orm";
import { currentDomainPrefix, database, entity, relationship, runner, skipReason, useDomainPrefix } from "./consolidation-harness.js";
import type { EntityRow } from "./consolidation-harness.js";

describe.skipIf(skipReason !== false)("consolidateBackfeedProposal relationships (live database)", () => {
  useDomainPrefix("relationships");
      let sequence = 0;

      let stackId = "";

      /** Unique domain per call, carrying the cleanup prefix. */
      function uniqueDomain(label: string): string {
        sequence += 1;
        return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
      }

      /** Creates a fixture Stack and returns its id. */
      async function createStack(label: string): Promise<string> {
        const rows = await database().execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Consolidation fixture ${label}`}, ${uniqueDomain(label)})
          returning id
        `);
        const row = rows[0];
        if (row === undefined) {
          throw new Error("insert into stacks returned no row");
        }
        return row.id;
      }
      /** A single entity row by exact name, or `undefined`. */
      async function entityNamed(name: string): Promise<EntityRow | undefined> {
        const rows = await database().execute<EntityRow>(sql`
          select name, type, description, confidence, verified,
                 source_kind, pipeline, extracted_by_model, properties
          from ontology_entities
          where stack_id = ${stackId} and name = ${name}
        `);
        return rows[0];
      }

      /** Stored relationship rows for the current fixture Stack. */
      async function relationships(): Promise<
        {
          type: string;
          confidence: number;
          description: string | null;
          verified: boolean;
          source_kind: string | null;
          pipeline: string | null;
          from_name: string;
          to_name: string;
        }[]
      > {
        return database().execute(sql`
          select r.type, r.confidence, r.description, r.verified,
                 r.source_kind, r.pipeline,
                 f.name as from_name, t.name as to_name
          from ontology_relationships r
          join ontology_entities f on f.id = r.from_entity_id
          join ontology_entities t on t.id = r.to_entity_id
          where r.stack_id = ${stackId}
          order by r.type, f.name, t.name
        `);
      }

      beforeEach(async () => {
        stackId = await createStack("case");
      });

      it("inserts a relationship between two proposed entities", async () => {
        const result = await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("From1"), entity("To1")],
            [relationship("From1", "To1", { type: "depends_on", confidence: 0.9 })],
          ),
        );

        expect(result).toEqual({ entitiesAbsorbed: 2, relationshipsAbsorbed: 1 });

        const edges = await relationships();
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
          type: "depends_on",
          confidence: 0.9,
          description: null,
          verified: true,
          source_kind: "backfeed",
          pipeline: "human-review",
          from_name: "From1",
          to_name: "To1",
        });
      });

      it("skips a relationship whose endpoints cannot be resolved", async () => {
        const result = await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Solo")],
            [relationship("Solo", "Ghost", { type: "mentions" })],
          ),
        );

        // Skipped, not invented, and NOT counted.
        expect(result).toEqual({ entitiesAbsorbed: 1, relationshipsAbsorbed: 0 });
        expect(await entityNamed("Ghost")).toBeUndefined();
        expect(await relationships()).toHaveLength(0);
      });

      it("resolves a relationship endpoint against the existing ontology", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("PreExisting")], []),
        );

        const result = await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Newcomer")],
            [relationship("Newcomer", "PreExisting", { type: "points_at" })],
          ),
        );

        expect(result.relationshipsAbsorbed).toBe(1);
        const edges = await relationships();
        expect(edges[0]).toMatchObject({
          from_name: "Newcomer",
          to_name: "PreExisting",
          type: "points_at",
        });
      });

      it("raises the confidence of an existing edge to the stronger value only", async () => {
        const entitiesAndEdge = async (
          confidence: number,
          description: string,
        ): Promise<void> => {
          await runner()((tx) =>
            consolidateBackfeedProposal(
              tx,
              stackId,
              [entity("EdgeFrom"), entity("EdgeTo")],
              [
                relationship("EdgeFrom", "EdgeTo", {
                  type: "linked",
                  confidence,
                  description,
                }),
              ],
            ),
          );
        };

        await entitiesAndEdge(0.9, "the strong description");
        await entitiesAndEdge(0.3, "a weaker description that must not win");

        const edges = await relationships();
        expect(edges).toHaveLength(1);
        // `greatest(existing, excluded)` keeps 0.9, and the description CASE
        // keeps the stored one because the incoming confidence is lower.
        expect(edges[0]?.confidence).toBe(0.9);
        expect(edges[0]?.description).toBe("the strong description");

        await entitiesAndEdge(0.95, "the strongest description");
        const updated = await relationships();
        expect(updated[0]?.confidence).toBe(0.95);
        expect(updated[0]?.description).toBe("the strongest description");
      });
  },
);
