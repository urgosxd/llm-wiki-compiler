/**
 * @file src/sdk/core.ts
 * @description In-process SDK facade for llmwiki.
 *
 * `createWikiCore(options)` returns a `WikiCore` object that delegates every
 * method to the SDK-safe core functions built across Tasks 1–9. All
 * methods run silently (no console output) by scoping quiet mode to the
 * async call tree via AsyncLocalStorage, so concurrent calls are fully
 * isolated — no global flag is mutated, eliminating the concurrency caveat
 * described in earlier design drafts.
 *
 * Provider-gating rules:
 *   - `compile` — guard chat plus embeddings unless refreshes are disabled
 *   - `search`, `query` — always guard (throw ProviderUnavailableError if no creds)
 *   - `runEval({ mode: "full" })` — guards only when mode is "full"
 *   - All other methods — no credential check; safe to call without an LLM provider
 *
 * Root-path validation: `createWikiCore` normalizes the root once via `path.resolve`.
 * A non-existent root is accepted — `ingest`/`ingestText` create `sources/` via
 * recursive `mkdir` on first write. If the path already exists but is NOT a
 * directory (e.g. a regular file was passed by mistake), construction throws
 * immediately with a clear error message.
 */

import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { withQuiet } from "../utils/output.js";
import { ingestSource, ingestTextSource } from "../commands/ingest.js";
import { compileAndReport } from "../compiler/index.js";
import { generateAnswer, assertQuerySaveOptions } from "../commands/query.js";
import { lint, lintByTier } from "../linter/index.js";
import { buildContextPack } from "../context/build.js";
import { exportJson } from "../commands/export.js";
import { runEval, DEFAULT_SAMPLE_SIZE } from "../eval/index.js";
import {
  ensureCompileProviderAvailable,
  ensureProviderAvailable,
} from "../utils/provider-guard.js";
import { collectStatus } from "../status/collect.js";
import { pickSearchRefs, loadSelectedRefs } from "../search/retrieval.js";
import { getPage, listPages } from "../pages/list.js";
import {
  withPageScan,
  withPageSource,
  withRegistrySource,
  withSourceDocuments,
} from "../dimensions/wiki/page-source-seam.js";
import { listSources, getSource } from "../sources/store.js";
import { runOkfExport } from "../export/okf/run.js";
import { runOkfImport } from "../import/run.js";
import { applyApprovedMutations } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { CreateWikiOptions, WikiCore, SdkCompileOptions } from "./core-types.js";

/**
 * Run `fn` with output scoped quiet via AsyncLocalStorage.
 * Concurrent calls are fully isolated — no global flag is mutated.
 * Declared async so synchronous throws inside `fn` become rejected promises.
 */
async function runQuiet<T>(fn: () => Promise<T>): Promise<T> {
  return withQuiet(fn);
}

/**
 * Create an in-process wiki facade bound to the given project root.
 *
 * @param options - `{ root }` — path to the wiki project directory.
 * @returns A `WikiCore` facade without local workflow execution methods.
 */
export function createWikiCore(options: CreateWikiOptions): WikiCore {
  return createWikiCoreAtRoot(path.resolve(options.root), options);
}

/** Assemble core at a root already normalized by the standard facade. */
export function createWikiCoreAtRoot(root: string, options: CreateWikiOptions): WikiCore {
  // A missing root is valid — ingest/ingestText create sources/ via recursive mkdir.
  // But if the path already exists and is NOT a directory, it is always a caller mistake.
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new Error(`createWiki: root exists but is not a directory: ${root}`);
  }

  // THE BOUNDARY for the SDK. `CreateWikiOptions.env` is the optional request
  // environment; omitting it targets the AMBIENT Stack, which is the documented
  // contract. Resolved ONCE here so no method below can disagree about the tenant it
  // is addressing — the defect this replaces read `process.env` inside each method.
  const env = options.env ?? process.env;

  return {
    // `env` is forwarded, not merely computed: an environment this boundary captured
    // but did not pass on silently retargets the write to the AMBIENT Stack, which is
    // a wrong-tenant write under the contract the resolution above promises.
    //
    // `options.dimensionsPort` is forwarded for the same class of reason: it is the
    // injected resolution seam, and a port captured from the caller but not passed on
    // silently reverts to the ambient `LLMWIKI_DIMENSIONS` read the caller replaced.
    ingest: ({ source }) =>
      runQuiet(() => ingestSource(root, source, undefined, env, {}, options.dimensionsPort)),

    ingestText: (input) =>
      runQuiet(() => ingestTextSource(root, input, env, options.dimensionsPort)),

    // `env` is forwarded here for the same reason it is forwarded by `ingest`: every
    // storage seam inside the run takes an environment, and `compileAndReport`
    // resolves an omitted one to `process.env`. A compile that named Stack B while
    // the process served Stack A therefore recorded B's compile state under A — or
    // under the process' own state file when it served no Stack at all.
    //
    // `options.dimensionsPort` is forwarded for the reason `ingest` states: it is the
    // caller's own dimension resolution, and a compile that dropped it would retire
    // deleted sources from whatever the ambient `LLMWIKI_DIMENSIONS` switch names
    // instead. Absent stays valid — the compiler composes its default port at the
    // point of use, so omission is a real resolution rather than a refusal.
    compile: (opts: SdkCompileOptions = {}) =>
      runQuiet(() => {
        ensureCompileProviderAvailable(opts.embeddings !== false);
        return compileAndReport(root, { ...opts, env, dimensionsPort: options.dimensionsPort });
      }),

    search: (question, opts = {}) =>
      runQuiet(async () => {
        ensureProviderAvailable();
        // One source for ranking AND hydration: selecting against rows and then
        // reading files would drop every ref of a Stack-backed wiki as absent.
        const selected = await withRegistrySource(env, async (registrySource) => {
          const { refs, warnings } = await pickSearchRefs(root, question, { ...opts, registrySource });
          return { refs, warnings, pages: await loadSelectedRefs(root, refs, registrySource) };
        });
        return selected;
      }),

    query: (question, opts = {}) =>
      runQuiet(() => {
        assertQuerySaveOptions(opts);
        ensureProviderAvailable();
        // The registry source is an internal handle, never part of the public SDK
        // options, so the facade resolves it here for every embedder.
        return withRegistrySource(env, (registrySource) =>
          generateAnswer(root, question, { ...opts, registrySource }),
        );
      }),

    // Pages come from rows when a Stack is configured. Both go through the same
    // seam so a listing and a single-page read can never disagree about which
    // backend they are looking at.
    getPage: (ref) =>
      runQuiet(() => withPageSource(env, (source) => getPage(root, ref, source))),

    listPages: (opts) =>
      runQuiet(() => withPageSource(env, (source) => listPages(root, { ...opts, pageSource: source }))),

    listSources: (opts) => runQuiet(() => listSources(root, opts)),

    // `env` is deliberately NOT threaded here: this operation has no row-aware path
    // for it to reach. `getSource` (`sources/store.ts`) reads the text through
    // `resolveSourcesDir` → `confinedRegularFile` → `readFile` and takes no
    // environment at all, so passing one would change no answer while implying a
    // Stack it never consults. Source text DOES live in rows
    // (`wiki.source_documents`, reachable only through the compiler's
    // `SourceContentSource`), so a row-backed single-source read is a capability this
    // facade lacks — the same recorded gap as `listSources`, not a dropped argument.
    getSource: (id) => runQuiet(() => getSource(root, id)),

    // Status is built from TWO answer sources, and both are resolved here: the row
    // seams supply the page and source corpora, and `env` supplies the compile state.
    // Omitting either made one object describe two deployments — a handle bound to
    // Stack B reported B's corpus beside the ambient Stack's `lastCompiledAt` and
    // `pendingChanges`. With no Stack configured both seams answer `undefined` and
    // the on-disk reads this call has always done are unchanged.
    status: () =>
      runQuiet(() =>
        withPageScan(env, (pageScan) =>
          withSourceDocuments(env, (sourceDocuments) =>
            collectStatus(root, { pageScan, sourceDocuments, env }),
          ),
        ),
      ),

    // `env` is forwarded for the reason `compile` states, and lint has a row-aware
    // path for it to reach: `resolveLintCorpus` resolves the run's pages through
    // `withRawPageSource(root, env, …)`. Dropping it made a handle bound to Stack B
    // read the AMBIENT Stack's pages when the process served one (a wrong-tenant
    // verdict), and fall back to walking `wiki/` on disk when it served none — a tree
    // a Stack does not have, so a clean report for a corpus nobody read.
    lint: () => runQuiet(() => lint(root, env)),

    lintByTier: () => runQuiet(() => lintByTier(root, env)),

    // buildContextPack uses `prompt`/`budget` field names (NOT question/tokenBudget).
    // Semantic retrieval is opportunistic: falls back to lexical when no embeddings
    // are available, so no credential guard is needed here.
    getContextPack: (opts) =>
      runQuiet(() =>
        buildContextPack({
          root,
          prompt: opts.prompt,
          ...(opts.budget !== undefined && { budget: opts.budget }),
          ...(opts.depth !== undefined && { depth: opts.depth }),
          ...(opts.topPages !== undefined && { topPages: opts.topPages }),
          ...(opts.topChunks !== undefined && { topChunks: opts.topChunks }),
        }),
      ),

    exportJson: (opts = {}) => runQuiet(() => exportJson(root, opts)),

    // "full" mode calls the LLM judge; "fast" mode is credential-free.
    runEval: ({ mode, record = false }) =>
      runQuiet(() => {
        if (mode === "full") ensureProviderAvailable();
        return runEval(root, mode, DEFAULT_SAMPLE_SIZE, record);
      }),

    exportOkf: (opts = {}) => runQuiet(() => runOkfExport(root, opts)),

    importOkf: (dir, opts = {}) => runQuiet(() => runOkfImport(root, dir, opts)),

    // @experimental preparation slice — factored into preparation-facade.ts.
    // The embedder's preparation identity and grants are read HERE, at
    // construction, and never from a method argument: an `sdk` principal holds
    // exactly the grants it was given, so an embedder that names none can read
    // preparations and not mutate them.
    //
  };
}
