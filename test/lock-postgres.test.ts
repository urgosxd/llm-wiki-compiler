/**
 * Advisory-lock semantics against a real Postgres.
 *
 * The properties here are the ones the file lock provided and a session-scoped
 * advisory lock can silently lose: mutual exclusion between independent
 * connections, reacquisition after release, and independence between keys.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryAcquirePostgresLock } from "../src/utils/lock-postgres.js";
import { testDatabaseUrl } from "./fixtures/test-database.js";

const DSN = testDatabaseUrl();
const reachable = DSN !== "";
const suite = reachable ? describe : describe.skip;

suite("advisory lock", () => {
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

  it("releases twice without throwing", async () => {
    // Cleanup paths tolerate a double release today; a closed connection must not
    // turn that into a crash.
    const held = await tryAcquirePostgresLock(DSN, `/probe/${randomUUID()}`);
    await held?.release();
    await expect(held?.release()).resolves.toBeUndefined();
  });
});
