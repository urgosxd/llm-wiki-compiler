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

export interface SdkCompileOptions {
  /** Write generated pages as candidates for review instead of mutating wiki/. */
  review?: boolean;
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
import type { ArtifactRef } from "../artifacts/ref.js";
import type { ArtifactHealth } from "../artifacts/resolve.js";

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
  query(question: string, opts?: { save?: boolean; review?: boolean; limit?: number }): Promise<unknown>;
  /** Read one page. */
  getPage(ref: PageRef): Promise<unknown>;
  /** Enumerate pages. */
  listPages(opts?: { directory?: string; limit?: number }): Promise<unknown>;
  /** Enumerate source documents. */
  listSources(opts?: ListSourcesOptions): Promise<unknown>;
  /** Read one source document. */
  getSource(id: string): Promise<unknown>;
  /** Delete one source document. */
  deleteSource(id: string): Promise<unknown>;
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
  /** Write one artifact through the trust executor. */
  writeArtifact(input: {
    artifactType: string;
    slug: string;
    body?: string;
    memberFiles?: readonly { fileName: string; bytes: Uint8Array }[];
  }): Promise<unknown>;
  /** Verify an artifact ref. */
  verifyArtifact(ref: ArtifactRef): Promise<{ health: ArtifactHealth }>;
  /** Read a verified artifact body. */
  readVerifiedArtifactBody(ref: ArtifactRef): Promise<unknown>;
  /** Discover an artifact by selector. */
  discoverArtifact(selector: import("../artifacts/discover.js").ArtifactSelectorV1): Promise<unknown>;
}
