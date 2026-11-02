/**
 * @file test/fixtures/artifact-root.ts
 * @description A temp project root carrying a NON-DEFAULT profile, for suites
 * that need "an active profile that is not the built-in default".
 *
 * This fixture used to declare an `experiment-result` artifact type and seed
 * artifact bytes through the trust executor. The artifact subsystem was
 * removed, so both of those jobs are gone. What survives is the one thing a
 * live consumer actually needs: `sdk/domain-read.test.ts` asserts that
 * `loadNonDefaultProfile` binds a custom profile and that
 * `activeProfileDigest` reflects it — neither of which cares about artifacts.
 *
 * The `artifacts` block is deliberately absent rather than emptied: a profile
 * declaring no artifact types is the shape every project has now, so a test
 * built on this fixture exercises the same profile the product produces.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./temp-root.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import type { ProfilePack } from "../../src/profile/types.js";

/** One `note` entity at its canonical directory — a minimal non-default pack. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "non-default-fixture",
  entities: {
    note: { directory: "wiki/notes" },
  },
};

/**
 * Create a fresh temp project root with `.llmwiki/profile.json` declaring a
 * non-default profile (see {@link PROFILE}).
 *
 * @param prefix - Short label folded into the temp directory name.
 * @returns Absolute path to the materialized project root.
 */
export async function makeResearchLikeRoot(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(PROFILE, null, 2)}\n`, "utf8");
  return root;
}
