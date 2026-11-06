/**
 * @file Isolated temp project roots for the category suites.
 *
 * Every category case writes real files through the trust seam, so it needs a real
 * project root and must leave nothing behind. Both halves live here so the three
 * category suites cannot drift into three slightly different cleanups: a root is
 * created OUTSIDE the worktree (under the system temp dir), tracked by the fixture,
 * and removed by the teardown that calls {@link CategoryTempRoots.cleanup}.
 */

import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";

/** A tracked factory of throwaway project roots. */
export interface CategoryTempRoots {
  /** Create a fresh, isolated project root and track it for removal. */
  tempRoot(): Promise<string>;
  /** Remove every root created so far. Call once from `afterEach`. */
  cleanup(): Promise<void>;
}

/**
 * Build a fresh tracker. Each suite gets its own instance so one suite's teardown
 * cannot remove a root another suite is still using.
 *
 * @returns The tracker.
 */
export function categoryTempRoots(): CategoryTempRoots {
  const roots: string[] = [];
  return {
    async tempRoot(): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-categories-"));
      roots.push(root);
      return root;
    },
    async cleanup(): Promise<void> {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    },
  };
}
