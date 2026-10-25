/**
 * @file packages/llmwiki-kg/ts/src/core/consolidation-entities.test.ts
 * @description Entity absorption: insert markers, the 0.1 confidence bump and the description rules.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { consolidateBackfeedProposal } from "./consolidation.js";
import { sql } from "drizzle-orm";
import { currentDomainPrefix, database, entity, runner, skipReason, useDomainPrefix } from "./consolidation-harness.js";
import type { EntityRow } from "./consolidation-harness.js";
import { withFixtureTenant } from "../routes/fixture-tenant.js";

describe.skipIf(skipReason !== false)("consolidateBackfeedProposal entities (live database)", () => {
  useDomainPrefix("entities");
      let sequence = 0;

      let stackId = "";

      /** Unique domain per call, carrying the cleanup prefix. */
      function uniqueDomain(label: string): string {
        sequence += 1;
        return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
      }

      /** Creates a fixture Stack and returns its id. */
      async function createStack(label: string): Promise<string> {
        const rows = await withFixtureTenant(database(), { domain: uniqueDomain(label) }, (tx) => tx.execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Consolidation fixture ${label}`}, ${uniqueDomain(label)})
          returning id
        `));
        const row = rows[0];
        if (row === undefined) {
          throw new Error("insert into stacks returned no row");
        }
        return row.id;
      }

      /** Every `ontology_entities` row of the current fixture Stack, by name. */
      async function entities(): Promise<EntityRow[]> {
        return database().execute<EntityRow>(sql`
          select name, type, description, confidence, verified,
                 source_kind, pipeline, extracted_by_model, properties
          from ontology_entities
          where stack_id = ${stackId}
          order by name
        `);
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

      beforeEach(async () => {
        stackId = await createStack("case");
      });

      it("inserts a fresh entity with the backfeed markers and no model attribution", async () => {
        const result = await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Alpha", { type: "service" })], []),
        );

        expect(result).toEqual({ entitiesAbsorbed: 1, relationshipsAbsorbed: 0 });

        const alpha = await entityNamed("Alpha");
        expect(alpha).toBeDefined();
        expect(alpha).toMatchObject({
          name: "Alpha",
          type: "service",
          description: null,
          confidence: 0.7,
          verified: true,
          // The three markers that make a row eligible for scope graduation.
          source_kind: "backfeed",
          pipeline: "human-review",
          // Measured on the oracle: backfeed absorption does NOT stamp a model.
          extracted_by_model: null,
          // The Python insert never references `properties`, so the column
          // default survives even when the proposal carries properties.
          properties: {},
        });
      });

      it("keeps the proposal confidence on a fresh insert", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Faded", { confidence: 0 })],
            [],
          ),
        );

        // 0 is a legal confidence and must not fall back to the 0.7 default.
        expect((await entityNamed("Faded"))?.confidence).toBe(0);
      });

      it("bumps an existing entity by 0.1, marks it verified and keeps the longer description", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Beta", { type: "concept", description: "short" })],
            [],
          ),
        );

        // Second absorption with a longer description.
        const result = await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Beta", { type: "concept", description: "a considerably longer description" })],
            [],
          ),
        );

        // An update counts exactly like an insert: the count is writes handled.
        expect(result).toEqual({ entitiesAbsorbed: 1, relationshipsAbsorbed: 0 });

        const beta = await entityNamed("Beta");
        // 0.7 + 0.1 in double precision is 0.7999999999999999; `real` stores 0.8.
        expect(beta?.confidence).toBeCloseTo(0.8, 6);
        expect(beta?.description).toBe("a considerably longer description");
        expect(beta?.verified).toBe(true);
      });

      it("keeps the stored description when the new one is not longer", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Gamma", { description: "the original long description" })],
            [],
          ),
        );

        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Gamma", { description: "shorter" })], []),
        );

        expect((await entityNamed("Gamma"))?.description).toBe(
          "the original long description",
        );
      });

      it("treats an equal-length description as not longer, keeping the stored one", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Delta", { description: "aaaaa" })],
            [],
          ),
        );

        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Delta", { description: "bbbbb" })], []),
        );

        // Python's rule is a strict `>` on length, so a same-length candidate loses.
        expect((await entityNamed("Delta"))?.description).toBe("aaaaa");
      });

      it("ignores an empty-string description on an existing entity", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Epsilon", { description: "kept" })],
            [],
          ),
        );

        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Epsilon", { description: "" })], []),
        );

        // `if ent.get("description")` is a truthiness test: `""` is rejected
        // before the length comparison, so the stored description survives.
        expect((await entityNamed("Epsilon"))?.description).toBe("kept");
      });

      it("rewrites an existing NULL description as the empty string", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Zeta")], []),
        );
        expect((await entityNamed("Zeta"))?.description).toBeNull();

        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Zeta")], []),
        );

        // `existing_desc = row["description"] or ""`, and that empty string is
        // what the update writes back. Measured on the oracle: `t` -> `f`.
        expect((await entityNamed("Zeta"))?.description).toBe("");
      });

      it("caps the confidence bump at 1.0", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Capped", { confidence: 1 })],
            [],
          ),
        );
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Capped", { confidence: 1 })],
            [],
          ),
        );

        expect((await entityNamed("Capped"))?.confidence).toBe(1);
      });

      it("matches an existing entity case-insensitively", async () => {
        await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("Eta", { type: "first-type" })],
            [],
          ),
        );

        const result = await runner()((tx) =>
          consolidateBackfeedProposal(
            tx,
            stackId,
            [entity("ETA", { type: "second-type" })],
            [],
          ),
        );

        // One entity absorbed into the existing row, not a second insert.
        expect(result.entitiesAbsorbed).toBe(1);
        const rows = await entities();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe("Eta");
        // `type` is not part of the update statement, so the original survives.
        expect(rows[0]?.type).toBe("first-type");
        expect(rows[0]?.confidence).toBeCloseTo(0.8, 6);
      });
  },
);
