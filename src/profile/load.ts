/**
 * @file The project's profile, which is now a CONSTANT.
 *
 * This module used to be a fail-closed, binding-aware loader: it classified the
 * runtime mode, read a Stack row or `.llmwiki/profile.json`, validated the
 * document against an ajv schema, and content-addressed the result. Every one of
 * those steps existed to answer "which profile is installed", and that question
 * no longer has more than one answer — a wiki has `concepts` and `queries`, they
 * live at fixed directories, and nothing is declarable about them.
 *
 * What survives is the OBSERVATION half, which callers still legitimately need:
 * a profile object, its digest, and a `loadedFrom` marker. `loadedFrom` is `null`
 * because there is no file or row to name, and callers that treated `null` as
 * "the built-in default" — the linter and the viewer skip profile-only work on it
 * — are exactly right now.
 *
 * A reader looking for "how do I configure a project" should stop looking: the
 * answer is the Stack id, and everything else is a constant in `default.ts`.
 */

import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import type { LoadedProfile } from "./types.js";


/** The one profile a project has, with its content-address. */
function loadedProfile(): LoadedProfile {
  return {
    profile: DEFAULT_PROFILE,
    loadedFrom: null,
    digest: profileDigest(DEFAULT_PROFILE),
  };
}

/**
 * The project's profile.
 *
 * The `root` parameter is retained deliberately: callers pass it today and a
 * future reader may need it, but nothing about the answer depends on it.
 *
 * @param _root - Absolute project root directory (unused).
 * @returns The one profile, its `loadedFrom` marker and its digest.
 */
export async function loadProfile(_root: string): Promise<LoadedProfile> {
  return loadedProfile();
}

/**
 * The canonical DIGEST of the project's profile — the content-address a host may
 * record to confirm which configuration it verified against.
 *
 * @param root - Absolute project root directory.
 * @returns Lowercase hex SHA-256 of the canonical profile form.
 */
export async function activeProfileDigest(root: string): Promise<string> {
  return (await loadProfile(root)).digest;
}
