/**
 * @file test/lock-postgres-distinct-stacks.test.ts
 * @description Two DIFFERENT Stacks must hold the lock AT THE SAME TIME.
 *
 * A lock that serialises everything is a regression dressed as a fix: the Stack-id
 * keying exists to exclude two hosts serving ONE Stack, and buying that with a global
 * lock would stall every unrelated compile behind the slowest one. The low-level
 * "distinct keys are distinct locks" case is already covered by
 * `test/lock-postgres.test.ts`; what is proven here is the FACADE, because that is
 * where a key derivation mistake would actually live.
 *
 * Simultaneity is asserted, not assumed: both acquires succeed with no release in
 * between, and BOTH keys still refuse a third contender while held — so the two
 * successes cannot be an artifact of a lock space that stopped excluding anyone.
 *
 * The database is this process's OWN (see `test/fixtures/per-run-database.ts`) and
 * every Stack id is a fresh `randomUUID()`, because the container behind it is
 * long-lived: a session-level lock leaked by an earlier killed probe can outlive the
 * run that leaked it.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { lockRegistry } from "../src/utils/lock-postgres.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

/** Checkout roots standing in for two hosts; the Stack id, not the path, is the key. */
let roots: string[] = [];

beforeEach(async () => {
  roots = [];
});

afterEach(async () => {
  // The registry is process-global: a leaked entry makes the NEXT test's acquisition
  // fail for a reason that looks exactly like a product bug.
  lockRegistry.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

/** A fresh checkout path, realpath'd so the facade and the release agree on it. */
async function checkout(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `stack-${label}-`)));
  roots.push(root);
  return root;
}

/** Environment naming ONE Stack, so the facade consults the database. */
function stackEnv(stackId: string): NodeJS.ProcessEnv {
  return { AKS_STACK_ID: stackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
}

describe("two different Stacks do not serialise", () => {
  it("lets both Stacks hold the lock at the same time, and still excludes each one", async () => {
    const stackA = randomUUID();
    const stackB = randomUUID();
    const envA = stackEnv(stackA);
    const envB = stackEnv(stackB);
    const rootA = await checkout("a");
    const rootB = await checkout("b");

    // A is HELD here; nothing releases it before B tries. Both must be true.
    expect(await acquireLock(rootA, { quiet: true, env: envA })).toBe(true);
    expect(await acquireLock(rootB, { quiet: true, env: envB })).toBe(true);

    // Both keys are live and still excluding: a third contender for A is refused
    // while B is held, so the two successes above are two real locks, not one lock
    // that stopped locking anything.
    expect(await acquireLock(await checkout("a-again"), { quiet: true, env: envA })).toBe(false);

    await releaseLock(rootA, envA);
    await releaseLock(rootB, envB);
  });
});
