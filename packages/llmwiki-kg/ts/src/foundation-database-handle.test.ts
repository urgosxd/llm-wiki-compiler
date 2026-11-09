/**
 * @file packages/llmwiki-kg/ts/src/foundation-database-handle.test.ts
 * @description The `DatabaseHandle` seam accepts a real drizzle handle, and only
 * describes what this repository is measured to call.
 *
 * WHY THIS FILE EXISTS. `@repo/foundation` exists so the wiki side can hold a
 * database handle without importing `@repo/kg`, which the topology forbids. That
 * claim rests on one property nothing else checks: the structural interface must be
 * SATISFIED by the value `createDatabase(createClient(url))` actually produces. A
 * structural type that is merely plausible compiles inside this package and fails at
 * every call site, or worse, is satisfied by something that is not the real handle.
 *
 * WHY IT LIVES IN THE KG PACKAGE, not in `test/`. The proof needs a real KG handle,
 * and a test under `test/` importing `@repo/kg` is a `wiki → kg` reach that the
 * dimension boundary gate counts — correctly, since that is the edge this whole
 * package split removes. The permitted direction is `kg → foundation`, so the proof
 * sits on the KG side of the seam, where importing both the concrete handle and the
 * interface is exactly the allowed edge.
 *
 * The member set is measured, not guessed — over the whole tree the only members
 * ever reached on a `Database`-typed value are `execute` and `transaction`. The
 * dropped members are pinned here too: if a later change puts `insert` back "for
 * completeness", this file fails, because an interface member nobody calls is dead
 * configuration that every layer must still satisfy. That pin is static on purpose:
 * the concrete drizzle handle carries `insert` at runtime, and the claim being made
 * is about what the SEAM exposes, not about what the object has.
 *
 * Compile-level, not runtime, where it matters: proving the interface is satisfied
 * by a real handle is a type-level fact, and evaluating it at runtime would need a
 * live Postgres. The runtime assertion checks only that the handle the seam
 * describes really carries those members as functions; it opens no connection.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@repo/foundation";
import { createClient, createDatabase } from "./db.js";

/** A handle for a database nothing ever queries: constructing it opens no socket. */
const UNREACHABLE_URL = "postgres://llmwiki:llmwiki@127.0.0.1:5432/llmwiki";

/** The members the seam describes, in the order the measurement ranks them. */
const MEASURED_MEMBERS = ["execute", "transaction"] as const;

describe("DatabaseHandle", () => {
  it("is satisfied by a real drizzle handle and carries the measured members", async () => {
    const client = createClient(UNREACHABLE_URL);
    try {
      const handle: DatabaseHandle = createDatabase(client);
      for (const member of MEASURED_MEMBERS) {
        expect(typeof handle[member]).toBe("function");
      }
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it("types a statement and a transaction callback, and refuses a dropped member", () => {
    // Never called: the assertion is the fact that this body type-checks.
    const throughTheSeam = async (handle: DatabaseHandle): Promise<string | undefined> => {
      const rows = await handle.execute<{ id: string }>(sql`select 1 as id`);
      await handle.transaction(async (tx) => {
        await tx.execute(sql`select 2`);
      });
      // @ts-expect-error `insert` is never called on a Database, so the seam omits it.
      void handle.insert;
      return rows[0]?.id;
    };
    expect(typeof throughTheSeam).toBe("function");
  });
});
