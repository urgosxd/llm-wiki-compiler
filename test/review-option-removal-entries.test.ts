/**
 * @file test/review-option-removal-entries.test.ts
 * @description Durable coverage for the compile entries the `review` guard reaches
 * indirectly. `compileDelta` forwards its options straight to `compileAndReport`, and
 * the SDK's `compile` spreads them through a wrapper that never turns a reported error
 * into a failure. A guard placed one level too high — at `compile` instead of at the
 * pipeline entry every surface funnels through — would still pass the companion file
 * (`test/review-option-removal.test.ts`) while leaking a silently-ignored option at
 * these two surfaces, so both are pinned here, together with "the refusal does no
 * work" and "presence, not truthiness".
 *
 * Query carries a DISTINCT `review` field with its own guard (`Query review requires
 * save.`); it is not this option and is not covered here.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileDelta } from "../packages/wiki/src/compiler/delta.js";
import { createWiki } from "../packages/wiki/src/sdk/wiki.js";
import { useManagedTempRoots } from "./fixtures/temp-root.js";

/**
 * The one message the removed option produces, character for character.
 *
 * Equality, not a substring: the removal is final, so the wording callers quote back
 * is part of the contract and a reworded guard must fail this file.
 */
const REMOVED_MESSAGE =
  "The review compile option no longer exists: no surface promotes a held candidate, "
  + "and the option will not come back. Remove it from your call.";

const roots = useManagedTempRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the removed review option is refused at every compile entry", () => {
  it("rejects from compileDelta without writing anything", async () => {
    const root = await roots.tempRoot("review-removed-delta");
    await mkdir(path.join(root, "sources"), { recursive: true });
    await writeFile(path.join(root, "sources/a.md"), "# A\n\nSome text.\n");
    const listingBefore = (await readdir(root)).sort();

    await expect(compileDelta(root, { review: true } as never))
      .rejects.toThrow(new Error(REMOVED_MESSAGE));

    expect(existsSync(path.join(root, ".llmwiki"))).toBe(false);
    expect((await readdir(root)).sort()).toEqual(listingBefore);
  });

  it("rejects at the SDK compile surface instead of resolving silently", async () => {
    const root = await roots.tempRoot("review-removed-sdk");
    // The SDK checks credentials before it reaches the compile pipeline, so the guard
    // is only observable past that check. The dummy key is never spent: the guard
    // fires before any provider work, so no request leaves the process.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-review-removal-test-not-a-key");
    const wiki = createWiki({ root });

    // WHY a throw and not a result: `compile` resolves when nothing throws and
    // discards the compile result, so a guard that merely returned an error would
    // look like success at this surface. Only a rejection is observable here.
    await expect(wiki.compile({ review: true, embeddings: false } as never))
      .rejects.toThrow(new Error(REMOVED_MESSAGE));

    expect(existsSync(path.join(root, ".llmwiki"))).toBe(false);
  });

  it("rejects the option's presence even when its value is false", async () => {
    const root = await roots.tempRoot("review-removed-present");

    await expect(compileDelta(root, { review: false } as never))
      .rejects.toThrow(new Error(REMOVED_MESSAGE));

    expect(existsSync(path.join(root, ".llmwiki"))).toBe(false);
  });
});
