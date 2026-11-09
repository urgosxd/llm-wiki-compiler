/**
 * @file test/compile-request-stack-lock.test.ts
 * @description S13: a compile locks the Stack its REQUESTS name, not the ambient one.
 *
 * ## The defect this pins
 *
 * `compileAndReport` builds its database handle from `options.env ?? process.env`, but it
 * used to acquire and release the mutation lock with no environment at all, so the
 * advisory lock key came from `process.env`'s Stack. A per-request host -- ONE process
 * serving MANY Stacks, a different `options.env` per request -- therefore wrote rows to
 * the Stack its options named while holding exclusion on the Stack the ambient
 * environment happened to carry. That is exclusion on the wrong key: two requests for one
 * Stack never contend, and two requests for two different Stacks do.
 *
 * ## Why the ambient assertion is the one that bites
 *
 * A test that only proves "the request's key is held" would still pass against a lock
 * taken on the WRONG key whenever the two ids coincide, and it is silent about the half
 * that matters -- the lookup a real per-request host depends on. So both halves are
 * asserted while the compile is genuinely inside its lock: the request's key must be
 * HELD, and the ambient key must be FREE. Without the second, a lock on the wrong key
 * passes.
 *
 * ## How the compile is held inside its lock, deterministically
 *
 * The provider extraction call is the barrier: it is awaited by the pipeline, which
 * runs inside the acquired lock (see `test/compile-concurrency.test.ts` for the same
 * spy seam). The stub signals when it has been reached and returns only once the test
 * releases it, so the held window is the compile's own and no sleep is involved. The
 * observability of the lock itself (`lock: acquired …`) is pinned in
 * `test/lock-observability.test.ts`; nothing here reads `lockRegistry` or any other
 * internal — the fixture's teardown does, to release a leaked entry.
 *
 * ## Why the AMBIENT Stack is provisioned rather than a bare uuid
 *
 * The index/MOC derived-artifact seam reads the ambient environment directly
 * (`src/compiler/indexgen.ts:63`, `src/compiler/obsidian.ts:128`), so a run whose
 * `options.env` names one Stack still renders its index under `process.env`'s. That is a
 * pre-existing leak of the same class, OUTSIDE this fix's surface and reported rather
 * than repaired here. It is why the ambient Stack exists for real: without it the
 * capture would fail on a foreign key and this file could not reach its own assertions.
 * The lock assertions below do not depend on it -- a `pg_try_advisory_lock` key needs no
 * row -- so provisioning it weakens nothing that is measured here.
 *
 * The Stack pair, the ambient environment binding and the teardown live in
 * `test/fixtures/request-stack.ts`, shared with the sibling request-stack suites.
 */

import { describe, expect, it, vi } from "vitest";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { tryAcquirePostgresLock } from "../packages/wiki/src/utils/lock-postgres.js";
import { REQUEST_STACK_DSN, useRequestStacks } from "./fixtures/request-stack.js";

/** The one source the compile extracts into a page. */
const SOURCE = {
  title: "Request Stack Topic",
  source: "https://request-stack-lock.test/topic",
  document: "# Request Stack Topic\n\nSource content for the request Stack.\n",
};

/** A promise plus the one-way trigger that settles it. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** Build a deferred whose trigger is idempotent. */
function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

/** A compile held at its provider call, and the trigger that lets it continue. */
interface ExtractionBarrier {
  /** Settles once the compile has entered the extraction call — i.e. holds the lock. */
  readonly reached: Promise<void>;
  /** Let the held compile finish. */
  release(): void;
}

/** Stub the provider so the compile parks inside extraction, lock held, on demand. */
function holdExtraction(): ExtractionBarrier {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  const entered = deferred();
  const released = deferred();
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async () => {
    entered.resolve();
    await released.promise;
    return JSON.stringify({
      concepts: [{ concept: "Request Stack Topic", summary: "S.", is_new: true }],
    });
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body. ^[topic.md]\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { reached: entered.promise, release: () => released.resolve() };
}

/**
 * Whether `key` is currently held elsewhere, leaving the key exactly as it was found.
 *
 * A free key is taken and IMMEDIATELY released, so probing cannot turn into the very
 * contention the caller is measuring.
 */
async function isKeyHeldElsewhere(key: string): Promise<boolean> {
  const held = await tryAcquirePostgresLock(REQUEST_STACK_DSN, key);
  if (held === null) return true;
  await held.release();
  return false;
}

describe("a compile locks the Stack its request names", () => {
  const stacks = useRequestStacks({
    request: "request-stack-lock",
    ambient: "ambient-stack-lock",
    root: "request-stack-lock-",
  });

  it("holds the request's key and leaves the ambient key free, then frees both", async () => {
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    const extraction = holdExtraction();

    const compileRun = compileAndReport(stacks.root, { embeddings: false, env: stacks.env });
    await extraction.reached;

    expect(await isKeyHeldElsewhere(stacks.requestStackId)).toBe(true);
    expect(await isKeyHeldElsewhere(stacks.ambientStackId)).toBe(false);

    extraction.release();
    expect(await compileRun).toMatchObject({ errors: [] });

    expect(await isKeyHeldElsewhere(stacks.requestStackId)).toBe(false);
    expect(await isKeyHeldElsewhere(stacks.ambientStackId)).toBe(false);
  });

  it("still locks the ambient Stack for a caller that passes no environment", async () => {
    process.env.AKS_STACK_ID = stacks.requestStackId;
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    const extraction = holdExtraction();

    const compileRun = compileAndReport(stacks.root, { embeddings: false });
    await extraction.reached;

    expect(await isKeyHeldElsewhere(stacks.requestStackId)).toBe(true);

    extraction.release();
    expect(await compileRun).toMatchObject({ errors: [] });
    expect(await isKeyHeldElsewhere(stacks.requestStackId)).toBe(false);
  });
});
