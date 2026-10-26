/**
 * @file test/dimensions/profile-authority-removed.test.ts
 * @description A project can no longer have TWO profile authorities.
 *
 * ## What was here
 *
 * `profile-authority-rows.test.ts` pinned a real security property: when a product
 * BINDING and a legacy `profile.json` both existed, `loadProfile` had to fail closed with
 * `ProductAuthorityConflictError` rather than let one silently win. A present-but-unhealthy
 * binding had to raise `ActiveProductUnavailableError` instead of falling back to legacy.
 *
 * ## Why it is gone rather than adapted
 *
 * The product layer was removed. Nothing can create a binding, so neither conflict nor
 * unavailability is a reachable state: `resolveActiveProduct` reports `legacy` for every
 * project. Keeping the suite would mean testing a branch no input can reach.
 *
 * ## What still holds, and is asserted here
 *
 * The property that mattered was not "bindings are checked" but "the loader has exactly one
 * authority and never guesses". That survives in a simpler form, so the replacement test
 * checks it directly: resolution is always legacy, and a project with a profile still loads
 * it. If a binding implementation ever returns, this test fails and the conflict suite has
 * to come back with it.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { loadProfile } from "../../src/profile/load.js";

/** A root with a valid non-default profile installed. */
async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "auth-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(root, ".llmwiki", "profile.json"),
    JSON.stringify({ schemaVersion: 1, profileId: "team", entities: { note: { directory: "wiki/notes" } } }),
    "utf8",
  );
  return root;
}

describe("profile authority in a build with no product bindings", () => {
  it("always resolves to the legacy profile", async () => {
    // Not a permissive default: nothing in this build can produce a binding, so `legacy`
    // is the only state that exists. A `product` or `conflict` answer here would mean a
    // second authority came back without its conflict handling.
    expect(await resolveActiveProduct()).toEqual({ mode: "legacy" });
  });

  it("still loads the installed profile rather than the built-in default", async () => {
    const root = await profileRoot();
    try {
      // Records that the loader yields the INSTALLED profile's id, so trading the conflict
      // check for a silent default would be caught here.
      expect((await loadProfile(root)).profile.profileId).toBe("team");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
