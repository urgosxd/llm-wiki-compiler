/**
 * @file test/compiler/graph-retirement-dimensions.test.ts
 * @description WHICH dimensions `compile` retires a deleted source FROM, and
 * whether answering that needs a Stack at all.
 *
 * ## The decision under test
 *
 * `forgetDeletedSources` retires the graph and nothing else, so `kg` is the only
 * dimension it can need. "Is the graph even on?" is therefore answered BEFORE any
 * Stack is resolved (`resolveStackForDimensions`), which is what keeps the ordinary
 * wiki-only compile off the database: the Stack a bare checkout has is provisioned
 * on first use, so resolving unconditionally would make every compile in the project
 * dial Postgres for a dimension it never uses. `compile`'s side of that contract is
 * three lines — `undefined` means "no retirement dimensions" — and this file pins the
 * half that can go wrong.
 *
 * ## Why a probe handle instead of a real database
 *
 * "Performs no provisioning" is only observable as "the handle was never asked
 * anything". The probe below throws on the FIRST property access, so any query,
 * transaction or drizzle builder call fails the case with the property that was
 * requested — which names the leak instead of only proving the result happened to be
 * empty.
 *
 * ## Why the graph-on case needs a real database
 *
 * The other half is the opposite claim: with `kg` enabled and no Stack configured,
 * resolution MUST reach the database, because the default Stack has to exist before
 * anything can be keyed by it. A probe can only prove "something was called", so this
 * half runs against the shared Postgres harness and asserts the provisioned row. The
 * default Stack is one global row (`stacks.domain` is unique), so the case leaves it
 * in place rather than deleting a row another suite may be using.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import { resolveStackForDimensions } from "../../src/services/stacks/resolve-stack.js";
import { resolveDimensions } from "../../src/dimensions/activation.js";
import { DEFAULT_STACK_DOMAIN } from "../../src/dimensions/stack-selection.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";

/** The dimensions compile retires from — the graph alone. */
const RETIREMENT_DIMENSIONS = ["kg"] as const;

/** The handle shape resolution accepts, without reaching for drizzle directly. */
type StackDb = Parameters<typeof resolveStackForDimensions>[0];

/**
 * A database handle that fails the moment anything is asked of it.
 *
 * Deliberately throws on EVERY property read, `then` included: a caller that awaited
 * the handle by mistake has reached the database just as surely as one that ran a
 * query.
 *
 * @returns A handle no code path may use, and a flag saying whether it was.
 */
function probeDb(): { db: StackDb; wasReached: () => boolean } {
  let reached = false;
  const db = new Proxy({} as object, {
    get(_target, property) {
      reached = true;
      throw new Error(
        `retirement resolution reached the database when it should not have ` +
          `(asked for "${String(property)}")`,
      );
    },
  }) as StackDb;
  return { db, wasReached: () => reached };
}

const harness = await createKgPostgresHarness("graph-retirement");

/** A scratch project root; resolution reads no file, but its signature takes one. */
async function scratchRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "graph-retirement-"));
}

afterAll(() => harness.cleanup());

describe("graph retirement resolution with nothing configured", () => {
  it("needs no Stack without reaching the database", async () => {
    const { db, wasReached } = probeDb();

    // A bare checkout: no `LLMWIKI_DIMENSIONS` (so `wiki` alone) and no
    // `AKS_STACK_ID`, which means the selection is the default one and has to be
    // provisioned before it can be used as an id.
    const stackId = await resolveStackForDimensions(db, {}, RETIREMENT_DIMENSIONS);

    // `wiki` is the only enabled dimension, so there is nothing to retire from.
    expect(stackId).toBeUndefined();
    // And deciding that must not cost the connection the default Stack would need.
    expect(wasReached()).toBe(false);
  }, 30_000);

  it("retires the graph from the Stack AKS_STACK_ID names, with no lookup", async () => {
    const root = await scratchRoot();
    const { db, wasReached } = probeDb();
    const configured = randomUUID();
    const configuredEnv: NodeJS.ProcessEnv = {
      LLMWIKI_DIMENSIONS: "kg", AKS_STACK_ID: configured,
    };
    try {
      const stackId = await resolveStackForDimensions(
        db, configuredEnv, RETIREMENT_DIMENSIONS);

      // A configured Stack is used exactly as given: no round trip, and in
      // particular no provisioning of a default nobody asked for.
      expect(stackId).toBe(configured);
      expect(wasReached()).toBe(false);

      // And the dimension retirement actually gets is shaped from that answer, from
      // that SAME environment: the graph alone, as it was before this change.
      // These two calls are the pair `compile` makes for one deleted source.
      const dimensions = resolveDimensions({
        root, db, env: configuredEnv, only: RETIREMENT_DIMENSIONS,
        stackId: stackId ?? undefined,
      });
      expect(dimensions.map((dimension) => dimension.name)).toEqual(["kg"]);
      expect(wasReached()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!harness.reachable)("graph retirement resolution with the graph enabled", () => {
  it("provisions the default Stack and returns its id", async () => {
    const stackId = await resolveStackForDimensions(
      harness.db,
      { AKS_DATABASE_URL: DATABASE_URL, LLMWIKI_DIMENSIONS: "kg" },
      RETIREMENT_DIMENSIONS,
    );

    expect(stackId).toEqual(expect.any(String));
    // Proof the database really was reached: the default Stack now exists, and the
    // id handed back is that row's.
    const rows = await harness.db.execute<{ id: string }>(
      sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
    );
    expect(rows.map((row) => row.id)).toEqual([stackId]);
  }, 60_000);
});
