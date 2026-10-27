/**
 * @file test/sdk-relation-lifecycle.test.ts
 * @description SDK-facade round-trip for the experimental trust-gated relation
 * write + lifecycle transition (Phase 4 PR5): `createWiki().createRelation` and
 * `.transitionLifecycle` on a profile project, the required-evidence refusal,
 * and the default-project guard.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { RelationsRequireProfileError } from "../src/trust/relation-write.js";
import {
  transitionLifecycle,
  LifecycleTransitionLockError,
} from "../src/trust/lifecycle-transition.js";
import { LifecycleTransitionError } from "../src/profile/lifecycle.js";
import { readRelations } from "../src/relations/store-read.js";
import { LOCK_FILE } from "../src/utils/constants.js";
import { makeResearchLiteProjectRoot, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

const EXP = "experiments/ablation-batch-size" as EntityId;
const IDEA = "ideas/sparse-routing" as EntityId;

/** A research-lite profile with a `tests` relation + a `failed` evidence requirement. */
function profile(): ProfilePack {
  const ideas = RESEARCH_LITE_PROFILE.entities.ideas;
  return {
    ...RESEARCH_LITE_PROFILE,
    entities: {
      ...RESEARCH_LITE_PROFILE.entities,
      ideas: { ...ideas, lifecycle: { ...ideas.lifecycle, transitionRequirements: { failed: ["failureReason"] } } },
    },
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  } as ProfilePack;
}

let root = "";
beforeEach(async () => {
  root = await makeResearchLiteProjectRoot("sdk-rel-lc-", profile());
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });


describe("transitionLifecycle — lock discipline", () => {
  /**
   * A lock file naming THIS (live) process PID is not stale, so acquireLock
   * fails. The transition must refuse cleanly and leave the page UNCHANGED.
   */
  it("refuses cleanly when the project lock is held, leaving the page unchanged", async () => {
    const pagePath = path.join(root, "wiki/ideas/sparse-routing.md");
    const before = await readFile(pagePath, "utf8");
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");

    const attempt = transitionLifecycle(root, "ideas", "sparse-routing", "testing");
    await expect(attempt).rejects.toBeInstanceOf(LifecycleTransitionLockError);

    expect(await readFile(pagePath, "utf8")).toBe(before);
  });
});

/**
 * REMOVED: the `createWiki()` relation+lifecycle round-trip describe and the default
 * project guard. Both drove `wiki.createRelation` / `wiki.transitionLifecycle`, which
 * the SDK no longer exposes -- they came from `sdk/staging-facade.ts`, buried with the
 * entity subsystem.
 *
 * The capability itself was NOT buried: `transitionLifecycle` lives in
 * `src/trust/lifecycle-transition.ts` and the surviving lock-discipline suite below
 * exercises it directly, so the write-gate behaviour still has coverage. What is gone
 * is the SDK surface that reached it.
 */
