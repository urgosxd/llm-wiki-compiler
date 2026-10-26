/**
 * @file src/dimensions/wiki/template-lock-source.ts
 * @description The row-backed advisory template lock, resolved the same way the profile is.
 *
 * ## Why this mirrors `profile-source.ts` exactly
 *
 * The two serve the same shape -- one small JSON document per Stack, replaced rather than
 * accumulated, read by several surfaces and written by one. Reusing the `with*Source`
 * pattern means a caller that has already been taught one seam does not have to learn a
 * second convention, and both seams disappear together when the file backends do.
 *
 * ## Why the seam is a value and not an adapter
 *
 * `TemplateLockRead` already models absence, malformity and unavailability, and
 * `parseTemplateLock` is the only thing that can produce it. So this seam hands back the
 * raw stored document and lets the CALLER run the parser: wrapping the parser here would
 * put the same four-way verdict in two places.
 */

import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import { readTemplateLockRow, saveTemplateLock, type StoredTemplateLockRow } from "./template-lock-store.js";

/** Store and read one Stack's advisory template lock. */
export interface TemplateLockSource {
  /** Store the lock, replacing any prior one. */
  save(document: unknown, digest: string): Promise<void>;
  /** The stored lock document, or undefined when this Stack has none. */
  read(): Promise<StoredTemplateLockRow | undefined>;
}

/** The Stack this run is bound to, or undefined when the environment names none. */
function lockStackId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/**
 * Run `fn` with this Stack's advisory lock, or with `undefined` when none is configured.
 *
 * @param env - Environment naming the Stack.
 * @param fn - Receives the lock handle, or undefined for a file-backed project.
 * @returns Whatever `fn` returns.
 */
export async function withTemplateLockSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: TemplateLockSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = lockStackId(env);
  if (stackId === undefined) return fn(undefined);
  const handle = createDimensionsDatabase(env);
  try {
    return await fn({
      save: (document, digest) => saveTemplateLock(handle.db, stackId, document, digest),
      read: () => readTemplateLockRow(handle.db, stackId),
    });
  } finally {
    await handle.close();
  }
}
