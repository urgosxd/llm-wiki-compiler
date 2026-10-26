/**
 * @file test/dimensions/profile-authority-rows.test.ts
 * @description A profile ROW competes with a product binding exactly like a file does.
 *
 * ## Why this test exists
 *
 * `resolveActiveProduct` fails closed when a product binding and a project profile
 * COEXIST: neither authority wins. That check was `profileJsonPresent(root)`, which
 * `lstat`ed the file.
 *
 * Moving the profile into a row without touching that check would have been a
 * SECURITY REGRESSION wearing a storage migration's clothes: a Stack with a binding
 * and a profile-row would have stopped being a conflict, and product mode would have
 * won silently. The fix asks both backends, and this file is what proves it.
 *
 * No `profile.json` is ever created here — that is the whole point. If the check still
 * only looked at the file, these cases would resolve to `product` instead of `conflict`.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProfile } from "../../src/profile/load.js";
import { profileDigest } from "../../src/profile/digest.js";
import { ProductAuthorityConflictError } from "../../src/products/binding/problems.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { writeActiveProductBinding } from "../../src/products/binding/store.js";
import { withProfileSource } from "../../src/dimensions/wiki/profile-source.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { withStackEnv } from "../fixtures/stack-env.js";
import { bindingFor, buildProfileOnlyProduct, commitBuilt } from "../products/binding-fixture.js";
import type { ProfilePack } from "../../src/profile/types.js";

/** A valid installable profile; "default" is reserved by the validator. */
const INSTALLED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "team",
  displayName: "Team",
  entities: { docs: { directory: "wiki/docs", fields: { title: { type: "string" } } } },
};

/** Commit and activate a healthy product binding in `dir`. */
async function activateHealthyBinding(dir: string): Promise<void> {
  const product = buildProfileOnlyProduct();
  await commitBuilt(dir, product);
  await writeActiveProductBinding(dir, bindingFor(product.manifest));
}

/** Provision a fresh project root plus a Stack. */
async function withProject(label: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await withStackEnv(label, () => body(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("profile authority with rows", () => {
  it("resolves to conflict when a binding and a profile ROW coexist", () =>
    withProject("authority-conflict", async (dir) => {
      await activateHealthyBinding(dir);
      await withProfileSource(process.env, async (source) => {
        await source!.save(INSTALLED_PROFILE, profileDigest(INSTALLED_PROFILE));
      });

      expect(await resolveActiveProduct(dir)).toEqual({ mode: "conflict" });
    }));

  it("fails closed loading the effective profile under that conflict", () =>
    withProject("authority-closed", async (dir) => {
      await activateHealthyBinding(dir);
      await withProfileSource(process.env, async (source) => {
        await source!.save(INSTALLED_PROFILE, profileDigest(INSTALLED_PROFILE));
      });

      await expect(loadProfile(dir)).rejects.toBeInstanceOf(ProductAuthorityConflictError);
    }));

  it("stays legacy mode when a profile row is present with no binding", () =>
    withProject("authority-legacy", async (dir) => {
      await withProfileSource(process.env, async (source) => {
        await source!.save(INSTALLED_PROFILE, profileDigest(INSTALLED_PROFILE));
      });

      // The conflict is specifically CO-PRESENCE, not the profile alone.
      expect(await resolveActiveProduct(dir)).toEqual({ mode: "legacy" });
      expect(existsSync(path.join(dir, PROFILE_FILE))).toBe(false);
    }));
});
