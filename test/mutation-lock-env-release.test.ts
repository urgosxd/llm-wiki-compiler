/**
 * @file test/mutation-lock-env-release.test.ts
 * @description S5 for the caller whose `options.env` is NOT the process's environment:
 * the recovery gate's refusal path must release the lock that caller took.
 *
 * ## The defect this pins
 *
 * `acquireMutationLock` / `acquireMutationLockBlocking` key their Postgres lock on
 * `options.env`'s Stack (`src/utils/lock.ts:lockKeyFor`), but `gateOrRelease` released
 * with `releaseLock(root)`, i.e. under `process.env`'s Stack. `releaseLock` looks the
 * held connection up in `lockRegistry` by the key IT derives, so for any caller whose
 * environment names a different Stack the lookup missed and the release fell through to
 * the file path — where there is no file lock, because the database decided. The
 * refusal then threw with the session-level advisory lock STILL HELD on the reserved
 * connection, blocking every later compile of that Stack until the process died.
 *
 * ## Why a refusal and not a thrown mutation
 *
 * The gate's refusal is the one failure path that releases the lock *inside*
 * `mutation-lock.ts` (the `finally` blocks in `withOrdinaryMutationLock` and the
 * compile pipeline are elsewhere and already carry the env they acquired with). A
 * symlinked journal is the production refusal: `recoverJournalBeforeCompile` classifies
 * it `unsafe`, so the gate releases and throws `JournalUnsafeError` without touching a
 * page.
 *
 * ## Why every key is a fresh `randomUUID()`
 *
 * The database behind these tests is this process's own (see
 * `test/fixtures/per-run-database.ts`), but the container is long-lived: a
 * session-level advisory lock leaked by an earlier probe outlives the run that leaked
 * it, and a shared key would let that leak masquerade as this file's defect.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../packages/wiki/src/utils/lock.js";
import { lockRegistry } from "../packages/wiki/src/utils/lock-postgres.js";
import { acquireMutationLock, acquireMutationLockBlocking } from "../packages/wiki/src/utils/mutation-lock.js";
import { JournalUnsafeError } from "../packages/wiki/src/trust/journal-recovery.js";
import { LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

let root = "";
let outside = "";
const savedEnv = { stackId: process.env.AKS_STACK_ID, dsn: process.env.AKS_DATABASE_URL };

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lock-env-release-")));
});

afterEach(async () => {
  // Release before clearing: a leaked entry is a live reserved connection holding a
  // session-level lock, and dropping the handle without unlocking would leave it held
  // for the life of the process.
  for (const held of lockRegistry.values()) await held.release().catch(() => {});
  lockRegistry.clear();
  for (const [name, value] of [["AKS_STACK_ID", savedEnv.stackId], ["AKS_DATABASE_URL", savedEnv.dsn]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
  if (outside !== "") await rm(outside, { recursive: true, force: true });
  outside = "";
});

/** A Stack environment with a fresh identity, so a leaked key cannot block this run. */
function stackEnv(): { env: NodeJS.ProcessEnv; stackId: string } {
  const stackId = randomUUID();
  return { env: { AKS_STACK_ID: stackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv, stackId };
}

/** Make the journal symlink OUTSIDE the root, which is the gate's `unsafe` refusal. */
async function makeJournalUnsafe(): Promise<void> {
  outside = await mkdtemp(path.join(tmpdir(), "lock-env-release-journal-"));
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await symlink(outside, path.join(root, LLMWIKI_DIR, "journal"), "dir");
}

/** True when the Stack named by `env` can be taken right now. */
async function stackIsFree(env: NodeJS.ProcessEnv): Promise<boolean> {
  const acquired = await acquireLock(root, { quiet: true, env });
  if (acquired) await releaseLock(root, env);
  return acquired;
}

describe("the gate's refusal releases the lock the CALLER took", () => {
  it("frees the caller's Stack when options.env differs from process.env", async () => {
    const caller = stackEnv();
    const ambient = stackEnv();
    // The process serves a DIFFERENT Stack: this is the shape a per-request host runs
    // in, and the shape that made the release miss the registry entry.
    process.env.AKS_STACK_ID = ambient.stackId;
    process.env.AKS_DATABASE_URL = DSN;
    await makeJournalUnsafe();

    await expect(
      acquireMutationLock(root, "ordinary", { env: caller.env }),
    ).rejects.toBeInstanceOf(JournalUnsafeError);

    // The whole rule: the refused attempt must not leave the Stack locked. Before the
    // fix this is false, because the release asked the registry for the AMBIENT Stack.
    expect(await stackIsFree(caller.env)).toBe(true);
  });

  it("frees the caller's Stack when the BLOCKING gate refuses and options.env differs", async () => {
    const caller = stackEnv();
    const ambient = stackEnv();
    process.env.AKS_STACK_ID = ambient.stackId;
    process.env.AKS_DATABASE_URL = DSN;
    await makeJournalUnsafe();

    await expect(
      acquireMutationLockBlocking(root, "ordinary", { env: caller.env }),
    ).rejects.toBeInstanceOf(JournalUnsafeError);

    expect(await stackIsFree(caller.env)).toBe(true);
  });
});

describe("the release keeps working for the caller that passes no env", () => {
  it("frees the ambient Stack after a refusal, exactly as before", async () => {
    const ambient = stackEnv();
    process.env.AKS_STACK_ID = ambient.stackId;
    process.env.AKS_DATABASE_URL = DSN;
    await makeJournalUnsafe();

    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(JournalUnsafeError);

    expect(await stackIsFree(ambient.env)).toBe(true);
  });

  it("frees the ambient Stack after a blocking refusal, exactly as before", async () => {
    const ambient = stackEnv();
    process.env.AKS_STACK_ID = ambient.stackId;
    process.env.AKS_DATABASE_URL = DSN;
    await makeJournalUnsafe();

    await expect(acquireMutationLockBlocking(root, "ordinary")).rejects.toBeInstanceOf(JournalUnsafeError);

    expect(await stackIsFree(ambient.env)).toBe(true);
  });
});
