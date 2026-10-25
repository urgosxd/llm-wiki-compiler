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

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PageListingSource } from "../../pages/list.js";
import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import { createPageListingSource } from "./page-write-sink.js";
import { createPageScanSource, type PageScanSource } from "./page-scan-source.js";

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

/**
 * Run `fn` with the row-backed SCAN source, or `undefined` for the file scan.
 *
 * Kept separate from {@link withPageSource} because the two answer different
 * shapes: `listPages` wants typed pages, while status and the index builder want
 * `{ slug, meta }`. One seam returning both would force each caller to narrow a
 * union it does not otherwise care about.
 *
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the scan source, or `undefined` to read `wiki/` from disk.
 * @returns Whatever `fn` returns.
 */
export async function withPageScan<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: PageScanSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(createPageScanSource(dimensionsDb.db, stackId));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Whether this project has any compiled page at all.
 *
 * Replaces the `existsSync(index.md)` test that query used as a proxy. The index is
 * DERIVED from pages, so its absence never meant "nothing compiled" -- and in a
 * Stack-backed project there is no file to find even when every page is present.
 *
 * @param root - Project root, used by the on-disk scan.
 * @param env - Environment to read the Stack from.
 * @returns True when at least one page exists in either backend.
 */
export async function hasCompiledPages(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return withPageScan(env, async (scan) => {
    if (scan !== undefined) return (await scan.scan("concepts")).length > 0;
    const conceptsDir = path.join(root, "wiki", "concepts");
    const entries = await readdir(conceptsDir).catch(() => [] as string[]);
    return entries.some((entry) => entry.endsWith(".md"));
  });
}
