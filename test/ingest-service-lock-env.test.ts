/**
 * @file test/ingest-service-lock-env.test.ts
 * @description T3 (S4): the ingest call site must hand the mutation lock the REQUEST's
 * environment, so the lock can be keyed by the Stack that request resolved.
 *
 * ## Why the lock helper is the seam here
 *
 * `test/ingest-mutation-lock-stack-env.test.ts` proves what the helper does with an
 * environment. This file proves the other half of the same contract: that
 * `writeToDimensions` — the one place every client's ingest passes through — GIVES it
 * the environment the request resolved instead of letting the lock fall back to the
 * process's. Standing in for the helper records the options the service supplies, which
 * is exactly the fact under test, and it keeps the file free of a database and of any
 * file the real ingest would write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestTextSource } from "../packages/wiki/src/services/ingest/service.js";
import { AKS_STACK_ID_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";

/** Options this suite's stand-in lock was handed; `undefined` means "no options at all". */
const handed = vi.hoisted(() => ({ calls: [] as Array<{ env?: NodeJS.ProcessEnv } | undefined> }));

vi.mock("../packages/wiki/src/utils/mutation-lock.js", () => ({
  // Not running the mutation: the question is what the service HANDS the lock, and
  // running it would drag in the dimensions port, a pool and the journal for no
  // extra evidence. The shape returned is the helper's own `unchanged` outcome.
  tryWithOrdinaryMutationLock: async (
    _root: string,
    _fn: () => Promise<unknown>,
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    handed.calls.push(options);
    return { busy: false as const, value: { artifactPath: "sources/stub.md", writeStatus: "unchanged" } };
  },
}));

const STACK = "stack-of-the-request";

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ingest-service-lock-env-")));
  handed.calls.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the ingest hands the request's environment to the mutation lock", () => {
  it("forwards the Stack the request resolved", async () => {
    await ingestTextSource(root, { title: "Note", text: "Body" }, {
      [AKS_STACK_ID_ENV_VAR]: STACK,
    });
    expect(handed.calls).toHaveLength(1);
    // The Stack travels in the environment, which is the convention every other
    // seam in this flow already uses (`buildIngestEnv`); the lock must see the same one.
    expect(handed.calls[0]?.env?.[AKS_STACK_ID_ENV_VAR]).toBe(STACK);
  });

  it("still hands no Stack to the lock for a caller that names none", async () => {
    const saved = process.env[AKS_STACK_ID_ENV_VAR];
    delete process.env[AKS_STACK_ID_ENV_VAR];
    try {
      await ingestTextSource(root, { title: "Note", text: "Body" });
      expect(handed.calls).toHaveLength(1);
      // Preserve: a caller with no Stack is NOT silently re-keyed.
      expect(handed.calls[0]?.env?.[AKS_STACK_ID_ENV_VAR]).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env[AKS_STACK_ID_ENV_VAR] = saved;
    }
  });
});
