/**
 * @file src/sdk/core-types.ts
 * @description Public type surface for the llmwiki in-process SDK.
 *
 * This file held one interface per method of every SDK slice, including the
 * preparation, product and operation slices. Those subsystems are not part of this
 * build, and the declarations outlived them: the compiler reported `WikiCore` as
 * "missing 15 properties" that nothing implemented, because a hand-written contract
 * cannot notice its implementation shrinking.
 *
 * So `WikiCore` is now DERIVED from `createWikiCore`'s return value. If a method
 * leaves the implementation it leaves the type in the same edit, and the two can no
 * longer disagree. Only the option shapes stay declared here, because a caller writes
 * them by hand and they need names a reader can find.
 */

import type { Dimension } from "../dimensions/types.js";

export interface SdkCompileOptions {
  /**
   * Maximum concurrent LLM calls during compile (extraction + page generation).
   * Overrides LLMWIKI_COMPILE_CONCURRENCY and the built-in default of 5;
   * out-of-range values are clamped with a warning.
   */
  concurrency?: number;
  /**
   * Extra instructions appended to the built-in compile prompts, for a host that
   * needs deployment-specific editorial or publication guidance without forking
   * the prompts. Additive, never a replacement; blank is the same as omitted.
   *
   * Advisory rather than enforceable: it makes the model more likely to follow a
   * rule, and nothing verifies that it did.
   *
   * Changing it invalidates pages compiled under the previous policy, the same
   * way changing the output language does.
   */
  systemPolicy?: string;
  /**
   * Refresh semantic embeddings after compilation. Defaults to true.
   * False prevents embedding-provider calls and pending-embedding retries.
   */
  embeddings?: boolean;
}

/**
 * Options for `createWikiCore`.
 *
 * Reduced to what the implementation reads. The former `preparation` and `operations`
 * fields named grants for subsystems this build no longer contains; keeping them would
 * let a caller pass an authority that governs nothing.
 */
export interface CreateWikiOptions {
  /** Absolute or relative path to the project root. Normalized once inside `createWiki`. */
  root: string;
  /**
   * Environment naming the Stack this core reads and writes.
   *
   * OMITTING `env` TARGETS THE AMBIENT STACK. That fallback is a deliberate contract
   * rather than an inherited accident: an embedder that serves one deployment passes
   * nothing and keeps addressing the Stack the process is bound to. An embedder that
   * serves MANY Stacks must pass the request's environment here, or every write and
   * read this core performs lands in the bound deployment's tenant instead of the
   * one the request named.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The configured dimensions, when the caller already holds one.
   *
   * OPTIONAL, AND OMITTING IT IS VALID (spec S3). Absent means "compose the
   * default you are given", never "throw": an embedder that passes nothing keeps
   * working exactly as it did. Inside the wiki package, absence means the ambient
   * resolution `writeToDimensions` already performs.
   *
   * The type is declared in THIS file rather than re-exported from the monorepo's
   * private foundation package for the reason in {@link DimensionsPort}: this file is
   * published, and a private specifier in a published `.d.ts` is a specifier the
   * embedder can never import.
   */
  dimensionsPort?: DimensionsPort<Dimension>;
}

/**
 * One dimension-resolution request, as the published contract states it.
 *
 * ## The published type is the AUTHORITATIVE one on the wiki side
 *
 * This is not a copy kept in step with the private foundation package's interface; it is the
 * contract the wiki ingest path ACCEPTS, and foundation's implementation-side
 * `DimensionsPort<Dimension>` is the thing that has to satisfy it. That direction is
 * the only one the product needs: the API package constructs a port and hands it to
 * `CreateWikiOptions.dimensionsPort`, while nothing ever hands a hand-built
 * published port to the engine's resolver. Testing the pair as "are these identical?"
 * demanded a mirror of `db` that cannot be written without naming a third-party
 * package; testing the direction that ships demands only what an implementation side
 * can actually produce.
 *
 * ## Why `db` is `object`
 *
 * The handle's query-result container is the driver package's `RowList` reached through
 * drizzle's `PgQueryResultKind<PostgresJsQueryResultHKT, TRow>` — `RowList<T> = T &
 * Iterable<NonNullable<T[number]>> & ResultQueryMeta<…>`, whose `pop()` returns
 * `Assume<TRow, Row>` rather than `TRow`. Re-declaring that shape is not possible
 * without naming that ORM and its driver package, which would put specifiers in a
 * published `.d.ts` that the publishing package does not declare. So the field is
 * typed as the narrowest thing that is true here: an object.
 *
 * The handle is carried so an IMPLEMENTATION can forward it to the library's own
 * resolution machinery — the composition root owns the real handle and the real
 * resolver. It is NOT carried so an embedder can execute SQL through this boundary.
 * A hand-built port therefore cannot call `db.execute` meaningfully, and that is the
 * contract, not a gap: the published surface offers an injectable port, not database
 * access.
 *
 * `only` is `readonly string[]` rather than a dimension-name union because the union
 * belongs to the dimension that defines it; `env` is REQUIRED so a port can never
 * fall back to `process.env` through an input it never stated; `root` and `db` are
 * REQUIRED because both real consumers already hold them when they need a dimension
 * set.
 */
export interface DimensionsRequest {
  /** Dimension names the caller may receive; never enables one the environment disabled. */
  readonly only: readonly string[];
  /** The one environment this resolution reads. Required: no ambient default. */
  readonly env: NodeJS.ProcessEnv;
  /** Project root the dimensions are bound to. */
  readonly root: string;
  /**
   * Database handle the dimensions are backed by, OPAQUE at this boundary.
   *
   * `object` rather than the driver's handle type for the reason in this interface's
   * header: the result container cannot be re-declared here without naming packages a
   * published consumer cannot resolve. It is forwarded to the implementation's own
   * resolver; it is not a query surface this contract offers.
   */
  readonly db: object;
  /** Stack the caller already resolved, when it did. */
  readonly stackId?: string;
}

/**
 * The configured dimensions, as a caller who holds them hands them over.
 *
 * {@link CreateWikiOptions.dimensionsPort} stays OPTIONAL and omitting it is valid
 * (spec S3): absent means the composed default, never a throw.
 *
 * @typeParam TDimension - The dimension type of the implementing side, which this
 *   file does not name beyond the one shipped dimension contract.
 */
export interface DimensionsPort<TDimension> {
  /**
   * Build the dimensions the request enables.
   *
   * @param request - The root, handle, environment and narrowing the caller states.
   * @returns The enabled dimensions, in the implementation's commit order.
   */
  resolve(request: DimensionsRequest): readonly TDimension[];
}

/**
 * The in-process SDK surface returned by `createWikiCore`.
 *
 * DERIVED rather than declared, for the reason in the file header.
 */
/**
 * The in-process SDK surface returned by `createWikiCore`.
 *
 * Written explicitly, one entry per method the implementation actually provides. It is
 * NOT derived from the return type: `createWikiCore` annotates its own return with this
 * interface, so deriving it from the implementation closes a cycle the compiler rejects.
 * The list is therefore the contract, and `core.ts` fails to compile the moment the two
 * disagree -- which is the check that matters, and the one a hand-maintained interface
 * for DELETED methods could not provide.
 */
import type { IngestTextInput } from "../services/ingest/service.js";
import type { PageRef } from "../pages/list.js";
import type { ListSourcesOptions } from "../sources/source-record.js";
import type { ExportJsonOptions } from "../export/json-export.js";
import type { OkfImportOptions } from "../import/run.js";

export interface WikiCore {
  /** Ingest a file path or URL as a new source document. */
  ingest(input: { source: string }): Promise<unknown>;
  /** Ingest raw text as a new source document. */
  ingestText(input: IngestTextInput): Promise<unknown>;
  /** Compile sources into wiki pages. */
  compile(opts?: SdkCompileOptions): Promise<unknown>;
  /** Rank pages for a question without generating an answer. */
  search(question: string, opts?: { limit?: number; maxPages?: number }): Promise<unknown>;
  /** Answer a question from the wiki. */
  query(question: string, opts?: { save?: boolean; limit?: number }): Promise<unknown>;
  /** Read one page. */
  getPage(ref: PageRef): Promise<unknown>;
  /** Enumerate pages. */
  listPages(opts?: { directory?: string; limit?: number }): Promise<unknown>;
  /** Enumerate source documents. */
  listSources(opts?: ListSourcesOptions): Promise<unknown>;
  /** Read one source document. */
  getSource(id: string): Promise<unknown>;
  /** Project status. */
  status(): Promise<unknown>;
  /** Lint the wiki. */
  lint(): Promise<unknown>;
  /** Lint, grouped by tier. */
  lintByTier(): Promise<unknown>;
  /** Build a context pack for a question. */
  getContextPack(opts: {
    prompt: string; budget?: number; depth?: number;
    topPages?: number; topChunks?: number; omitRoot?: boolean;
  }): Promise<unknown>;
  /** Export the wiki as JSON. */
  exportJson(opts?: ExportJsonOptions): Promise<unknown>;
  /** Run evaluation. */
  runEval(input: { mode: "fast" | "full"; record?: boolean }): Promise<unknown>;
  /** Export an OKF bundle. */
  exportOkf(opts?: { out?: string }): Promise<unknown>;
  /** Import an OKF bundle. */
  importOkf(dir: string, opts?: OkfImportOptions): Promise<unknown>;
}
