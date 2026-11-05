/**
 * Advisory-lock semantics against a real Postgres.
 *
 * The properties here are the ones the file lock provided and a session-scoped
 * advisory lock can silently lose: mutual exclusion between independent
 * connections, reacquisition after release, and independence between keys.
 *
 * The database is this process's OWN (see `test/fixtures/per-run-database.ts`).
 * Advisory locks are database-scoped — measured: two sessions in two databases both
 * acquire `pg_try_advisory_lock` on the same key — so a private database makes the
 * lock space private too. That strengthens nothing about the key and weakens nothing
 * about the claim: both holders below pass the same DSN, so what is proven is that two
 * sessions against ONE database contend, which is the production shape (two hosts
 * sharing one Stack's database). What it removes is shared mutable state: no other
 * suite can hold, leak, or release a key in here. Cross-process visibility is proven
 * separately by `lock-postgres-crossprocess.test.ts`, which hands its DSN to a child.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryAcquirePostgresLock } from "../src/utils/lock-postgres.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { expectPerRunDatabase } from "./fixtures/per-run-database-assertions.js";

/**
 * This process's own database, provisioned before collection.
 *
 * No skip predicate. The old `DSN !== ""` check was a tautology — `testDatabaseUrl()`
 * never returns `""` (its contract is pinned by `test/test-database-fixture.test.ts`) —
 * so it could only ever have skipped by accident, and a suite that silently skips
 * proves nothing. Provisioning either succeeds or throws with the reason.
 */
const DSN = (await perRunDatabase()).url;

describe("advisory lock", () => {
  it("excludes a second holder of the same key", async () => {
    const key = `/probe/${randomUUID()}`;
    const first = await tryAcquirePostgresLock(DSN, key);
    const second = await tryAcquirePostgresLock(DSN, key);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first?.release();
  });

  it("allows reacquisition once the holder releases", async () => {
    // The property a pooled connection would silently destroy: if the unlock ran on
    // another session it would release nothing and this would stay null forever.
    const key = `/probe/${randomUUID()}`;
    const first = await tryAcquirePostgresLock(DSN, key);
    await first?.release();
    const second = await tryAcquirePostgresLock(DSN, key);

    expect(second).not.toBeNull();
    await second?.release();
  });

  it("treats distinct keys as distinct locks", async () => {
    const a = await tryAcquirePostgresLock(DSN, `/probe/${randomUUID()}`);
    const b = await tryAcquirePostgresLock(DSN, `/probe/${randomUUID()}`);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a?.release();
    await b?.release();
  });

  it("runs against a database of its own, not the shared one", () => {
    // Advisory locks are database-scoped, so this suite locking the shared database
    // buys no isolation at all: a private database is the proof's premise.
    expectPerRunDatabase(DSN);
  });

  it("releases twice without throwing", async () => {
    // Cleanup paths tolerate a double release today; a closed connection must not
    // turn that into a crash.
    const held = await tryAcquirePostgresLock(DSN, `/probe/${randomUUID()}`);
    await held?.release();
    await expect(held?.release()).resolves.toBeUndefined();
  });
});
