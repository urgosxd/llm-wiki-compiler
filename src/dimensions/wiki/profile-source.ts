/**
 * @file src/dimensions/wiki/profile-source.ts
 * @description The profile seam: rows for a Stack, `profile.json` for a project.
 *
 * ## The one thing this must not break
 *
 * `resolveActiveProduct` decides whether a product binding and a legacy profile
 * COEXIST, and coexistence is a fail-closed `ProductAuthorityConflictError` -- neither
 * authority wins. That check used `profileJsonPresent(root)`, which `lstat`s the file.
 *
 * Moving the profile into a row and leaving that check alone would have been a
 * security regression disguised as a migration: a Stack with a binding AND a
 * profile-row would have stopped being a conflict, and product mode would have won
 * silently. So {@link profileExistsAnywhere} asks BOTH backends. It is deliberately
 * "present anywhere" and not "present in the active backend", because the question is
 * about competing AUTHORITIES, not about which one this process currently reads.
 */

import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import { readProfile, saveProfile, type StoredProfileRow } from "./profile-store.js";

/** The Stack this run is bound to, or undefined when the environment names none. */
function profileStackId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/** Store and read one Stack's profile. */
export interface ProfileSource {
  /** Store the profile, replacing any prior one. */
  save(document: unknown, digest: string): Promise<void>;
  /** The stored profile, or undefined when this Stack has none. */
  read(): Promise<StoredProfileRow | undefined>;
}

/**
 * Run `fn` with this Stack's profile, or with `undefined` when none is configured.
 *
 * @param env - Environment naming the Stack.
 * @param fn - Receives the profile handle, or undefined for a file-backed project.
 * @returns Whatever `fn` returns.
 */
export async function withProfileSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: ProfileSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = profileStackId(env);
  if (stackId === undefined) return fn(undefined);
  const handle = createDimensionsDatabase(env);
  try {
    return await fn({
      save: (document, digest) => saveProfile(handle.db, stackId, document, digest),
      read: () => readProfile(handle.db, stackId),
    });
  } finally {
    await handle.close();
  }
}

/**
 * Whether a profile exists in ANY backend for this project.
 *
 * Used only to detect a competing authority, never to decide what to read. A project
 * with a file and a Stack that also has a row is a conflict the caller must surface,
 * not a situation where one silently wins.
 *
 * @param env - Environment naming the Stack.
 * @param filePresent - Whether the legacy `profile.json` exists.
 * @returns True when either backend holds a profile.
 */
export async function profileExistsAnywhere(
  env: NodeJS.ProcessEnv,
  filePresent: boolean,
): Promise<boolean> {
  if (filePresent) return true;
  return withProfileSource(env, async (source) =>
    source === undefined ? false : (await source.read()) !== undefined,
  );
}

export type { StoredProfileRow };
