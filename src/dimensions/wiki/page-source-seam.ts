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
import { generateIndex } from "../../compiler/indexgen.js";
import { generateMOC } from "../../compiler/obsidian.js";
import { createPageListingSource, createPageRemoveSink, createPageWriteSink } from "./page-write-sink.js";
import { createResolverPageSource } from "./page-scan-source.js";
import type { ResolverPageSource } from "../../compiler/resolver.js";
import type { PageRemover, PageSink } from "../../trust/page-apply.js";
import { readStateClassified, writeState, type StateStatus } from "../../utils/state.js";
import type { WikiState } from "../../utils/types.js";
import { readStateClassifiedFromRows, writeWikiStateToRows } from "./wiki-state-source.js";
import { createRegistryPageSource } from "./page-registry-source.js";
import { databaseEmbeddingSource } from "../../utils/embeddings-database.js";
import type { EmbeddingStoreSource } from "../../utils/embeddings-load.js";
import type { RegistryPageSource } from "../../utils/page-registry.js";
import {
  createPageContentSource,
  createPageScanSource,
  createRawPageSource,
  type PageContentSource,
  type PageScanSource,
  type PageStoreHandle,
  type RawPageSource,
} from "./page-scan-source.js";

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
 * Asks about EVERY page, not just `concepts`. A profile may declare its entities in
 * any `wiki/<dir>` (`papers`, `articles`, ...), so a project whose pages all live
 * outside `concepts` is a perfectly compiled project -- and the previous
 * concepts-only test told `query` it had nothing to ground on.
 *
 * @param root - Project root, used by the on-disk scan.
 * @param env - Environment to read the Stack from.
 * @returns True when at least one page exists in either backend.
 */
export async function hasCompiledPages(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return withPageSource(env, async (source) => {
    if (source !== undefined) return (await source.list()).length > 0;
    const wikiDir = path.join(root, "wiki");
    const dirs = await readdir(wikiDir, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const entries = await readdir(path.join(wikiDir, dir.name)).catch(() => [] as string[]);
      if (entries.some((entry) => entry.endsWith(".md"))) return true;
    }
    return false;
  });
}

/**
 * Run `fn` with the raw-page source, or `undefined` for the on-disk scan.
 *
 * The third shape this seam carries. `RawWikiPage` is what the export and viewer
 * collectors consume, and it differs from both the listing (`Page`) and the scan
 * (`{ slug, meta }`) by including the parse-status flags those collectors filter on.
 *
 * @param root - Project root, used only to synthesize a diagnostic path per page.
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the raw source, or `undefined` to read `wiki/` from disk.
 * @returns Whatever `fn` returns.
 */
export async function withRawPageSource<T>(
  root: string,
  env: NodeJS.ProcessEnv,
  fn: (source: RawPageSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(createRawPageSource(dimensionsDb.db, stackId, root));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Regenerate the derived navigational artifacts — `index.md` and `MOC.md`.
 *
 * They are called together everywhere except `query-save`, which writes only the
 * index. Bundling them here means the backend is resolved ONCE for the pair instead
 * of twice, and a caller cannot regenerate one while leaving the other summarizing a
 * directory the run no longer writes.
 *
 * @param root - Project root.
 * @param env - Environment to read the Stack from.
 * @param options - `skipMoc` for the index-only caller.
 * @returns Resolves when both artifacts are written.
 */
export async function regenerateIndices(
  root: string,
  env: NodeJS.ProcessEnv,
  options: { skipMoc?: boolean } = {},
): Promise<void> {
  await withPageScan(env, async (source) => {
    await generateIndex(root, source);
    if (options.skipMoc !== true) await generateMOC(root, source);
  });
}

/**
 * Run `fn` with the row-backed REGISTRY source, or `undefined` for file reads.
 *
 * The search and answer paths ask the registry three separate questions -- which
 * pages are live, what a page's live hashes are, and what its body says -- and all
 * three must be answered by the same backend. Passing `undefined` when no Stack is
 * configured is what keeps every existing file-backed caller byte-identical.
 *
 * @param env - Environment carrying the Stack id and database URL.
 * @param fn - Receives the row source, or `undefined` to read files.
 * @returns Whatever `fn` returns.
 */
export async function withRegistrySource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: RegistryPageSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(createRegistryPageSource(dimensionsDb.db, stackId));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Run `fn` with the row-backed EMBEDDING source, or `undefined` for the file path.
 *
 * Symmetric with {@link withRegistrySource} and needed for the same reason: the
 * retrieval pipeline only searches vectors when it is handed a store source, and
 * with no source it falls straight through to a disk enumeration. On a Stack that
 * makes a fully compiled, fully embedded corpus invisible -- the vectors sit in
 * `wiki.page_embeddings` while the query looks at a filesystem that has no page
 * files at all.
 *
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the source, or `undefined` for the file-backed path.
 * @returns Whatever `fn` returns.
 */
export async function withEmbeddingStoreSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: EmbeddingStoreSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(databaseEmbeddingSource(dimensionsDb.db as never, stackId));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Run `fn` with the row-backed page REMOVER, or `undefined` for the file path.
 *
 * The delete counterpart of {@link withPageSource}, and the only way a caller that
 * already holds a lock can reach the remover without opening a database of its own
 * or importing the dimensions graph. `src/sources/removal.ts` deletes pages under
 * the lock via `deleteWikiPagesLocked`, which needs exactly this handle: with a
 * Stack the page is a row, so unlinking `wiki/concepts/<slug>.md` removes nothing
 * and reports success for a page that is still there.
 *
 * The handle is closed before returning, whatever `fn` does.
 *
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the row remover, or `undefined` to unlink files.
 * @returns Whatever `fn` returns.
 */
export async function withPageRemover<T>(
  env: NodeJS.ProcessEnv,
  fn: (remover: PageRemover | undefined) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn(undefined);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(createPageRemoveSink(dimensionsDb.db as never, stackId));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * What a row-backed artifact write needs from the environment: a handle plus its Stack.
 *
 * Returned as one bundle because the write NEEDS both or neither -- a handle without a
 * Stack would read the wrong tenant's rows, and a Stack without a handle cannot reach
 * them. Resolving them together is the same rule the page seams follow for the same
 * reason.
 */
export interface ArtifactRowWrite {
  /** Database handle; the caller must close it. */
  db: unknown;
  /** The Stack the artifact belongs to. */
  stackId: string;
  /** Close the handle. */
  close: () => Promise<void>;
}

/**
 * Resolve the row backend for an artifact WRITE, or undefined for the file path.
 *
 * Mirrors {@link withPageRemover} but returns the handle instead of invoking a callback,
 * because the artifact write needs to interleave the handle with an already-admitted
 * plan and a preflighted audit event; wrapping that in a callback would push the whole
 * admission sequence into this module.
 *
 * The CALLER owns `close()`. That is the one difference from the `with*` seams, and it is
 * deliberate: `apply.ts` must emit its audit event AFTER the write, so a scope that
 * closed on return would close the handle too early.
 *
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The row write target, or undefined when no Stack is configured.
 */
export function resolveArtifactRowWrite(env: NodeJS.ProcessEnv = process.env): ArtifactRowWrite | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  const dimensionsDb = createDimensionsDatabase(env);
  return { db: dimensionsDb.db, stackId, close: () => dimensionsDb.close() };
}

/**
 * Every page seam a compile stage may need, resolved together.
 *
 * ## Why one bundle instead of four parameters
 *
 * Five compile stages write pages and seven read them, and each needs a different
 * subset: generation reads a page's previous version, seeding reads related pages,
 * orphan and repair read one page and write another. Passing the seams individually
 * would add three parameters to functions that already carry eight, and would let a
 * stage be wired to a sink while its reader still pointed at disk -- the exact
 * mixed-backend defect this whole migration keeps re-introducing.
 *
 * Resolving them from ONE variable also means a run cannot store rows while
 * repairing files, or read rows while writing `wiki/`.
 *
 * All fields are `undefined` for a project with no Stack, which is the case every
 * existing caller still runs, so the file path is untouched.
 */
export interface PageSeams {
  /** Read one page by identity, for re-render, seeding, orphaning and repair. */
  content?: PageContentSource;
  /** Enumerate a wiki directory, for the sibling-context and repair scans. */
  scan?: PageScanSource;
  /** Store a compiled page as a row instead of writing a file. */
  sink?: PageSink;
  /** Remove a page from the row store instead of unlinking a file. */
  remover?: PageRemover;
  /** Enumerate concept pages for link RESOLUTION (a different shape than `scan`). */
  resolver?: ResolverPageSource;
}

/**
 * Resolve the page seams this run should use.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The seams, empty when no Stack is configured.
 */
export function resolvePageSeams(
  db: PageStoreHandle,
  env: NodeJS.ProcessEnv = process.env,
): PageSeams {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return {};
  return {
    content: createPageContentSource(db, stackId),
    scan: createPageScanSource(db, stackId),
    sink: createPageWriteSink(db as never, stackId),
    remover: createPageRemoveSink(db as never, stackId),
    resolver: createResolverPageSource(db as never, stackId),
  };
}

/**
 * Run `fn` with EVERY page seam resolved together, or all-undefined for files.
 *
 * The individual `with*` helpers exist for callers that need one capability. The
 * link-repair and link-resolve paths need all four at once, and taking them from
 * separate handles would open the database four times for one operation. More
 * importantly, a caller that takes SOME of them writes rows and reads files: the
 * repair pass would rewrite a page through the sink while listing pages from a
 * directory a Stack never populates. One handle, one consistent view.
 *
 * @param env - Environment to read the Stack from.
 * @param fn - Receives the seams; all undefined on a file-backed project.
 * @returns Whatever `fn` returns.
 */
export async function withPageSeams<T>(
  env: NodeJS.ProcessEnv,
  fn: (seams: PageSeams) => Promise<T>,
): Promise<T> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return fn({});
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await fn(resolvePageSeams(dimensionsDb.db as never, env));
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Classify this environment's compile state, from rows when a Stack is configured.
 *
 * ONE function so the seven read-only callers do not each repeat the
 * stack-check / open-handle / close-handle dance. Lives here rather than in
 * `wiki-state-source.ts` because that module is reachable from the compile path,
 * which must not pull the dimensions database into its graph — the same rule that
 * governs every other seam in this file.
 *
 * @param root - Project root, used only by the file backend.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The status plus the carried state.
 */
export async function readStateClassifiedFor(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: StateStatus; state: WikiState }> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return readStateClassified(root);
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    return await readStateClassifiedFromRows(dimensionsDb.db, stackId);
  } finally {
    await dimensionsDb.close();
  }
}

/**
 * Persist this environment's compile state, to rows when a Stack is configured.
 *
 * The write half of {@link readStateClassifiedFor}, and it exists for the same
 * reason: a caller that LOADS rows and SAVES a file duplicates the state on the
 * next read — the file it wrote is never the one anything loads. `sources/removal`
 * is exactly such a caller, which is why the pair lives together.
 *
 * @param root - Project root, used only by the file backend.
 * @param state - The state to persist.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 */
export async function writeStateFor(
  root: string,
  state: WikiState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") {
    await writeState(root, state);
    return;
  }
  const dimensionsDb = createDimensionsDatabase(env);
  try {
    await writeWikiStateToRows(dimensionsDb.db, stackId, state);
  } finally {
    await dimensionsDb.close();
  }
}
