/**
 * Compilation orchestrator for the wiki compiler.
 *
 * Coordinates the full pipeline: lock acquisition, change detection,
 * concept extraction via LLM, wiki page generation with streaming output,
 * orphan marking for deleted sources, interlink resolution, and index
 * generation. Supports incremental compilation — only new or changed
 * sources are processed through the LLM pipeline.
 */

import { createHash } from "node:crypto";
import { readdir } from "fs/promises";
import path from "path";
import { CompileStateDraft } from "./compile-state-draft.js";
import {
  recoverJournalBeforeCompile,
  JournalUnsafeError,
} from "../trust/journal-recovery.js";
import {
  buildExtractionSourceStates,
} from "./source-state.js";
import {
  parseFrontmatter,
  slugify,
} from "../utils/markdown.js";
import { stableContent } from "../utils/source-writer.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../utils/mutation-lock.js";
import {
  parseConcepts,
} from "./prompts.js";
import { loadSchema, type SchemaConfig } from "../schema/index.js";
import { detectChanges, hashFile } from "./hasher.js";
import {
  promoteForPromptModifiers,
  promptModifiersDigest,
  withRunSystemPolicy,
} from "./prompt-modifiers.js";
import {
  findAffectedSources,
  findReconciliationSlugs,
  freezeFailedExtractions,
  persistFrozenSlugs,
  type ExtractionResult,
} from "./deps.js";
import {
  markOrphaned,
  orphanSupersededAliasPages,
  orphanUnownedFrozenPages,
} from "./orphan.js";
import { linkGateOptions, resolveAndApplyLinks } from "./resolver.js";
import type { LinkGateOptions } from "./resolver.js";
import {
  addContextualLinkCounts,
  emptyContextualLinkCounts,
} from "./link-anchoring.js";
import {
  addLinkReviewCounts,
  emptyLinkReviewCounts,
  reviewEarlierPages,
  type LinkReviewArticle,
} from "./link-review.js";
import { buildRelatedPageIndex, type RelatedPageIndex } from "./page-renderer.js";
import {
  attributionCountsOf,
  createAttributionSink,
  type AttributionSink,
} from "./page-renderer.js";
import type { ContextualLinkCounts } from "./link-anchoring.js";
import {
  addCuratedLinkCounts,
  emptyCuratedLinkCounts,
  type CuratedLinkCounts,
  type CuratedLinkStorePort,
} from "./curated-links.js";
import { overlayCuratedPageWrites } from "./curated-links-apply.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import {
  addCategoryAssignmentCounts,
  assignCategories,
  emptyCategoryAssignmentCounts,
  type CategoryAssignmentArticle,
} from "../categories/assign.js";
import { repairAndApplyLinks } from "./link-repair.js";
import {
  describeRecompileRefusal,
  planRecompile,
  readVersionSplit,
  scopeChangesToRecompile,
  type RecompilePlan,
} from "./version-report.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { qualifiedPageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { listCandidates } from "./candidates.js";
import {
  applyCompilePageWritesLocked,
} from "./compile-write.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { loadReviewPolicy } from "../review/config.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import { isPolicyOff } from "../review/policy.js";
import type { ReviewPolicy } from "../review/policy.js";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  SOURCES_DIR,
} from "../utils/constants.js";
import { resolveCompileConcurrency } from "./concurrency.js";
import pLimit from "p-limit";
import { mergeExtractions } from "./extraction-merge.js";
import { applyConceptIdentity, snapshotIncumbentConcepts, type ConceptIdentityOutcome } from "./identity-stage.js";
import { runExtractionPhases } from "./extraction-phase.js";
import { reusableSourceFiles, withExtractionSnapshot } from "./extraction-snapshot.js";
import { generateMergedPage } from "./review-pipeline.js";
import { generateSeedPages } from "./seed-pages.js";
import {
  logCompile,
  printChangesSummary,
  reportFrozenSlugs,
  reportSchemaStatus,
  reportVersionSplit,
  summarizeCompile,
} from "./compile-report.js";
import type {
  ChangeBuckets,
  MergedConcept,
  MergedPageOutcome,
  PageGenerationResult,
  RunReportTotals,
} from "./types.js";
import type {
  CompileOptions,
  CompileResult,
  ReviewedCandidateRef,
  SourceChange,
  SourceState,
  WikiState,
} from "../utils/types.js";
/**
 * The drizzle handle the dimension helpers are bound to.
 *
 * Derived from the helper's own return type rather than imported from
 * `llmwiki-kg` directly: the DTS build resolves this file without the
 * `tsconfig.paths` entry that makes that package name resolvable, so a direct
 * import here breaks the declaration build even though `tsc` accepts it.
 */
type DimensionsDatabaseHandle = ReturnType<typeof createDimensionsDatabase>["db"];

import {
  createDimensionsDatabase,
  AKS_STACK_ID_ENV_VAR,
} from "../dimensions/index.js";
import type { Dimension, DimensionName } from "../dimensions/index.js";
import { createDefaultDimensionsPort } from "../dimensions/activation.js";
import type { DimensionsPort } from "@repo/foundation";
import { resolveStackForDimensions } from "../services/stacks/resolve-stack.js";
import type { EmbeddingStoreLocation } from "../utils/embeddings.js";
import { databaseEmbeddingLocation } from "../utils/embeddings-database.js";
import {
  sourceDocumentsChangeSource,
  sourceDocumentsContentSource,
} from "../dimensions/wiki/source-documents-store.js";
import type { ChangeDetectionSource, SourceContentSource } from "./hasher.js";
import {
  pageStoreOptions,
  type PageBatchTransaction,
  type PageRemover,
  type PageSink,
} from "../trust/page-apply.js";
import { createPageWriteSink } from "../dimensions/wiki/page-write-sink.js";
import {
  createEmbeddingPageSource,
  createPageScanSource,
  createResolverPageSource,
  type EmbeddingPageSource,
  type PageScanSource,
} from "../dimensions/wiki/page-scan-source.js";
import type { ResolverPageSource } from "./resolver.js";
import { timeStage } from "../utils/stage-timing.js";
import { reportCompileStage, reportCompileProgress } from "../services/ingest/jobs/compile-observer.js";
import type { CompileProgressReporter } from "../services/ingest/jobs/types.js";
import type { IngestJobObserver } from "../services/ingest/jobs/types.js";
import { regenerateIndices, resolvePageSeams, type PageSeams } from "../dimensions/wiki/page-source-seam.js";
import { createWikiStateRowsBackend } from "../dimensions/wiki/wiki-state-source.js";
import type { WikiStateRowsBackend } from "./compile-state-draft.js";

/**
 * The pages a SCOPED regeneration was asked for, for the run in the current async tree.
 *
 * `compileRecompiling` (exported below, and reachable from no command, MCP tool or SDK
 * method) asks for a regeneration that is not driven by a
 * source change: the bytes of the owning sources are identical to the ones already
 * recorded, so change detection would classify them as `unchanged` and the run would
 * short-circuit at "Nothing to compile". The request therefore has to travel beside the
 * change set rather than inside it.
 *
 * `AsyncLocalStorage` rather than a `CompileOptions` field or a module variable, for the
 * reasons `prompt-modifiers.ts` records for its policy scope: `CompileOptions` lives in a
 * shared types module whose surface this feature does not own, and a module variable
 * cannot survive two overlapping runs in one process (the compile lock is per ROOT, and
 * the SDK documents concurrent calls). Omitting the scope leaves every existing caller
 * byte-identical: `getStore()` is `undefined` and the pipeline takes no branch.
 */
const recompileScope = new AsyncLocalStorage<readonly string[]>();

/** The pages this run was asked to regenerate, or `undefined` for an ordinary compile. */
function recompileRequest(): readonly string[] | undefined {
  return recompileScope.getStore();
}

/** The result of a refused regeneration: every refusal named, and nothing written. */
function recompileRefused(plan: RecompilePlan): CompileResult {
  return { ...emptyCompileResult(), errors: plan.refused.map(describeRecompileRefusal) };
}

/** What a run acts on: the changes to process, plus the scoped plan when there is one. */
interface RunScope {
  readonly changes: SourceChange[];
  readonly recompilePlan: RecompilePlan | null;
}

/** True when the resolved scope is a run to perform rather than a refusal. */
function isRunScope(value: RunScope | CompileResult): value is RunScope {
  return "changes" in value;
}

/**
 * Decide what this run processes: the ordinary change set, or a scoped regeneration.
 *
 * Extracted from the pipeline because the decision is the one place where a
 * `--recompile` request can be REFUSED, and a refusal must return from the pipeline before
 * any read that could write. Keeping it here also keeps the pipeline's own branching
 * inside its complexity ceiling.
 *
 * @param root - Project root the reads are confined under.
 * @param state - The run's state, i.e. recorded source ownership.
 * @param detected - The full change detection result.
 * @param options - The compile options the run carries.
 * @param seams - The run's page seams.
 * @returns The scope to run, or the refusal result when the request cannot be honoured.
 */
async function resolveRunScope(
  root: string,
  state: WikiState,
  detected: SourceChange[],
  options: CompileOptions,
  seams: PageSeams,
): Promise<RunScope | CompileResult> {
  const requested = recompileRequest();
  if (requested === undefined) {
    return {
      changes: promoteForPromptModifiers(applyChangeFilter(detected, options.changeFilter), state),
      recompilePlan: null,
    };
  }
  const plan = await planRecompile(root, state, requested, seams.content);
  if (plan.refused.length > 0) return recompileRefused(plan);
  return { changes: scopeChangesToRecompile(detected, plan), recompilePlan: plan };
}

/** The pages a scoped regeneration must write, or `undefined` for an ordinary run. */
function slugsToRegenerate(plan: RecompilePlan | null): ReadonlySet<string> | undefined {
  return plan === null ? undefined : new Set(plan.slugs);
}

/** Ownership to retain for a scoped regeneration, or `undefined` for an ordinary run. */
function retainedForScope(
  plan: RecompilePlan | null,
  extractions: ExtractionResult[],
): ReadonlySet<string> | undefined {
  return plan === null ? undefined : extractedConceptSlugs(extractions);
}

/** Empty CompileResult used when no pipeline work runs (e.g. lock contention). */
function emptyCompileResult(): CompileResult {
  return { compiled: 0, skipped: 0, deleted: 0, concepts: [], pages: [], errors: [] };
}

/**
 * Run the full compilation pipeline with lock protection.
 * Acquires .llmwiki/lock, detects changes, compiles new/changed sources,
 * marks orphaned pages, resolves interlinks, and rebuilds the index.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides.
 */
export async function compile(root: string, options: CompileOptions = {}): Promise<void> {
  await compileAndReport(root, options);
}

/**
 * Regenerate the named pages at the CURRENT synthesis version, and nothing else.
 *
 * THE LEVER the version report points at. A prompt bump does not invalidate a page, so a
 * page compiled under an older prompt keeps that wording until its own source changes for
 * an unrelated reason — and the operator who just read `3 page(s) compiled at v7` needs a
 * way to act on it. This runs the ordinary pipeline as a SCOPED regeneration: the sources
 * that own the named pages are re-extracted, only those pages are generated, and
 * seed-page regeneration, the review of earlier pages and category assignment are skipped,
 * so a regeneration cannot rewrite the wiki around the page it was asked about.
 *
 * Ownership survives it. Every concept those sources produced is RETAINED in `state.json`
 * even though only one page was written — dropping the rest would leave pages the wiki
 * still serves with no recorded owner, which the next compile would read as orphaned.
 *
 * `["all"]` means every page the wiki stores. Anything else is a page id (`concepts/foo`)
 * or a bare slug. A name that no stored page matches, or a page no source owns (a seed
 * page, an approved candidate), is REFUSED with an error and no writes at all.
 *
 * @param root - Project root to compile.
 * @param pages - Page ids, bare slugs, or the literal `all`.
 * @returns The compile result; `errors` carries any refusal, one message per reason.
 */
export async function compileRecompiling(
  root: string,
  pages: readonly string[],
): Promise<CompileResult> {
  return await recompileScope.run(pages, () => compileAndReport(root, { skipSeedPages: true }));
}

/**
 * Run the full compilation pipeline and return a structured result.
 * Same behaviour as compile() but exposes counts, slugs, and errors so
 * non-CLI consumers (the MCP server, programmatic callers) can report
 * meaningful data without scraping terminal output.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides.
 * @returns Structured result describing what was compiled.
 */
export async function compileAndReport(
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  // The `review` option is gone for good: it promised a hold with no surface that
  // promotes a held candidate. Typed callers already get a compile error; this guard
  // is for untyped and dynamically built ones, and it THROWS rather than returning an
  // error because `compile` returns `Promise<void>` and discards this function's
  // result, while the SDK wrapper spreads the options through without turning
  // `errors` into a failure. A returned error would be silent at both surfaces. The
  // test is the presence of the key, so `{ review: false }` is refused too.
  if ("review" in options) {
    throw new Error("The review compile option no longer exists: no surface promotes a held candidate, and the option will not come back. Remove it from your call.");
  }
  output.header("Wiki compile");

  // One handle for the whole run, closed in the `finally` below. Pages are rows
  // in Postgres now, so the pipeline needs a connection; building it here rather
  // than inside the pipeline keeps its lifetime bounded to this call. Constructing
  // it does not connect, so a compile of a project with no dimension work never
  // opens a socket.
  //
  // The RUN's environment decides which database, not the ambient one: every seam
  // below is handed `options.env`, so a handle taken from `process.env` would build
  // one run out of two deployments — reads and writes through the connection it
  // opened, and Stack resolution through the environment it was given. Omitted stays
  // `process.env`, which is exactly what the CLI does today.
  const dimensionsDb = createDimensionsDatabase(options.env ?? process.env);

  // The lock's environment is the RUN's too, for the same reason and from the same
  // value: `acquireLock` keys the advisory lock on the Stack the environment names,
  // so a lock taken from `process.env` while the rows go to `options.env`'s Stack
  // gives a per-request host exclusion on the WRONG Stack -- its own requests never
  // contend for one Stack, and two unrelated Stacks serialise. Omitted stays
  // `process.env`, which is exactly what the CLI passes.
  const locked = await acquireMutationLock(root, "ordinary", { env: options.env });
  if (!locked) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    return {
      ...emptyCompileResult(),
      errors: ["Could not acquire .llmwiki/lock — another compile is in progress."],
      // Machine-readable counterpart to the message above, so transports can
      // answer 409 without pattern-matching prose.
      busy: true,
    };
  }

  try {
    // STRICT replay-before-read: recover any pending journal to its pre-state
    // BEFORE the pipeline reads state or touches pages. An `unsafe` journal
    // (escaping/malformed/escaping-target) aborts the compile loudly — no reads,
    // no writes — rather than compounding a possibly-inconsistent page store.
    // The `finally` below still releases the lock on this abort path.
    const recovery = await recoverJournalBeforeCompile(root);
    if (recovery.status === "unsafe") {
      throw new JournalUnsafeError("pre-compile journal recovery unsafe");
    }
    // The policy is established for the WHOLE run, before change detection, so
    // the modifier digest it contributes is visible to the invalidation check
    // rather than only to the prompt builders further down.
    return await withRunSystemPolicy(options.systemPolicy, () =>
      runCompilePipeline(root, options, dimensionsDb.db),
    );
  } finally {
    await dimensionsDb.close();
    // Released under the SAME environment: `releaseLock` finds the held connection in
    // the registry by the key IT derives, so releasing with the ambient environment
    // would miss the entry this run stored and leave a session-level advisory lock
    // held on its reserved connection until the process died.
    await releaseLock(root, options.env);
  }
}

/** Sort source changes into the buckets the pipeline acts on. */
function bucketChanges(changes: SourceChange[]): ChangeBuckets {
  return {
    toCompile: changes.filter((c) => c.status === "new" || c.status === "changed"),
    deleted: changes.filter((c) => c.status === "deleted"),
    unchanged: changes.filter((c) => c.status === "unchanged"),
  };
}

/**
 * Phase 2: generate pages for merged concepts in parallel, capturing errors.
 *
 * The merged page set arrives ALREADY computed. It used to be derived here from
 * the extractions, which meant the progress denominator had to re-run the same
 * merge a few lines above just to count pages. Two calls meant two chances to
 * disagree, and any identity decision applied between them would make the
 * denominator count pages the run never wrote.
 */
async function generatePagesPhase(
  root: string,
  merged: MergedConcept[],
  extractions: ExtractionResult[],
  schema: SchemaConfig,
  options: CompileOptions,
  policy: ReviewPolicy,
  concurrency: number,
  pageSink: PageSink | undefined,
  pageRemover: PageRemover | undefined,
  transaction: PageBatchTransaction | undefined,
  contentSource: PageContentSource | undefined,
  curatedStore: CuratedLinkStorePort | undefined,
  progressSink?: CompileProgressReporter,
): Promise<PageGenerationResult> {
  // Publish the denominator as soon as the stage owns it. Announcing the stage
  // clears progress to "unknown" first (reportCompileStage does that on purpose so
  // one stage never inherits another's counts), so the opening 0/N has to be
  // published here, after the transition, or the bar starts blank.
  reportCompileProgress(progressSink, 0, merged.length);
  // Build the per-source state snapshot once so each candidate can carry the
  // exact data needed to mark its sources compiled on approval.
  const shouldBuildSourceStates = !isPolicyOff(policy);
  const sourceStates = shouldBuildSourceStates
    ? await buildExtractionSourceStates(root, extractions)
    : {};
  const limit = pLimit(concurrency);
  // ONE attribution accumulator for the whole run, handed to every page the renderer
  // writes. The renderer records each page's gap into it (the same reading that stamps the
  // page's own frontmatter), and the totals travel on the result so `summarizeCompile` can
  // print them: without that the count of imperfect pages would be visible only in the
  // per-page warnings, one page at a time.
  const attribution = createAttributionSink();
  const renderable = withAttributionSink(merged, attribution);
  // Collect per-outcome errors and candidate info into the ordered outcomes array
  // AFTER Promise.all, then derive candidates/review by iterating outcomes in source order.
  // This ensures stable, source-order ordering regardless of parallel completion timing.
  // Advance the job's counter as each page SETTLES, not as it starts. A page that
  // threw still counts as attempted work, so the count never stalls on a failure;
  // the failure itself is reported through `errors`. Without this the job showed
  // "0 of N" for the whole generation, which is the longest stage.
  let settledPages = 0;
  const outcomes = await Promise.all(
    renderable.map((entry) => limit(async () => {
      try {
        const result = await generateMergedPage(
          root, entry, schema, options, sourceStates, policy, contentSource,
        );
        return { entry, result };
      } finally {
        settledPages += 1;
        reportCompileProgress(progressSink, settledPages, merged.length);
      }
    })),
  );
  const errors: string[] = [];
  const candidates: string[] = [];
  const review = { held: [] as ReviewedCandidateRef[], forced: [] as ReviewedCandidateRef[] };
  for (const { result } of outcomes) {
    if (result.error) errors.push(result.error);
    if (result.candidate) {
      candidates.push(result.candidate.id);
      review[result.candidate.mode].push(result.candidate.ref);
    }
  }
  const pages = outcomes.map(({ entry }) => entry);
  // Apply every live page as ONE journalled executor batch under the held lock,
  // then derive writtenPages from what ACTUALLY committed (skipped pages folded
  // into errors), so finalizeWiki never resolves/embeds an uncommitted page.
  const { writtenPages, batchErrors, curated } = await commitLivePageWrites(
    root, outcomes, pageSink, pageRemover, transaction, curatedStore);
  errors.push(...batchErrors);
  return {
    pages, writtenPages, errors, candidates, review, seedSlugs: [],
    curatedLinks: curated, attribution: attributionCountsOf(attribution),
  };
}

/**
 * Attach the names that folded into each page, so generation can record them.
 *
 * Done here, on the merged set, because the folded names are keyed by the slug the
 * identity stage decided and `mergeExtractions` is what produces that slug: the two
 * are only joinable after the merge. The entry is copied rather than mutated so the
 * merge module stays the only writer of its own records.
 *
 * @param merged - The merged concept pages, in write order.
 * @param aliasesBySlug - Folded-away names per surviving page slug.
 * @returns The same pages, carrying their folded names when they have any.
 */
function withFoldedAliases(
  merged: MergedConcept[],
  aliasesBySlug: ReadonlyMap<string, readonly string[]>,
): MergedConcept[] {
  return merged.map((entry) => {
    const aliases = aliasesBySlug.get(entry.slug);
    return aliases === undefined || aliases.length === 0 ? entry : { ...entry, aliases };
  });
}

/**
 * Attach the run's shared attribution accumulator to every page it will render.
 *
 * Same shape as {@link withRelatedPageIndex}: one object per run, carried on the entries
 * instead of threaded through the candidate/live branches, which keep one signature.
 * @param merged - The merged concept pages, in write order.
 * @param sink - The run's accumulator.
 * @returns The same pages, carrying the accumulator.
 */
function withAttributionSink(
  merged: MergedConcept[],
  sink: AttributionSink,
): MergedConcept[] {
  return merged.map((entry) => ({ ...entry, attribution: sink }));
}

/**
 * Attach the run's shared sibling-page index, so page generation ranks its
 * cross-reference context instead of taking an alphabetical slice of the wiki.
 *
 * The index is read from `wiki/concepts`, which is where page generation reads its
 * context from today: the renderer is handed no page source, so handing it an index
 * built from any other backend would show the prompt pages from a corpus the render
 * does not otherwise see.
 *
 * @param merged - The merged concept pages, in write order.
 * @param index - The sibling pages, read once for the run.
 * @returns The same pages, carrying the index.
 */
function withRelatedPageIndex(
  merged: MergedConcept[],
  index: RelatedPageIndex,
): MergedConcept[] {
  return merged.map((entry) => ({ ...entry, relatedPages: index }));
}

/** One generated-page outcome paired with its source-order merged entry. */
interface GeneratedOutcome {
  entry: MergedConcept;
  result: MergedPageOutcome;
}

/**
 * Apply the live-write outcomes as ONE journalled executor batch, then return
 * the COMMITTED set (HIGH-A): the entries whose write committed become
 * `writtenPages`, while every floor-SKIPPED page is excluded and folded into
 * `batchErrors` (its `floor:` reason). Runs under compile's already-held lock,
 * so it uses the lock-free adapter core. An empty live set opens no batch.
 *
 * THIS IS WHERE CURATED LINKS ARE PUT BACK. Generation REPLACES a page's body with
 * fresh prose, which is the one operation that can destroy a link a reference review
 * curated into it -- and the only channel that would otherwise restore it re-wraps page
 * TITLES, so an alias-anchored curated link would simply be gone. The overlay therefore
 * runs on the fresh bodies immediately before they are planned, re-anchoring each record
 * against the body that is about to be written and forgetting the records whose mention
 * the new prose no longer contains. See `curated-links.ts` for the rule and
 * `curated-links-store.ts` for the file store; WHICH store is the run's decision, taken
 * once in `resolvePageSeams` beside the page seams, so a run cannot write its pages to
 * rows and keep its records on the compiling host.
 *
 * @param root - Project root the writes are confined under.
 * @param outcomes - Source-ordered generation outcomes.
 * @param pageSink - Row writer, or undefined to write files.
 * @param pageRemover - Row remover, or undefined to unlink files.
 * @param transaction - Open batch the writes join, when the caller has one.
 * @param curatedStore - The run's curated-link store, or undefined for the file one.
 * @returns The committed entries, any floor-skip errors, and the overlay's counts.
 */
async function commitLivePageWrites(
  root: string,
  outcomes: GeneratedOutcome[],
  pageSink: PageSink | undefined,
  pageRemover: PageRemover | undefined,
  transaction: PageBatchTransaction | undefined,
  curatedStore: CuratedLinkStorePort | undefined,
): Promise<{
  writtenPages: MergedConcept[];
  batchErrors: string[];
  curated: CuratedLinkCounts;
}> {
  const live = outcomes.filter((o) => o.result.liveWrite);
  const overlaid = live.length === 0
    ? { writes: [], counts: emptyCuratedLinkCounts() }
    : await overlayCuratedPageWrites(root, live.map((o) => o.result.liveWrite!), curatedStore);
  const { skipped } = await applyCompilePageWritesLocked(
    root,
    overlaid.writes,
    pageStoreOptions(pageSink, pageRemover, transaction),
  );
  const skippedKeys = new Set(skipped.map((s) => `${s.item.namespace}/${s.item.slug}`));
  const writtenPages = live
    .filter((o) => !skippedKeys.has(`${o.result.liveWrite!.namespace}/${o.result.liveWrite!.slug}`))
    .map((o) => o.entry);
  const batchErrors = skipped.map(
    (s) => `Page "${s.item.slug}" skipped — ${s.reason}`,
  );
  return { writtenPages, batchErrors, curated: overlaid.counts };
}

/** Persist source state for every extraction that produced concepts.
 *
 * State records only LIVE concepts per source — slugs that were actually
 * written to wiki/ this run. Held or rejected concepts are never recorded
 * as compiled; approval adds the approved slug via persistCandidateSourceStates.
 * A source whose concepts are all held records hash + empty concepts list.
 */
async function persistExtractionStates(
  draft: CompileStateDraft,
  extractions: ExtractionResult[],
  writtenPages: MergedConcept[],
  retained: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Build a set of live slugs per source: slugs from writtenPages that list
  // this source as a contributor.
  const liveSlugsForSource = buildLiveSlugsForSource(writtenPages);
  for (const result of extractions) {
    // Reused contributors keep their complete committed ownership, including
    // concepts outside this run's page set and shared pages held for review.
    if (result.reused || result.concepts.length === 0) continue;
    const liveSlugs = new Set(liveSlugsForSource.get(result.sourceFile) ?? []);
    // A slug held for another attempt is still OWNED by the source that
    // extracted it. Recording only WRITTEN slugs drops that claim, and unlike a
    // review hold nothing re-adds it: the retry re-extracts whichever sources
    // still list the concept, so a survivor erased here never returns and the
    // page is rebuilt without its contribution.
    for (const concept of result.concepts) {
      const slug = slugify(concept.concept);
      if (retained.has(slug)) liveSlugs.add(slug);
    }
    await persistSourceStateFiltered(
      draft, result.sourceFile, result.concepts, liveSlugs, result.sourceContent,
    );
    draft.setSource(result.sourceFile, withExtractionSnapshot(
      draft.read().sources[result.sourceFile], result, liveSlugsForSource.get(result.sourceFile),
    ));
  }
}

/**
 * Every concept slug this run's extractions produced, in the shape `state.json` records.
 *
 * The ownership a scoped regeneration must keep: it re-extracts the sources that answer
 * for the pages it regenerates, and a full compile of those same sources would have
 * recorded ALL of their concepts as owned. Only one page is written here, so the rest are
 * handed to the state writer as retained rather than dropped.
 *
 * @param extractions - This run's canonical extractions.
 * @returns The owned slugs.
 */
function extractedConceptSlugs(extractions: ExtractionResult[]): Set<string> {
  const slugs = new Set<string>();
  for (const result of extractions) {
    for (const concept of result.concepts) slugs.add(slugify(concept.concept));
  }
  return slugs;
}

/** Build a map from source filename to the slugs written live this run. */
function buildLiveSlugsForSource(writtenPages: MergedConcept[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const page of writtenPages) {
    for (const sourceFile of page.sourceFiles) {
      const existing = map.get(sourceFile) ?? [];
      existing.push(page.slug);
      map.set(sourceFile, existing);
    }
  }
  return map;
}

/** Persist source state, filtering concepts to only those in the live set. */
async function persistSourceStateFiltered(
  draft: CompileStateDraft,
  sourceFile: string,
  concepts: ReturnType<typeof parseConcepts>,
  liveSlugs: Set<string>,
  sourceContent: string,
): Promise<void> {
  // Hash the content already in memory instead of re-reading the file. MUST use
  // the same basis as change detection (`hashFile`) and the Stack's stored
  // `content_hash`, both of which hash `stableContent` — frontmatter minus the
  // volatile `ingestedAt`. Recording a raw-bytes digest here made the persisted
  // hash unequal to the one detection compares against, so every source looked
  // changed forever and extraction re-ran on every compile.
  const hash = createHash("sha256").update(stableContent(sourceContent), "utf-8").digest("hex");
  const entry: SourceState = {
    hash,
    concepts: concepts.map((c) => slugify(c.concept)).filter((s) => liveSlugs.has(s)),
    compiledAt: new Date().toISOString(),
    ...sourceIdentityOf(sourceContent),
  };
  draft.setSource(sourceFile, entry);
}

/**
 * Read the source identity out of a source file's frontmatter.
 *
 * Recorded so the source can still be NAMED after its file is deleted: `forget`
 * needs the identity the graph was written under, and the file is the only other
 * place it lives. A file with no usable `source` contributes no field at all,
 * which reads downstream as "identity unknown" rather than as an empty string that
 * would be matched against the graph.
 *
 * @param content - Full source file text, frontmatter included.
 * @returns `{ source }` when a non-empty string is present, otherwise `{}`.
 */
function sourceIdentityOf(content: string): { source?: string } {
  try {
    const value = parseFrontmatter(content).meta["source"];
    return typeof value === "string" && value.trim() !== "" ? { source: value } : {};
  } catch {
    // Malformed frontmatter is a compile-warning concern elsewhere; here it only
    // means the identity is unknown.
    return {};
  }
}

/**
 * Snapshot page IDs already on disk before a compile run, namespaced by
 * directory (e.g. `wiki/concepts/foo`, `wiki/queries/foo`). Namespacing keeps
 * the created/updated split correct when a concept and a query share a slug.
 */
async function listExistingPageIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of [CONCEPTS_DIR, QUERIES_DIR]) {
    try {
      const files = await readdir(path.join(root, dir));
      for (const file of files) {
        if (file.endsWith(".md")) ids.add(`${dir}/${file.slice(0, -3)}`);
      }
    } catch {
      // Directory may not exist yet on a first compile — nothing to snapshot.
    }
  }
  return ids;
}

/**
 * Apply `options.changeFilter` to the full detected change set.
 * When no filter is provided, returns the original list unchanged.
 * Separating this keeps `runCompilePipeline` below the cyclomatic threshold.
 */
function applyChangeFilter(
  detected: SourceChange[],
  filter: CompileOptions["changeFilter"],
): SourceChange[] {
  return filter ? detected.filter(filter) : detected;
}


/**
 * Orphan and clear persisted frozen slugs that no source owns.
 * @returns True when the draft was mutated and must be flushed.
 */
async function reconcileOwnerlessFrozen(
  root: string,
  draft: CompileStateDraft,
  reconciliationSlugs: ReadonlySet<string>,
  seams: PageSeams = {},
): Promise<boolean> {
  if (reconciliationSlugs.size === 0) return false;
  await orphanUnownedFrozenPages(
    root, draft, new Set(reconciliationSlugs), seams.content, seams.sink, seams.remover);
  draft.setFrozen(new Set());
  return true;
}

/**
 * Generate seed pages unless `skipSeedPages` is set.
 * Centralises the guard so each call site in the pipeline is a single
 * unconditional statement instead of an inline if-block.
 */
async function maybeSeedPages(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  seams: PageSeams,
): Promise<void> {
  if (!options.skipSeedPages) {
    await generateSeedPages(
      root, schema, generation, seams.content, seams.sink, seams.remover,
      seams.transaction, seams.curatedLinks);
  }
}

/**
 * The SHARED seed→finalize routing both pipeline branches use, so the seed batch
 * (in {@link generateSeedPages}) and the resolution batch (in {@link finalizeWiki})
 * stay routed through the executor on BOTH the normal path AND the
 * no-source-changes early-return path. Extracting it prevents the early branch
 * from drifting back to a direct write. Pass `draft = null` for the early branch
 * (no state mutations to flush).
 */
async function seedThenFinalize(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  draft: CompileStateDraft | null,
  embeddingStore?: EmbeddingStoreLocation,
  resolverSource?: ResolverPageSource,
  embeddingPageSource?: EmbeddingPageSource,
  seams: PageSeams = {},
  stateRows?: WikiStateRowsBackend,
  totals?: RunReportTotals,
): Promise<void> {
  await maybeSeedPages(root, schema, generation, options, seams);
  // A scoped regeneration rewrites exactly the pages it named, so it also must not record
  // the prompt-modifier selection as true of the whole project (see the flush in
  // `finalizeWiki`) and must not run the stages that edit other pages.
  const regenerating = recompileRequest() !== undefined;
  await finalizeWiki(root, draft, generation.writtenPages, generation.seedSlugs, {
    // The run's environment, taken from the options THIS run was given and resolved
    // ONCE, here: it is the same value the pipeline derives for every other seam, and
    // `finalizeWiki`'s derived-artifact write must land in that Stack rather than in
    // whatever `process.env` happens to name. Omitted stays `process.env`, which is
    // exactly what the CLI passes.
    env: options.env ?? process.env,
    scoped: options.changeFilter !== undefined || regenerating,
    regenerateOnly: regenerating,
    embeddings: options.embeddings !== false,
    embeddingStore,
    resolverSource,
    embeddingPageSource,
    seams,
    stateRows,
    totals,
    jobObserver: options.jobObserver,
  });
}

/**
 * Load the two documents a compile is configured by, from ONE environment.
 *
 * Grouped rather than inlined because both resolve against the run's Stack: a
 * schema from disk and a review policy from a DIFFERENT tenant would be a run
 * reviewed by rules nobody chose. Extracting it also keeps `runCompilePipeline`
 * inside its complexity ceiling, which is how the duplication stayed invisible
 * before — the policy loader used to re-derive `options.env ?? process.env`
 * instead of reusing the `env` already computed two lines above.
 *
 * @param root - Project root, used by the schema and the file config.
 * @param env - The one environment this run reads.
 * @returns Both documents.
 */
async function loadRunConfiguration(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ schema: Awaited<ReturnType<typeof loadSchema>>; reviewPolicy: ReviewPolicy }> {
  const [schema, reviewPolicy] = await Promise.all([
    loadSchema(root),
    loadReviewPolicy(root, env),
  ]);
  return { schema, reviewPolicy };
}

/**
 * Post-generation bookkeeping: the state writes and page retirements that follow
 * a committed page set.
 *
 * Grouped because the ordering inside carries the meaning: state ownership is
 * recorded first (so the alias page below is provably not owned), then the folded
 * pages are retired, then frozen slugs are pruned against what this run actually
 * replaced.
 */
interface LiveOutcomeInput {
  readonly root: string;
  readonly draft: CompileStateDraft;
  readonly seams: PageSeams;
  readonly canonicalExtractions: ExtractionResult[];
  readonly generation: PageGenerationResult;
  readonly identity: ConceptIdentityOutcome;
  /** Mutable set: `persistFrozenSlugs` prunes it in place against this run. */
  readonly frozenSlugs: Set<string>;
  readonly reconciliationSlugs: ReadonlySet<string>;
  /**
   * Extra slugs whose ownership must survive this run although no page was written for
   * them.
   *
   * Set by a SCOPED regeneration (`compileRecompiling`), which writes one page
   * out of sources that produced several. The state writer otherwise records only what
   * this run WROTE, so without this a single-page regeneration would leave every sibling
   * page it did not touch with no recorded owner — and the next compile would read those
   * pages as orphaned.
   */
  readonly retainSlugs?: ReadonlySet<string>;
}

/**
 * Record this run's ownership, retire folded alias pages, and prune frozen slugs.
 *
 * @param input - The committed page set and the state it has to be recorded in.
 */
async function commitLiveOutcome(input: LiveOutcomeInput): Promise<void> {
  const { root, draft, seams, canonicalExtractions, generation, identity } = input;
  const { frozenSlugs, reconciliationSlugs } = input;
  const written = new Set(generation.writtenPages.map((entry) => entry.slug));
  const retained = new Set(
    [...reconciliationSlugs, ...frozenSlugs, ...(input.retainSlugs ?? [])].filter((slug) => !written.has(slug)),
  );
  await persistExtractionStates(draft, canonicalExtractions, generation.writtenPages, retained);
  // Retire the pages of concept names that folded into another concept. Runs after
  // the writes commit so a canonical page exists before its alias stops being
  // served, and after ownership was recorded so nothing still claims the alias.
  if (identity.superseded.size > 0) {
    await orphanSupersededAliasPages(
      root, identity.superseded, seams.content, seams.sink, seams.remover);
  }
  const orphanCandidates = new Set([...reconciliationSlugs, ...frozenSlugs]);
  if (orphanCandidates.size > 0) {
    await orphanUnownedFrozenPages(
      root, draft, orphanCandidates, seams.content, seams.sink, seams.remover);
  }
  persistFrozenSlugs(draft, frozenSlugs, canonicalExtractions, {
    pending: reconciliationSlugs,
    replaced: written,
  });
}

/**
 * Everything the page-generation stage needs; grouped so the call stays one
 * argument and a caller cannot transpose two same-typed positional values.
 */
interface GenerationStageInput {
  readonly root: string;
  readonly extractions: ExtractionResult[];
  readonly frozenSlugs: Set<string>;
  readonly reconciliationSlugs: ReadonlySet<string>;
  readonly schema: SchemaConfig;
  readonly options: CompileOptions;
  readonly reviewPolicy: ReviewPolicy;
  readonly concurrency: number;
  readonly seams: PageSeams;
  readonly compileReporter: CompileProgressReporter | undefined;
  /**
   * The pages a SCOPED regeneration was asked for, when the run has one.
   *
   * The merge produces every concept the re-extracted sources answer for, because that is
   * what makes a page's content complete. A regeneration was asked for ONE page, so the
   * merged set is narrowed to it here: writing the siblings too would rewrite pages the
   * operator never asked about, which is exactly what the lever must not do.
   */
  readonly regenerateOnly?: ReadonlySet<string>;
}

/** What the generation stage hands back to the pipeline. */
interface GenerationStageOutcome {
  readonly identity: ConceptIdentityOutcome;
  /** The extractions carrying canonical concept names, for the state writes. */
  readonly canonicalExtractions: ExtractionResult[];
  readonly generation: PageGenerationResult;
  /** Page ids as they were before the run, so the journal can split new/updated. */
  readonly existingIds: Set<string>;
}

/**
 * Decide concept identity, then generate pages from that ONE decision.
 *
 * Extracted from `runCompilePipeline` because the ordering here is the whole
 * point and reading it inline was getting lost: identity first (it rewrites the
 * names), then the merge (it slugs them), then the denominator (it counts what
 * that same merged list contains), then the work. A second, independent merge for
 * the count is exactly how a progress bar comes to report pages nobody wrote.
 *
 * @param input - The stage's resolved pipeline state.
 * @returns The identity decision, the canonical extractions, and the generation.
 */
async function runGenerationStage(
  input: GenerationStageInput,
): Promise<GenerationStageOutcome> {
  const { root, extractions, frozenSlugs, reconciliationSlugs } = input;
  // Snapshot pages on disk before generation so the journal can tell which
  // produced pages are new (created) versus overwritten (updated). The same
  // snapshot supplies the incumbent slugs identity resolution must preserve.
  const existingIds = await listExistingPageIds(root);
  // Identity needs more than the slug list: the alias tier compares a candidate
  // against the names each existing page already answers to, so the snapshot
  // carries titles and declared aliases as well.
  const incumbents = await snapshotIncumbentConcepts(root, input.seams.content);
  const identity = await applyConceptIdentity(extractions, incumbents);
  const canonicalExtractions = identity.extractions;
  // The ONLY stage with a real denominator the pipeline computes before the work:
  // one merged concept becomes one generated page, so the number of MERGED entries
  // is the total -- not the number of SOURCE files. Counting sources understated
  // the work by orders of magnitude: one document yielding 92 concepts reported
  // "1", so the job sat at "0 of 1" for the entire run. The SAME list is handed to
  // the phase below, so the denominator and the work cannot diverge.
  const mergedWithAliases = withFoldedAliases(
    mergeExtractions(canonicalExtractions, frozenSlugs, reconciliationSlugs),
    identity.aliasesBySlug,
  );
  // A scoped regeneration narrows the merged set to the pages it was asked for. The merge
  // itself stays whole, so the page that IS generated carries every contributing source.
  const scopedMerged = input.regenerateOnly === undefined
    ? mergedWithAliases
    : mergedWithAliases.filter((entry) => input.regenerateOnly?.has(entry.slug) === true);
  // Read the sibling pages ONCE for the whole run: ranking cross-reference context
  // needs every sibling's text, and reading it per page would make one compile pay
  // pages x pages confined reads for context no reader ever sees. A run with nothing
  // to render reads nothing.
  const merged = scopedMerged.length === 0
    ? scopedMerged
    : withRelatedPageIndex(scopedMerged, await buildRelatedPageIndex(root));
  const generation = await timeStage("compile.page-generation", () => generatePagesPhase(
    root,
    merged,
    canonicalExtractions,
    input.schema,
    input.options,
    input.reviewPolicy,
    input.concurrency,
    input.seams.sink,
    input.seams.remover,
    input.seams.transaction,
    input.seams.content,
    input.seams.curatedLinks,
    input.compileReporter,
  ), () => reportCompileStage(input.compileReporter, "compile.page-generation"));
  reportCompileProgress(
    input.compileReporter,
    generation.writtenPages.length,
    Math.max(merged.length, generation.writtenPages.length),
  );
  return { identity, canonicalExtractions, generation, existingIds };
}

/** Inner pipeline, runs under lock protection. Returns structured CompileResult. */
/** Everything the no-change path needs; grouped so the call stays one argument. */
interface NothingToCompileInput {
  readonly root: string;
  readonly options: CompileOptions;
  readonly db: DimensionsDatabaseHandle;
  readonly env: NodeJS.ProcessEnv;
  readonly schema: Awaited<ReturnType<typeof loadSchema>>;
  readonly draft: CompileStateDraft;
  readonly seams: ReturnType<typeof resolvePageSeams>;
  readonly stateRows: ReturnType<typeof wikiStateRowsBackend>;
  readonly reconciliationSlugs: ReadonlySet<string>;
  readonly unchangedCount: number;
}

/**
 * The "all sources up to date" early return.
 *
 * Extracted from `runCompilePipeline` because the block is only reached on a run with
 * nothing to do, and keeping it inline pushed that function past its complexity
 * ceiling. The behaviour is unchanged, including the seed-page regeneration that makes
 * a schema edit take effect without touching a source file.
 *
 * @param input - The resolved pipeline state this branch needs.
 * @returns The compile result for a run with no changes.
 */
async function finalizeNothingToCompile(
  input: NothingToCompileInput,
): Promise<CompileResult> {
  const { root, options, db, env, schema, draft, seams, stateRows, reconciliationSlugs } = input;
  output.status("✓", output.success("Nothing to compile — all sources up to date."));
  // Seed pages are cheap deterministic writes — always run them even when no source
  // files changed, so adding a seed page to schema.json takes effect on the next
  // compile without needing a source file edit.
  const hasOwnerlessFrozen = await reconcileOwnerlessFrozen(
    root, draft, reconciliationSlugs, seams,
  );
  const emptyGeneration: PageGenerationResult = {
    pages: [], writtenPages: [], errors: [], candidates: [],
    review: { held: [], forced: [] }, seedSlugs: [],
    // Created here rather than left undefined: seed pages are regenerated on this
    // path too, and the overlay they run folds its counts into this SAME object.
    curatedLinks: emptyCuratedLinkCounts(),
  };
  // Ownerless frozen reconciliation mutates the draft; otherwise null keeps the
  // no-change path from rewriting state unnecessarily.
  await timeStage("compile.finalize", () => seedThenFinalize(
    root,
    schema,
    emptyGeneration,
    options,
    hasOwnerlessFrozen ? draft : null,
    embeddingStoreLocation(db),
    resolverSourceReading(db, env),
    embeddingPageReading(db, env),
    seams,
    stateRows,
    // Seed pages are regenerated on this path too, so their links are gated and
    // reported per page; the run total has no compile result to ride on here.
    {
      linkCounts: emptyContextualLinkCounts(),
      linkReview: emptyLinkReviewCounts(),
      curatedLinks: emptyGeneration.curatedLinks as CuratedLinkCounts,
      // No article is written on this path, so no page can be assigned to a category.
      categories: emptyCategoryAssignmentCounts(),
    },
  ));
  // The version line is printed HERE rather than by `summarizeCompile`, because this
  // branch never builds a result to carry it — and the rule is that the line appears on
  // EVERY run, including one that changed nothing (a line that sometimes disappears is
  // indistinguishable from a broken one).
  reportVersionSplit(await readVersionSplit(root, seams.content));
  return {
    ...emptyCompileResult(),
    skipped: input.unchangedCount,
    // Surface seed-page slugs alongside any errors so downstream consumers (MCP,
    // embeddings, programmatic callers) can see what landed even on the
    // no-source-changes early-return path.
    pages: [...emptyGeneration.seedSlugs],
    errors: emptyGeneration.errors,
  };
}

async function runCompilePipeline(
  root: string,
  options: CompileOptions,
  db: DimensionsDatabaseHandle,
): Promise<CompileResult> {
  const startMs = Date.now();
  // The ONE environment this run reads. Every seam below is handed this value
  // instead of the ambient one, so a caller can compile into a chosen Stack and two
  // concurrent runs cannot see each other's. Omitted means `process.env`, which keeps
  // every existing caller byte-identical.
  const env = options.env ?? process.env;
  // The ONE dimensions resolution this run performs, resolved here rather than inside
  // the helper that asks for it: a default built per deleted source would be a second
  // answer to one question, and the caller's port must be the one retirement uses.
  const dimensionsPort = dimensionsPortFor(options);
  const { schema, reviewPolicy } = await loadRunConfiguration(root, env);
  reportSchemaStatus(schema);
  // Single in-memory draft of state.json for the whole run. Every intra-compile
  // state read/write goes through it; the durable marker advances only at the
  // SINGLE flush after the resolution phase commits (see finalizeWiki below).
  // Read and write state from the SAME backend. A run that seeded from
  // `state.json` and flushed to rows would report every source as new on the next
  // pass, because the file it compared against was never the one updated.
  const stateRows = wikiStateRowsBackend(db, env);
  const draft = await CompileStateDraft.load(root, stateRows);
  const state = draft.read();
  // Resolve every page seam ONCE, from one variable: a run that stores rows while
  // repairing files -- or reads rows while writing `wiki/` -- would split the
  // corpus in half and is the defect this migration kept re-introducing.
  const seams = resolvePageSeams(db, env);
  const compileReporter = options.jobObserver?.compile;
  const detected = await timeStage("compile.detect-changes", () =>
    detectChanges(root, state, sourceChangeDetection(db, env), env),
    () => reportCompileStage(compileReporter, "compile.detect-changes"));
  // A `--recompile` request is resolved and VALIDATED before any work, so an unusable
  // one is a refusal that wrote nothing rather than a run that silently did nothing.
  const scope = await resolveRunScope(root, state, detected, options, seams);
  if (!isRunScope(scope)) return scope;
  const changes = scope.changes;
  await markUnchangedPendingSources(root, changes, sourceContentReading(db, env));
  const reusableSources = reusableSourceFiles(state, changes, detected);
  augmentWithAffectedSources(changes, findAffectedSources(state, changes, detected));
  const reconciliationSlugs = findReconciliationSlugs(state, changes);

  const buckets = bucketChanges(changes);
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    return await finalizeNothingToCompile({
      root, options, db, env, schema, draft, seams, stateRows,
      reconciliationSlugs, unchangedCount: buckets.unchanged.length,
    });
  }

  printChangesSummary(changes);
  const forgetErrors: string[] = [];
  // Capture the identities HERE, before orphaning: `state` is the LIVE object
  // `draft.read()` handed out, and the next call deletes these very entries. A read
  // after it can only find `undefined`, which is how graph retirement went two
  // verifiers without retiring a single source.
  const retiredIdentities = deletedSourceIdentities(state, buckets.deleted);
  await markDeletedAsOrphaned(root, buckets.deleted, draft, seams);
  // Graph retirement reuses the identities captured above rather than re-reading the
  // state the orphaning just deleted them from.
  forgetErrors.push(
    ...(await forgetDeletedSources(root, retiredIdentities, db, env, dimensionsPort)),
  );

  // Only extraction failures in THIS run freeze a page. Deletion and persisted
  // freezes are reconciliation work: their surviving owners rebuild cleanly.
  const frozenSlugs = new Set<string>();

  // Resolve once so an invalid override warns a single time, then cap both the
  // extraction and page-generation fan-outs identically.
  const concurrency = resolveCompileConcurrency(options.concurrency);
  const extractions = await timeStage("compile.extraction", () => runExtractionPhases(
    root, buckets.toCompile, state, { scoped: changes, detected }, concurrency, reusableSources,
    sourceContentReading(db, env),
    // The extraction prompt asks the model not to duplicate an existing concept,
    // which needs each page's title -- the scan shape, not the listing.
    scanSourceReading(db, env),
    // Extraction is often the longest stage, so it reports its own per-source
    // count instead of sitting at "working" for minutes.
    {
      report: (completed, total) =>
        reportCompileProgress(compileReporter, completed, total),
    },
  ), () => reportCompileStage(compileReporter, "compile.extraction"));
  recordExtractionFreezes(draft, extractions, frozenSlugs);

  const { identity, canonicalExtractions, generation, existingIds } = await runGenerationStage({
    root, extractions, frozenSlugs, reconciliationSlugs, schema, options,
    reviewPolicy, concurrency, seams, compileReporter,
    regenerateOnly: slugsToRegenerate(scope.recompilePlan),
  });

  await commitLiveOutcome({
    root, draft, seams, canonicalExtractions, generation, identity,
    frozenSlugs, reconciliationSlugs,
    // A scoped regeneration writes ONE page out of the sources it re-extracted. Every
    // other concept those sources produced is still owned by them, so ownership is
    // retained explicitly: filtering the generated page set must never look, to the
    // next compile, like a source that stopped producing what it still produces.
    retainSlugs: retainedForScope(scope.recompilePlan, canonicalExtractions),
  });
  // The run's link totals are collected in place by the link gate, which runs in
  // the resolution seam below — after every page of the run exists, which is the
  // only point where a link into a page this run created can be judged fairly.
  const totals: RunReportTotals = {
    linkCounts: emptyContextualLinkCounts(),
    linkReview: emptyLinkReviewCounts(),
    // The generation overlay already counted what it restored while writing pages;
    // the review stage below folds its own recording into the SAME object.
    curatedLinks: generation.curatedLinks ?? emptyCuratedLinkCounts(),
    // Filled by the category assignment stage, which runs after every page of the
    // run is final: a membership is recorded against the page the wiki now serves.
    categories: emptyCategoryAssignmentCounts(),
  };
  // Seed + resolution route through the SAME executor batches as the
  // no-source-changes branch (see seedThenFinalize). The draft flush is the
  // single durable state write, done inside finalizeWiki after resolution
  // commits.
  await timeStage("compile.finalize", () => seedThenFinalize(
    root, schema, generation, options, draft, embeddingStoreLocation(db),
    resolverSourceReading(db, env),
    embeddingPageReading(db, env),
    seams,
    stateRows,
    totals,
  ), () => reportCompileStage(compileReporter, "compile.finalize"));
  const reportGeneration: PageGenerationResult = {
    ...generation,
    linkCounts: totals.linkCounts,
    linkReview: totals.linkReview,
    curatedLinks: totals.curatedLinks,
    categories: totals.categories,
    // Read AFTER the run wrote its pages, so the split describes the wiki the operator
    // now has rather than the one the run found.
    versionSplit: await readVersionSplit(root, seams.content),
  };
  await logCompile(root, buckets, reportGeneration, existingIds, env);
  verbose(`compile finished in ${Date.now() - startMs} ms`);
  return summarizeCompile(buckets, reportGeneration, canonicalExtractions, options, forgetErrors);
}

/**
 * Freeze the pages whose source extraction failed this run, and report them.
 *
 * Only extraction failures of THIS run freeze a page: deletion and persisted freezes are
 * reconciliation work whose surviving owners rebuild cleanly.
 *
 * @param draft - The run's state draft.
 * @param extractions - This run's extraction results.
 * @param frozenSlugs - Mutable set the freeze is recorded into.
 */
function recordExtractionFreezes(
  draft: CompileStateDraft,
  extractions: ExtractionResult[],
  frozenSlugs: Set<string>,
): void {
  freezeFailedExtractions(draft, extractions, frozenSlugs);
  reportFrozenSlugs(frozenSlugs);
}

/**
 * Treat unchanged pending-candidate sources as skipped to avoid LLM churn.
 *
 * A candidate only covers this run's work when it matches on BOTH counts: the
 * source bytes, and the prompt modifiers it was generated under. The bytes stay
 * identical across a modifier change while the candidate's wording goes stale,
 * so a hash-only test demotes the promotion made moments earlier and reports
 * "Nothing to compile" with a candidate nobody asked for still pending.
 *
 * The candidate's OWN digest is the comparison, not the project's: a project whose
 * recorded digest is absent would otherwise make clearing a modifier look like no
 * change, because "none selected" is exactly what an absent digest means.
 */
async function markUnchangedPendingSources(
  root: string,
  changes: SourceChange[],
  contentSource?: SourceContentSource,
): Promise<void> {
  const pending = await collectPendingSourceStates(root);
  if (pending.size === 0) return;
  const requested = promptModifiersDigest();
  for (const change of changes) {
    if (change.status !== "new" && change.status !== "changed") continue;
    const entry = pending.get(change.file);
    if (!entry || entry.modifiers !== requested) continue;
    const currentHash = contentSource === undefined
      ? await hashFile(path.join(root, SOURCES_DIR, change.file))
      : await currentContentHash(contentSource, change.file);
    if (currentHash === entry.hash) change.status = "unchanged";
  }
}

/**
 * Source hash + modifier snapshots currently held inside pending candidates.
 *
 * A candidate written before the digest was recorded reads as "none selected",
 * matching how an absent state digest is read.
 */
async function collectPendingSourceStates(
  root: string,
): Promise<Map<string, { hash: string; modifiers: string }>> {
  const states = new Map<string, { hash: string; modifiers: string }>();
  for (const candidate of await listCandidates(root)) {
    const modifiers = candidate.promptModifiers ?? "";
    for (const [source, entry] of Object.entries(candidate.sourceStates ?? {})) {
      states.set(source, { hash: entry.hash, modifiers });
    }
  }
  return states;
}

/** Append affected-source changes (logging each addition) to the change list. */
function augmentWithAffectedSources(changes: SourceChange[], affected: string[]): void {
  for (const file of affected) {
    output.status("~", output.info(`${file} [affected by shared concept]`));
    changes.push({ file, status: "changed" });
  }
}

/** Mark wiki pages owned solely by deleted sources as orphaned. */
async function markDeletedAsOrphaned(
  root: string,
  deleted: SourceChange[],
  draft: CompileStateDraft,
  seams: PageSeams = {},
): Promise<void> {
  for (const del of deleted) {
    await markOrphaned(
      root, del.file, draft, seams.content, seams.sink, seams.remover, seams.transaction);
  }
}

/**
 * The dimensions retirement reads from. Only the graph: the wiki owns its own
 * removal story, so asking for it would demand a Stack this path never needs.
 */
const RETIREMENT_DIMENSIONS: readonly DimensionName[] = ["kg"];

/**
 * The dimensions port this run resolves through.
 *
 * The caller's, when it supplied one, and otherwise this build's default — composed
 * here, once per run, because it is cheap and connects to nothing. OMITTING the option
 * is therefore VALID rather than fatal: an embedder reaching a compile through
 * `createWiki().compile()` keeps working, and the run resolves exactly what it always
 * resolved.
 *
 * A helper rather than an inline `??` so the pipeline's own branch count does not grow
 * for a decision `compile` does not make.
 *
 * @param options - The options this run was given.
 * @returns The caller's port, or the default one.
 */
function dimensionsPortFor(options: CompileOptions): DimensionsPort<Dimension> {
  return options.dimensionsPort ?? createDefaultDimensionsPort();
}

/**
 * The graph dimensions retirement needs, bound to the Stack this run resolved.
 *
 * TWO OWNERS, on purpose, and the split is the whole contract here:
 *
 *   - the PORT owns resolution. It is the caller's injected answer to "which
 *     dimensions does this deployment have", so a run handed one retires from that
 *     graph rather than from the ambient switch, and this function builds no
 *     dimension itself.
 *   - the PRE-CHECK keeps its own read of the switch, through
 *     `resolveStackForDimensions`. It answers a different question -- does a default
 *     Stack have to be provisioned at all -- and it must be answered BEFORE anything
 *     is resolved: a workspace with no Stack configured gets the default one
 *     provisioned on first use, so resolving unconditionally would make every
 *     wiki-only compile, the ordinary case, open a connection for a dimension it
 *     never uses.
 *
 * The pre-check cannot move into the port. `DimensionsRequest.stackId` is optional
 * only in the sense that omitting it is INVALID: a resolution without it falls
 * through to the required `AKS_STACK_ID` and refuses. So the Stack id the port needs
 * is a value only the pre-check produces, and routing the pre-check through the port
 * would turn "graph disabled -> no work, no connection, no throw" into a throw for
 * every stackless wiki-only compile.
 *
 * When the answer is "nothing to do" it returns no dimensions and asks the port
 * nothing, so the database the pre-check spared stays untouched.
 *
 * @param root - Project root, for dimension resolution.
 * @param db - Database handle every dimension is backed by.
 * @param env - The one environment this run reads.
 * @param port - The injected dimensions port this run resolves through.
 * @returns The graph dimensions to retire from; empty when the graph is disabled.
 * @throws Whatever the pre-check or the port throws for an unknown dimension name —
 *   it is raised there, unchanged, and never caught here to steer this decision.
 */
async function graphRetirementDimensions(
  root: string,
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv,
  port: DimensionsPort<Dimension>,
): Promise<readonly Dimension[]> {
  const stackId = await resolveStackForDimensions(db, env, RETIREMENT_DIMENSIONS);
  if (stackId === undefined) return [];
  // The SAME environment the pre-check just read: a switch taken from one place and
  // dimensions built from another is two answers to one question, and the run that
  // enables the graph through `options.env` would resolve a Stack and then build
  // nothing from it.
  return port.resolve({ root, db, env, only: RETIREMENT_DIMENSIONS, stackId });
}

/**
 * The recorded identities of the deleted sources, read while state still holds them.
 *
 * WHY THIS IS ITS OWN STEP, AND WHY IT RUNS BEFORE ORPHANING. `state` is the LIVE
 * object `draft.read()` returns — `compile-state-draft.ts:73`, "returns the LIVE
 * internal reference, not a copy" — and `markDeletedAsOrphaned` empties exactly these
 * entries via `draft.removeSource(...)` → `removeSourceFrom` →
 * `delete state.sources[...]` (`utils/state.ts:274`). An identity read AFTER that call
 * therefore always misses: if the entry existed, orphaning just deleted it; if it did
 * not, `orphan.ts:54` returned early and the read misses anyway. That is how graph
 * retirement stayed dead for two verifiers while every log line looked healthy.
 * Capturing first is the whole fix; retiring from a clone instead would break the
 * extraction phase that consumes this same live object afterwards (`index.ts:1207`–`:1208`).
 *
 * TOLERANT BY DESIGN. A state entry can be missing, and `SourceState.source` is absent
 * for pre-v2 state and for files whose frontmatter carried no identity, so only
 * defined identities survive. Guessing one from the filename would be worse than doing
 * nothing: the filename is a title slug, never the identity the graph was written
 * under, so a guess would retire either nothing or the wrong document.
 *
 * NO DE-DUPLICATION, deliberately. One deleted FILE cannot appear twice in
 * `buckets.deleted` — it holds one entry per state key (`hasher.ts:172`–`:196`), and
 * the only later addition is `augmentWithAffectedSources`, which pushes `changed`.
 * Two DIFFERENT entries can name the same identity, and that needs nothing here:
 * `Dimension.forget` must be idempotent and must tolerate an unknown source
 * (`dimensions/types.ts:313`), so a repeated retirement is a no-op, not a second
 * deletion.
 *
 * @param state - The run's live state, still holding every deleted source's entry.
 * @param deleted - Source changes already classified as deletions.
 * @returns One identity per deleted source that recorded one, in bucket order.
 */
function deletedSourceIdentities(
  state: WikiState,
  deleted: readonly SourceChange[],
): string[] {
  const identities: string[] = [];
  for (const change of deleted) {
    const source = state.sources[change.file]?.source;
    if (source !== undefined) identities.push(source);
  }
  return identities;
}

/**
 * Retire deleted sources from every registered dimension that is not the wiki.
 *
 * WHY THIS EXISTS. `compile` already marks a deleted source's pages orphaned, but
 * until the port gained `forget` nothing told the GRAPH. A removed source left its
 * document, chunks, entities, and contributions in Postgres forever, so the graph
 * kept answering with text the project no longer had.
 *
 * The wiki is skipped because it owns its own removal story (`markDeletedAsOrphaned`
 * preserves pages other sources still support); retiring here too would duplicate
 * that decision in a second place.
 *
 * @param root - Project root, for dimension resolution.
 * @param sources - Identities captured by {@link deletedSourceIdentities} BEFORE
 *   orphaning removed their state entries. Passed in rather than re-read from state
 *   because that read is exactly the one that always missed.
 * @param db - Database handle every dimension is backed by.
 * @param env - The one environment this run reads, used to resolve the Stack.
 * @param port - The dimensions port the run resolves through.
 * @returns One message per (source, dimension) pair whose `forget` threw.
 */
async function forgetDeletedSources(
  root: string,
  sources: readonly string[],
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv,
  port: DimensionsPort<Dimension>,
): Promise<string[]> {
  const failures: string[] = [];
  // Graph retirement is the ONLY concern here, so ask for the graph dimension
  // alone (`only`) instead of building every enabled dimension and filtering the
  // wiki out. Building and discarding was harmless while the wiki was
  // file-backed; it is Postgres-backed now, so resolving it demands a Stack id
  // this path never needed. `only` also respects the switch: a project that never
  // enabled `kg` retires nothing here, exactly as before.
  const dimensions = await graphRetirementDimensions(root, db, env, port);
  if (dimensions.length === 0) return failures;
  for (const source of sources) {
    for (const dimension of dimensions) {
      try {
        await dimension.forget(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`forget(${dimension.name}) failed for ${source}: ${reason}`);
      }
    }
  }
  return failures;
}

/**
 * Behavioural switches for {@link finalizeWiki}, named rather than positional.
 *
 * They arrive as an object because they are same-typed booleans that each
 * INVERT a behaviour: as adjacent positional parameters, transposing two of
 * them type-checks silently and the compile does the opposite of what the
 * caller asked, on paths whose whole point is that they run less than the
 * default. One flag was tolerable; a second one arriving is the signal to name
 * them rather than to add a sixth parameter.
 */
interface FinalizeFlags {
  /**
   * The RUN's environment, resolved once at the pipeline boundary.
   *
   * Required, and required on purpose. Finalize is where `index.md` and `MOC.md` are
   * regenerated, and those renders are STORED IN A STACK: reading `process.env` there
   * wrote a per-request run's navigation into the ambient tenant's rows. An optional
   * field with (or without) a `process.env` default would re-create exactly that one
   * level down, so the flags object carries the value the caller resolved — and a
   * caller cannot compile without saying which Stack it compiles.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Refresh the embedding store after the durable state write. `false` skips it
   * entirely, including the pending-embeddings drain, for a caller that keeps
   * its own semantic index.
   *
   * Not a prompt modifier: it changes what runs AFTER pages are written, never
   * what any prompt asks for, so it must not enter the modifier digest or
   * invalidate a page that is byte-identical under it.
   */
  embeddings?: boolean;
  /**
   * Where link resolution reads page text from.
   *
   * Carried on the flags because finalize is three levels below the pipeline that
   * owns the database handle, and threading a second parameter through every level
   * for one optional seam would obscure the call sites more than this does.
   */
  resolverSource?: ResolverPageSource;
  /**
   * Where the post-compile embeddings refresh reads pages from.
   *
   * Paired with the write sink and the resolver on the same variable: an embeddings
   * pass that scanned an empty directory would compute no vectors and store none,
   * leaving semantic search silently empty while reporting success.
   */
  embeddingPageSource?: EmbeddingPageSource;
  /**
   * The run recompiled a SUBSET by design (`refresh --stale` supplies a
   * `changeFilter`), so it must not record the prompt-modifier selection as
   * true of the whole project — see the flush below.
   */
  scoped?: boolean;
  /**
   * The run regenerates NAMED pages only (`compileRecompiling`), so the stages
   * that exist to change OTHER pages are skipped — see the call site below.
   */
  regenerateOnly?: boolean;
  /**
   * Where the embedding store lives, when the caller holds a database handle.
   *
   * Omitted keeps the on-disk store, which is what every existing caller wants.
   * Supplied makes the compile write vectors into the tables, matching where a
   * serving process reads them -- without it, a compile would keep filling a file
   * that no longer feeds retrieval.
   */
  embeddingStore?: EmbeddingStoreLocation;
  /**
   * The page seams resolution and repair read and write through.
   *
   * Carried here rather than as three parameters on {@link finalizeWiki} because
   * they always travel together: a run that resolves against rows must write the
   * rewrites back to rows, and a repair pass that read rows must not write files.
   */
  seams?: PageSeams;
  /**
   * Where the compile state is persisted, when it is a row.
   *
   * Carried beside {@link seams} rather than inside it because it is not a PAGE
   * seam: it stores the compile's bookkeeping, not pages. Kept in the same flags
   * object so a caller cannot thread one and forget the other.
   */
  stateRows?: WikiStateRowsBackend;
  /**
   * Collector for what the post-generation stages decided across this run.
   *
   * Mutable and filled in place by the resolution seam and the reference review,
   * because the run totals are only known once every page has been judged — which
   * happens below the level that builds the compile result. The pipeline hands the
   * same object to the result afterwards, so it reports what those stages actually
   * decided instead of what they were asked to do.
   */
  totals?: RunReportTotals;
  /**
   * Job observer for the stages finalize itself runs.
   *
   * Finalize is where the embeddings refresh happens, and that refresh is a
   * `timeStage` boundary the caller two levels up cannot see. Carrying the
   * observer on the same flags object is what lets the innermost stage report
   * without threading a sixth parameter through every level.
   */
  jobObserver?: IngestJobObserver;
}

/**
 * The final link gate's options for one run: what to judge against, and where the
 * counts go.
 *
 * DELEGATES, and does not build. `linkGateOptions` is the ONE construction of these
 * options, shared with the other writers of wiki bodies (`review approve`), so a
 * compile and an approval cannot judge the same link against different page sets.
 * The only thing added here is this run's aggregate collector: the page content seam
 * is the run's OWN seam, so the gate reads the same backend the pages were written to.
 *
 * @param seams - The run's page seams.
 * @param linkCounts - The run's mutable total, when the caller wants one.
 * @returns The gate options for the resolution seam.
 */
function linkGateFor(
  seams: PageSeams,
  linkCounts: ContextualLinkCounts | undefined,
): LinkGateOptions {
  return linkGateOptions(
    seams.content,
    linkCounts === undefined
      ? undefined
      : { record: (counts: ContextualLinkCounts) => addContextualLinkCounts(linkCounts, counts) },
  );
}

/**
 * Review the wiki's EARLIER pages for a reference to the articles this run wrote (S9).
 *
 * Runs in the link phase, after the gate and after `link-repair`, and it is the only
 * stage that edits a page this run did NOT generate. It is deliberately last: by now
 * every article of the run exists, so a page reviewed here links to a real target,
 * and every other link channel has already settled the mentions it owns, so this
 * stage only sees mentions nothing else claimed.
 *
 * IT IS WIRED, and that is the point of the call site below. For the whole of T4's
 * delivery this function had NO caller: the stage was developed, tested through its own
 * exported symbol, and never entered by a compile, so no ingest ever curated a link and
 * the compile-level test that watched for its report line was passing vacuously. An
 * unwired stage cannot be distinguished from a stage that finds nothing to do, which is
 * why the pipeline-level test asserts a link the stage ADDS rather than silence.
 *
 * A run with nothing to review stays a no-op: an empty article list returns before any
 * read, so a compile of unchanged sources performs no review, no write and no model
 * call.
 *
 * @param root - Project root the reads and writes are confined under.
 * @param pages - Pages this run wrote, i.e. the articles an earlier page could reference.
 * @param flags - The run's seams and its mutable totals.
 */
async function reviewEarlierPagesForRun(
  root: string,
  pages: readonly MergedConcept[],
  flags: FinalizeFlags,
): Promise<void> {
  if (pages.length === 0 || flags.totals === undefined) return;
  const counts = await reviewEarlierPages(root, reviewArticlesOf(pages), { seams: flags.seams });
  addLinkReviewCounts(flags.totals.linkReview, counts);
  // The review's DURABLE half -- records kept for the links it curated -- rides on the
  // run's curated-link totals, so the operator sees one line covering every restored,
  // stored and refused curated link of the run, whichever stage touched it.
  addCuratedLinkCounts(flags.totals.curatedLinks, counts.curated);
}

/**
 * Assign this run's articles to categories (S10), and fold the totals into the run.
 *
 * Runs in the link phase, after the reference review, and it is the LAST stage that
 * writes anything: a category is its own object type in `wiki/categories/`, so nothing
 * downstream reads it and nothing can discard it. The articles it sees are the ones the
 * run really wrote, each read back as the page the wiki now serves -- the criterion a
 * proposal states is checked against THAT text, not against the source excerpt the
 * model worked from, so membership is justified by what a reader can see.
 *
 * A run with nothing to write stays a no-op: an empty article list returns before any
 * read, so a compile of unchanged sources makes no assignment call and writes no file.
 *
 * @param root - Project root the reads and writes are confined under.
 * @param pages - Pages this run wrote, i.e. the articles that can be categorised.
 * @param flags - The run's seams and its mutable totals.
 */
async function assignCategoriesForRun(
  root: string,
  pages: readonly MergedConcept[],
  flags: FinalizeFlags,
): Promise<void> {
  if (pages.length === 0 || flags.totals === undefined) return;
  const articles = await categoryArticlesOf(root, pages, flags.seams?.content);
  // The compile holds the project lock for its whole pipeline, so the stage writes
  // through the reentrancy-safe executor instead of re-acquiring (see the category store).
  // The STORE comes from the same seam bundle that decided where this run's pages went:
  // a row-backed run records its taxonomy in `wiki.categories`, a file-backed one in
  // `wiki/categories/`, and neither can be wired to the other's backend by accident.
  const counts = await assignCategories(root, articles, {
    lockHeld: true,
    store: flags.seams?.categories,
  });
  addCategoryAssignmentCounts(flags.totals.categories, counts);
}

/**
 * This run's articles, each with the body the wiki now serves for it.
 *
 * The body is read back through the run's own page seam, so a row-backed compile checks
 * its criteria against the rows it just wrote rather than against a filesystem that
 * holds nothing. A page the run cannot read back is skipped instead of being categorised
 * on evidence nobody can inspect.
 *
 * @param root - Project root the reads are confined under.
 * @param pages - Pages this run wrote.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The articles the stage may categorise.
 */
async function categoryArticlesOf(
  root: string,
  pages: readonly MergedConcept[],
  source: PageContentSource | undefined,
): Promise<CategoryAssignmentArticle[]> {
  const articles: CategoryAssignmentArticle[] = [];
  for (const entry of pages) {
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, entry.slug, source, false);
    if (content === "") continue;
    articles.push({ slug: entry.slug, title: entry.concept.concept, body: parseFrontmatter(content).body });
  }
  return articles;
}

/** This run's articles, as the review stage names them. */
function reviewArticlesOf(pages: readonly MergedConcept[]): LinkReviewArticle[] {
  return pages.map((entry) => ({
    slug: entry.slug,
    title: entry.concept.concept,
    aliases: entry.aliases ?? [],
  }));
}

/**
 * Resolve interlinks, regenerate index/MOC, refresh embeddings
 * post-write. Seed-page slugs are folded into both the changed-slug
 * set (so embeddings refresh covers them) and the new-slug set (so
 * inbound-link resolution scans existing pages for mentions of seed
 * titles). Without that, schema-declared seed pages would land on
 * disk but stay unlinked and absent from the embedding store.
 *
 * This is also where the ONE final link gate runs, inside the resolution seam:
 * every page this run wrote is on disk by now, so a link into a page the same run
 * created resolves instead of being reported missing, and the links `resolveLinks`
 * adds are judged by the same table as the ones the model typed.
 */
async function finalizeWiki(
  root: string,
  draft: CompileStateDraft | null,
  pages: MergedConcept[],
  seedSlugs: string[] = [],
  flags: FinalizeFlags,
): Promise<void> {
  const {
    env, scoped = false, embeddings = true, embeddingStore, resolverSource,
    embeddingPageSource, seams = {}, stateRows, jobObserver, totals, regenerateOnly = false,
  } = flags;
  const conceptChangedSlugs = pages.map((entry) => entry.slug);
  const conceptNewSlugs = pages
    .filter((entry) => entry.concept.is_new)
    .map((entry) => entry.slug);
  const allChangedSlugs = [...conceptChangedSlugs, ...seedSlugs];
  const allNewSlugs = [...conceptNewSlugs, ...seedSlugs];

  if (allChangedSlugs.length > 0) {
    output.status("🔗", output.info("Resolving interlinks..."));
    // Compute + apply the resolution rewrites as ONE journalled batch. compile
    // holds the project lock for its whole pipeline → the lock-free seam.
    await resolveAndApplyLinks(
      root, env, allChangedSlugs, allNewSlugs, resolverSource, seams.sink, seams.remover,
      seams.transaction, linkGateFor(seams, totals?.linkCounts), seams.curatedLinks,
    );
    // Resolution adds links for titles it recognises; repair fixes links the
    // model already wrote against a page whose slug is longer than the name it
    // used. Ordered after resolution so a link resolution has just created is
    // already valid and never looks repairable.
    await repairAndApplyLinks(
      root, env, seams.content, seams.scan, seams.sink, seams.remover, seams.transaction);
    // The reference review runs LAST, and the position is the contract rather than a
    // convenience. Three properties depend on it:
    //   1. It needs every article of the run to exist, so a page it edits links to a
    //      real target and the gate inside it can validate that target.
    //   2. It needs the gate to have run, so the link it adds is judged by the same
    //      rules and per-page budget as every other link in this wiki.
    //   3. It needs `link-repair` to have run, so a mention an abbreviation repair has
    //      already canonicalised is a `[[link]]` by now and the stage's mention scan
    //      skips it -- which is what stops the resolver and this stage from creating
    //      the same link twice. Running it before the resolver would also expose the
    //      edits to a body rewrite the resolver builds from its own earlier read.
    // The reference review and category assignment are SKIPPED by a scoped regeneration
    // (`compileRecompiling`), and that is the promise of the lever rather than an
    // optimisation: both stages exist to change pages the run did NOT name — the review
    // adds references to earlier pages and the taxonomy records memberships — so running
    // them here would rewrite the wiki around the one page the operator asked for.
    if (!regenerateOnly) {
      await reviewEarlierPagesForRun(root, pages, flags);
      // Categories come LAST because they are a different object type: a category file is
      // read by nothing in this pipeline, so no later stage can discard the membership it
      // records, and every page it describes is final by now. Guarded like the review: a
      // run with no article makes no assignment call and writes no category file.
      await assignCategoriesForRun(root, pages, flags);
    }
  }

  // SINGLE durable state write of the whole compile: the buffered draft is
  // flushed ONLY here, after resolution has committed. A crash before this
  // re-runs the whole compile from the prior on-disk state (no half-marked
  // sources). The no-source-changes early-return path passes a null draft —
  // it has no state mutations, so there is nothing to flush.
  //
  // The modifier digest is recorded HERE rather than at load, so a compile that
  // crashes mid-run leaves the previous digest on disk and the re-run still sees
  // the difference. Recording it up front would mark the run as done under the
  // new modifiers before any page was written under them.
  //
  // A SCOPED run (`refresh --stale`, which supplies a changeFilter) recompiles a
  // subset by design, so it must not record the selection as true of the whole
  // project: the sources it filtered out still carry the previous wording, and
  // advancing the digest would retire the only signal that says so. Leaving the
  // old digest costs the pages it did refresh a second regeneration on the next
  // full compile, which is the safe direction to be wrong in.
  if (draft) {
    if (!scoped) draft.setPromptModifiers(promptModifiersDigest());
    await draft.flush(root, stateRows);
  }

  await regenerateIndices(root, env);
  if (embeddings) {
    await timeStage("compile.embeddings", () => safelyUpdateEmbeddings(
      root, allChangedSlugs, embeddingStore, embeddingPageSource, jobObserver?.compile,
    ), () => reportCompileStage(jobObserver?.compile, "compile.embeddings"));
  }
}

/**
 * Refresh the embeddings store without failing compilation.
 * Semantic search is a non-critical enhancement — missing API keys or
 * transient provider errors should produce a warning, not a broken build.
 *
 * DURABLE source↔embeddings consistency with a PER-ID lifecycle: because
 * source-state is already flushed (sources marked current) by the time this runs
 * and failures are SWALLOWED, a skipped/crashed refresh would otherwise leave stale
 * embeddings that the next compile never revisits (no source change → no refresh).
 * To close that, the changed page-ids are UNIONED (preserving existing attempt
 * counts) with any prior-pending entries and recorded to a durable, root-confined
 * write-ahead marker BEFORE the attempt. AFTER the attempt the marker is reconciled
 * per-id rather than all-or-nothing:
 *  - SUCCESS → {@link settleAfterSuccess} clears only the ids the core actually
 *    embedded; an id it SKIPPED (transiently ineligible) is retained with an
 *    incremented attempt count, never cleared un-embedded.
 *  - FAILURE → {@link settleAfterFailure} increments attempts for the whole batch.
 * Either way, an id that fails {@link MAX_PENDING_EMBEDDING_ATTEMPTS} times is
 * QUARANTINED (dropped + a visible warning), so a poison id can neither loop forever
 * (re-billing the provider) nor wedge the all-or-nothing batch it shares.
 *
 * `finalizeWiki` calls this on EVERY non-review compile (including the
 * no-source-changes early branch), so prior-pending ids are drained — retried —
 * even on an otherwise no-op compile.
 *
 * Compile only ever writes concept-namespace pages, so changed slugs are
 * qualified under `concepts/`. The full per-id drain lifecycle lives in the
 * SHARED {@link refreshEmbeddingsDrainingPending} (also used by `review approve`);
 * this wrapper only maps slugs → qualified page-ids. Compile already holds the
 * project lock → the shared drain calls the reentrancy-safe Core (the
 * self-locking wrapper would deadlock here).
 */
/**
 * Where this compile should persist embedding vectors.
 *
 * Returns `undefined` when no Stack is configured, which keeps the on-disk store:
 * a project that never opted into the knowledge backend must not start requiring a
 * database to compile. When a Stack IS configured, both halves of the
 * read-modify-write point at the same place, so the compile cannot read one store
 * and write another.
 *
 * @param db - The run's database handle.
 * @returns The location, or undefined to keep using the file.
 */
/**
 * Hash a document's current text, reading it by identity when rows are the corpus.
 *
 * Extracted so the pending-candidate check never builds a path out of a key that may
 * be a URL. A missing document yields an empty hash, which never equals a recorded
 * one and so leaves the change marked as real work.
 *
 * @param contentSource - Row reader.
 * @param sourceIdentity - Identity of the document to hash.
 * @returns Its current content hash.
 */
async function currentContentHash(
  contentSource: SourceContentSource,
  sourceIdentity: string,
): Promise<string> {
  const document = await contentSource.read(sourceIdentity);
  return document === undefined
    ? ""
    : createHash("sha256").update(document.content, "utf-8").digest("hex");
}

/**
 * Where this compile should WRITE the pages it generates.
 *
 * Returns `undefined` when no Stack is configured, which keeps the on-disk write.
 * Paired with {@link sourceChangeDetection} on the same variable because a run that
 * read rows and wrote files would be reading one corpus and publishing another.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The row sink, or undefined to keep writing `wiki/concepts/*.md`.
 */
function sourcePageSink(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): PageSink | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return createPageWriteSink(db, stackId);
}

/**
 * Where this compile should read the page index shown to the extraction prompt.
 *
 * `index.md` was a projection of the pages; deriving it from the same rows the
 * compile already reads keeps the prompt identical while removing the file as a
 * requirement.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The scan source, or undefined to read `wiki/index.md`.
 */
function scanSourceReading(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): PageScanSource | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return createPageScanSource(db, stackId);
}

/**
 * Where this compile should read page text for LINK RESOLUTION.
 *
 * Resolution is read-modify-write over the pages themselves, so it has to agree with
 * what compile just wrote. Paired with the write sink on the same variable: reading
 * rows while writing files (or the reverse) would rewrite pages against a body that
 * does not match the one being published.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The resolver source, or undefined to read `wiki/concepts` from disk.
 */
function embeddingPageReading(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingPageSource | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return createEmbeddingPageSource(db, stackId);
}

function resolverSourceReading(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): ResolverPageSource | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return createResolverPageSource(db, stackId);
}

/**
 * Where this compile should read document text from.
 *
 * Paired with {@link sourceChangeDetection} and gated on the same variable, because
 * the two must agree: reading rows that were discovered in a directory -- or the
 * reverse -- would leave every document unreadable.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The content source, or undefined to keep reading `sources/`.
 */
function sourceContentReading(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): SourceContentSource | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return sourceDocumentsContentSource(db, stackId);
}

/**
 * Where this compile should read its source corpus from.
 *
 * Returns `undefined` when no Stack is configured, which keeps the on-disk scan:
 * a project that never opted into the knowledge backend must not start requiring a
 * database to compile. When a Stack IS configured, change detection reads rows, so
 * an ingest that wrote a row is visible to the compiler.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The detection source, or undefined to keep scanning `sources/`.
 */
function sourceChangeDetection(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): ChangeDetectionSource | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return sourceDocumentsChangeSource(db, stackId);
}

/**
 * Where this compile should read and write its incremental state.
 *
 * Returns `undefined` when no Stack is configured, which keeps `state.json`. Gated
 * on the same variable as every other seam because the state a run reads must be the
 * state it writes: an ingest and a compile that disagreed about the backend would
 * each see the other's work as missing.
 *
 * @param db - The run's database handle.
 * @param env - Environment to read the Stack from; defaults to `process.env`.
 * @returns The rows backend, or undefined to keep `.llmwiki/state.json`.
 */
function wikiStateRowsBackend(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): WikiStateRowsBackend | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return createWikiStateRowsBackend(db, stackId);
}

function embeddingStoreLocation(
  db: DimensionsDatabaseHandle,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingStoreLocation | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  if (stackId === "") return undefined;
  return databaseEmbeddingLocation(db, stackId);
}

async function safelyUpdateEmbeddings(
  root: string,
  changedSlugs: string[],
  embeddingStore?: EmbeddingStoreLocation,
  pageSource?: EmbeddingPageSource,
  progressReporter?: CompileProgressReporter,
): Promise<void> {
  const conceptsNamespace = path.basename(CONCEPTS_DIR);
  const changedPageIds = changedSlugs.map((slug) => qualifiedPageId(conceptsNamespace, slug));
  const onProgress = progressCallbackFor(progressReporter);
  await refreshEmbeddingsDrainingPending(
    root, changedPageIds, embeddingStore, pageSource, onProgress, detailCallbackFor(progressReporter),
  );
}

/**
 * Build the sink that publishes chunk/request cardinalities, or `undefined` with
 * no job tracked.
 *
 * Kept apart from {@link progressCallbackFor} rather than folded into one sink:
 * these numbers are totals for the finished stage, not a position inside it, and
 * a consumer must be able to render the cardinality without implying the bar is
 * about chunks. Omits a count that is zero instead of sending `0`, because
 * "absent" and "zero chunks embedded" are different facts and only one of them
 * is worth telling an operator.
 *
 * @param reporter - The compile half of the job observer, when a job is tracked.
 * @returns A detail sink, or `undefined` when there is nothing to report to.
 */
function detailCallbackFor(
  reporter: CompileProgressReporter | undefined,
): ((detail: { chunks: number; requests: number }) => void) | undefined {
  if (reporter === undefined) return undefined;
  return ({ chunks, requests }) => {
    try {
      reporter.detail({ ...(chunks > 0 ? { chunks } : {}), ...(requests > 0 ? { requests } : {}) });
    } catch {
      // Telemetry is not a compile input; a throwing consumer must not fail the run.
    }
  };
}

/**
 * Build the embeddings-stage progress sink, or `undefined` when no job is tracked.
 *
 * WHY an undefined sink rather than a no-op: reporting nothing and reporting into a
 * throwaway object are different claims, and the refresh layer must be able to tell
 * "no observer" from "observer that discards" when it decides to skip the work the
 * callback implies. Delegating to {@link reportCompileProgress} keeps the `total <= 0`
 * and clamping rules in the one place that already owns them.
 *
 * The sink swallows a reporter failure on purpose: telemetry is not a compile input,
 * and a throwing progress consumer must not abort an embedding pass whose vectors
 * were already paid for.
 *
 * @param reporter - The compile half of the job observer, when a job is tracked.
 * @returns A page-record progress sink, or `undefined` when there is nothing to report to.
 */
function progressCallbackFor(
  reporter: CompileProgressReporter | undefined,
): ((completed: number, total: number) => void) | undefined {
  if (reporter === undefined) return undefined;
  return (completed, total) => {
    try {
      reportCompileProgress(reporter, completed, total);
    } catch {
      // A progress sink failing says nothing about the embeddings themselves.
    }
  };
}
