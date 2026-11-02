/**
 * @file test/dimensions/profile-authority-removed.test.ts
 * @description The loader has exactly ONE authority and never guesses.
 *
 * ## What was here
 *
 * `profile-authority-rows.test.ts` pinned a real security property: when a product
 * BINDING and a legacy `profile.json` both existed, `loadProfile` had to fail closed
 * with `ProductAuthorityConflictError` rather than let one silently win. A
 * present-but-unhealthy binding had to raise `ActiveProductUnavailableError` instead
 * of falling back to legacy.
 *
 * ## Why it is gone rather than adapted
 *
 * The product layer was removed and so was its resolution function. `resolveActiveProduct`
 * returned `{ mode: "legacy" }` for every project, which made `conflict`, `product` and
 * `unavailable` unreachable — the dispatch over four modes resolved to one. Asserting
 * "resolution is always legacy" would now assert that a deleted function returns nothing,
 * so that case is gone too; it was evidence for a decision, not a property worth keeping.
 *
 * ## What still holds, and is asserted here
 *
 * The property that mattered was never "bindings are checked". It was "the loader yields
 * the profile that is actually installed, and never silently trades it for the built-in
 * default". With one authority left, that is what a regression would now look like: a
 * present `profile.json` quietly ignored, and every reader acting as if the project were
 * unconfigured. So this asserts the installed id comes back.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it("still loads the installed profile rather than the built-in default", async () => {
    const root = await profileRoot();
    try {
      // Records that the loader yields the INSTALLED profile's id, so trading the
      // one-authority rule for a silent default would be caught here.
      expect((await loadProfile(root)).profile.profileId).toBe("team");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the installed file as the source, not the built-in default", async () => {
    const root = await profileRoot();
    try {
      // `loadedFrom === null` means "built-in default" to four callers (the linter and
      // the viewer skip their work entirely on it), so a null here would make an
      // installed profile invisible to them.
      const loaded = await loadProfile(root);
      expect(loaded.loadedFrom).toContain("profile.json");
      expect(loaded.digest).not.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
