import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createClient,
  createDatabase,
  createTransactionRunner,
} from "../db.js";
import type { Database, TransactionRunner } from "../db.js";
import type {
  BackfeedEntityProposalDto,
  BackfeedRelationshipProposalDto,
} from "../dto.js";
import { consolidateBackfeedProposal } from "./consolidation.js";

/**
 * Integration tests for `consolidateBackfeedProposal`, against the live compose
 * database.
 *
 * Same conventions as `db.test.ts` and `routes/stacks.test.ts`: port 5434 (the
 * host remap from `docker-compose.override.yml`), an own pool rather than the
 * process-wide singleton, and a clean skip — never a failure — when Postgres is
 * unreachable, so `npm test` still works without Docker.
 *
 * ## Shared-database discipline
 *
 * Two sibling slices are writing to this same database right now, so every
 * fixture this suite creates hangs off a Stack whose `domain` starts with
 * {@link DOMAIN_PREFIX}. `stacks` is the only table with a cleanup key of its
 * own; every other row this suite writes references it with
 * `on delete cascade`, so deleting the prefixed Stacks is a complete cleanup.
 * The explicit deletes in `afterAll` are defence in depth, ordered child-first,
 * in case a future schema change drops a cascade.
 *
 * ## Every expectation was measured against the Python oracle
 *
 * The comments name the measurement where a value is surprising — particularly
 * the confidence arithmetic, the NULL-description-as-empty-string quirk and the
 * `extracted_by_model` NULL.
 */
const TEST_DATABASE_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** Small handshake bound so an absent database skips fast instead of hanging. */
const CONNECT_TIMEOUT_SECONDS = 3;

/** Domain prefix for every Stack this suite creates. Shared DB, unique prefix. */
const DOMAIN_PREFIX = "w1bf-consolidation-";

const state: {
  client?: Sql;
  database?: Database;
  runner?: TransactionRunner;
  skipReason: string | false;
} = { skipReason: "database probe did not run" };

{
  const candidate = createClient(TEST_DATABASE_URL, CONNECT_TIMEOUT_SECONDS);
  try {
    await candidate`select 1`;
    const database = createDatabase(candidate);
    state.client = candidate;
    state.database = database;
    state.runner = createTransactionRunner(database);
    state.skipReason = false;
  } catch (error) {
    state.skipReason = `database unreachable at ${TEST_DATABASE_URL}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await candidate.end({ timeout: 1 }).catch(() => undefined);
  }
}

if (state.skipReason !== false) {
  console.warn(
    `[consolidation.test] skipping integration tests — ${state.skipReason}`,
  );
}

/**
 * Narrows the setup state for the compiler without an unchecked cast, matching
 * `stacks.test.ts`. `describe.skipIf` already guarantees it is set.
 */
function database(): Database {
  if (state.database === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.database;
}

function runner(): TransactionRunner {
  if (state.runner === undefined) {
    throw new Error("integration setup did not complete");
  }
  return state.runner;
}

/** Deletes every row this suite created, children first. */
async function deleteFixtureRows(): Promise<void> {
  const prefixed = sql`select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}`;

  await database().execute(
    sql`delete from ontology_relationships where stack_id in (${prefixed})`,
  );
  await database().execute(
    sql`delete from ontology_entities where stack_id in (${prefixed})`,
  );
  await database().execute(sql`delete from stacks where domain like ${`${DOMAIN_PREFIX}%`}`);
}

/** Counts this suite's entity rows; used to prove cleanup actually happened. */
async function countFixtureEntities(): Promise<number> {
  const rows = await database().execute<{ total: number }>(sql`
    select count(*)::int as total
    from ontology_entities
    where stack_id in (
      select id from stacks where domain like ${`${DOMAIN_PREFIX}%`}
    )
  `);
  return rows[0]?.total ?? -1;
}

afterAll(async () => {
  await deleteFixtureRows();
  expect(await countFixtureEntities()).toBe(0);
  if (state.client !== undefined) {
    await state.client.end({ timeout: 5 });
  }
});

/** A stored `ontology_entities` row, as this suite asserts on it. */
type EntityRow = {
  name: string;
  type: string;
  description: string | null;
  confidence: number;
  verified: boolean;
  source_kind: string | null;
  pipeline: string | null;
  extracted_by_model: string | null;
  properties: unknown;
};

/** Builds a proposal entity, defaulting like `BackfeedEntityProposal` does. */
function entity(
  name: string,
  overrides: Partial<BackfeedEntityProposalDto> = {},
): BackfeedEntityProposalDto {
  return {
    name,
    type: "concept",
    description: null,
    confidence: 0.7,
    properties: {},
    ...overrides,
  };
}

/** Builds a proposal relationship, defaulting like the DTO does. */
function relationship(
  from: string,
  to: string,
  overrides: Partial<BackfeedRelationshipProposalDto> = {},
): BackfeedRelationshipProposalDto {
  return {
    from_entity: from,
    to_entity: to,
    type: "relates_to",
    description: null,
    confidence: 0.7,
    ...overrides,
  };
}

describe.skipIf(state.skipReason !== false)(
  "consolidateBackfeedProposal (live database)",
  () => {
    let sequence = 0;
    let stackId = "";

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${DOMAIN_PREFIX}${label}-${Date.now().toString(36)}-${String(sequence)}`;
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
