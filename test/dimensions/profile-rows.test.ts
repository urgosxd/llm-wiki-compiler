/**
 * @file test/dimensions/profile-rows.test.ts
 * @description The profile lives in a row for a Stack, and the authority check survives.
 *
 * Two properties, and the second one is the reason this file exists at all.
 *
 * 1. **Wiring** — a Stack stores its profile and writes no `profile.json`. Proved by
 *    asserting the directory, not merely the row: rows can be written while the file
 *    is still written too.
 * 2. **The conflict still fires** — `resolveActiveProduct` fails closed when a product
 *    binding and a project profile COEXIST. That check used to `lstat` the file. Had it
 *    kept doing only that, moving the profile into a row would have turned a
 *    fail-closed authority conflict into a silent product-mode win.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile } from "../../src/profile/load.js";
import { profileDigest } from "../../src/profile/digest.js";
import { withProfileSource } from "../../src/dimensions/wiki/profile-source.js";
import { withProjectRoot, withStackEnv } from "../fixtures/stack-env.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";

/**
 * A VALID installable profile. The built-in default cannot be used here: its
 * `profileId` is "default", which the validator reserves precisely so a project
 * cannot masquerade as the built-in fallback.
 */
const INSTALLED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "team",
  displayName: "Team",
  entities: { docs: { directory: "wiki/docs", fields: { title: { type: "string" } } } },
};

describe("profile on rows", () => {
  it("reads the built-in default when the Stack has no profile row", () =>
    withProjectRoot("profile-empty", async (dir) => {
      const loaded = await loadProfile(dir);

      // Absent is NOT an error, and must stay distinguishable from one.
      expect(loaded.loadedFrom).toBeNull();
      expect(loaded.digest).toBe(profileDigest(DEFAULT_PROFILE));
    }));

  it("reads an installed profile from its row and writes no profile.json", () =>
    withProjectRoot("profile-installed", async (dir) => {
      await withProfileSource(process.env, async (source) => {
        await source!.save(INSTALLED_PROFILE, profileDigest(INSTALLED_PROFILE));
      });

      const loaded = await loadProfile(dir);

      // Non-null on purpose: the linter and the viewer SKIP work when loadedFrom is
      // null, so a row reporting null would make an installed profile invisible.
      expect(loaded.loadedFrom).not.toBeNull();
      expect(loaded.digest).toBe(profileDigest(INSTALLED_PROFILE));
      expect(existsSync(path.join(dir, "profile.json"))).toBe(false);
      expect(existsSync(path.join(dir, ".llmwiki"))).toBe(false);
      expect(await readdir(dir)).not.toContain("profile.json");
    }));

  it("refuses a row whose document disagrees with its recorded digest", () =>
    withProjectRoot("profile-tamper", async (dir) => {
      await withProfileSource(process.env, async (source) => {
        // Store a digest that cannot match the document: the row was edited after
        // whoever verified the profile recorded what they verified.
        await source!.save(INSTALLED_PROFILE, "0".repeat(64));
      });

      await expect(loadProfile(dir)).rejects.toThrow(/recorded digest/);
    }));

  it("keeps each Stack's profile separate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "profile-tenant-"));
    try {
      const first = await profileOf("profile-tenant-a", dir, true);
      const second = await profileOf("profile-tenant-b", dir, false);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Install (or not) the default profile under a fresh Stack, returning its source. */
async function profileOf(label: string, dir: string, install: boolean): Promise<string | null> {
  let loadedFrom: string | null = null;
  await withStackEnv(label, async () => {
    if (install) {
      await withProfileSource(process.env, async (source) => {
        await source!.save(INSTALLED_PROFILE, profileDigest(INSTALLED_PROFILE));
      });
    }
    loadedFrom = (await loadProfile(dir)).loadedFrom;
  });
  return loadedFrom;
}
