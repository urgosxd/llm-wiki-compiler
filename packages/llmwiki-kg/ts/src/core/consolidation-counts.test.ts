/**
 * @file packages/llmwiki-kg/ts/src/core/consolidation-counts.test.ts
 * @description Returned counts and Stack scoping.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { consolidateBackfeedProposal } from "./consolidation.js";
import { sql } from "drizzle-orm";
import { currentDomainPrefix, database, entity, runner, skipReason, useDomainPrefix, trackFixtureStack } from "./consolidation-harness.js";
import type { EntityRow } from "./consolidation-harness.js";
import { withFixtureTenant } from "../routes/fixture-tenant.js";

describe.skipIf(skipReason !== false)("consolidateBackfeedProposal counts (live database)", () => {
  useDomainPrefix("counts");
      let sequence = 0;

      let stackId = "";

      /** Unique domain per call, carrying the cleanup prefix. */
      function uniqueDomain(label: string): string {
        sequence += 1;
        return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
      }

      /** Creates a fixture Stack and returns its id. */
      async function createStack(label: string): Promise<string> {
        // The domain is computed ONCE: binding one value and inserting another would
        // bind a tenant that does not match the row being written, which the policy
        // refuses.
        const domain = uniqueDomain(label);
        const rows = await withFixtureTenant(database(), { domain }, (tx) => tx.execute<{ id: string }>(sql`
          insert into stacks (name, domain)
          values (${`Consolidation fixture ${label}`}, ${domain})
          returning id
        `));
        const row = rows[0];
        if (row === undefined) {
          throw new Error("insert into stacks returned no row");
        }
        trackFixtureStack(row.id);
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

      beforeEach(async () => {
        stackId = await createStack("case");
      });

      it("reports zero counts and writes nothing for an empty proposal", async () => {
        const result = await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [], []),
        );

        expect(result).toEqual({ entitiesAbsorbed: 0, relationshipsAbsorbed: 0 });
        expect(await entities()).toHaveLength(0);
      });

      it("scopes every write to the given Stack", async () => {
        const otherStackId = await createStack("other");

        await runner()((tx) =>
          consolidateBackfeedProposal(tx, stackId, [entity("Scoped")], []),
        );
        await runner()((tx) =>
          consolidateBackfeedProposal(tx, otherStackId, [entity("Scoped")], []),
        );

        // Same name in two Stacks: the uniqueness constraint is per-Stack, so
        // both must exist and neither may be updated by the other.
        const rows = await database().execute<{ stack_id: string }>(sql`
          select stack_id from ontology_entities
          where name = 'Scoped'
            and stack_id in (${stackId}, ${otherStackId})
        `);
        expect(rows).toHaveLength(2);
      });
  },
);
