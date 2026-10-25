/**
 * Decide whether a wiki read comes from rows or from `wiki/`.
 *
 * ## Why a seam instead of a required argument
 *
 * Every reader of compiled pages -- the SDK, the dimension reader, search, query --
 * asks for pages with no database in hand. Making the source a required argument
 * would thread a handle through all of them and change the meaning of a call that
 * works today on a project with no Stack.
 *
 * ## Why the handle is opened per call rather than held
 *
 * A long-lived pool keeps the event loop alive, which is why the ingest path opens
 * and closes one per operation. Holding one in the SDK would do exactly that for
 * every embedder, including the many that never touch a Stack. The cost of opening
 * one only on the row path is a connection per listing, and the alternative -- a
 * module-level pool -- would be a resource leak the caller never agreed to.
 */

import type { PageListingSource } from "../../pages/list.js";
import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import { createPageListingSource } from "./page-write-sink.js";

/**
 * Run `fn` against the page source for this environment, or against the file path.
 *
 * The handle is closed before returning, whatever `fn` does.
 *
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @param fn - Receives the row source, or `undefined` to keep reading `wiki/`.
 * @returns Whatever `fn` returns.
 */
export async function withPageSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: PageListingSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(createPageListingSource(dimensionsDb.db, stackId));
  } finally {
    await dimensionsDb.close();
  }
}
