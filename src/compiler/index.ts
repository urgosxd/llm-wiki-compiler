/**
 * Compilation orchestrator for the llmwiki knowledge compiler.
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
import { markOrphaned, orphanUnownedFrozenPages } from "./orphan.js";
import { resolveAndApplyLinks } from "./resolver.js";
import { repairAndApplyLinks } from "./link-repair.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { listCandidates } from "./candidates.js";
import {
  applyCompilePageWritesLocked,
} from "./compile-write.js";
import * as output from "../utils/output.js";
import { verbose } from "../utils/output.js";
import { loadReviewPolicy } from "../review/config.js";
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
import { runExtractionPhases } from "./extraction-phase.js";
import { reusableSourceFiles, withExtractionSnapshot } from "./extraction-snapshot.js";
import { generateMergedPage } from "./review-pipeline.js";
import { generateSeedPages } from "./seed-pages.js";
import {
  logCompile,
  printChangesSummary,
  reportFrozenSlugs,
  reportSchemaStatus,
  summarizeCompile,
} from "./compile-report.js";
import type {
  ChangeBuckets,
  MergedConcept,
  MergedPageOutcome,
  PageGenerationResult,
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

import { createDimensionsDatabase, resolveDimensions, AKS_STACK_ID_ENV_VAR } from "../dimensions/index.js";
import type { EmbeddingStoreLocation } from "../utils/embeddings.js";
import { databaseEmbeddingLocation } from "../utils/embeddings-database.js";
import {
  sourceDocumentsChangeSource,
  sourceDocumentsContentSource,
} from "../dimensions/wiki/source-documents-store.js";
import type { ChangeDetectionSource, SourceContentSource } from "./hasher.js";
import { pageStoreOptions, type PageRemover, type PageSink } from "../trust/page-apply.js";
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
import type { IngestJobObserver } from "../services/ingest/jobs/types.js";
import { regenerateIndices, resolvePageSeams, type PageSeams } from "../dimensions/wiki/page-source-seam.js";
import { createWikiStateRowsBackend } from "../dimensions/wiki/wiki-state-source.js";
import type { WikiStateRowsBackend } from "./compile-state-draft.js";

/** Empty CompileResult used when no pipeline work runs (e.g. lock contention). */
function emptyCompileResult(): CompileResult {
  return { compiled: 0, skipped: 0, deleted: 0, concepts: [], pages: [], errors: [] };
}

/**
 * Run the full compilation pipeline with lock protection.
 * Acquires .llmwiki/lock, detects changes, compiles new/changed sources,
 * marks orphaned pages, resolves interlinks, and rebuilds the index.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides (e.g. --review mode).
 */
export async function compile(root: string, options: CompileOptions = {}): Promise<void> {
  await compileAndReport(root, options);
}

/**
 * Run the full compilation pipeline and return a structured result.
 * Same behaviour as compile() but exposes counts, slugs, and errors so
 * non-CLI consumers (the MCP server, programmatic callers) can report
 * meaningful data without scraping terminal output.
 * @param root - Project root directory.
 * @param options - Optional pipeline overrides (e.g. --review mode).
 * @returns Structured result describing what was compiled.
 */
export async function compileAndReport(
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  output.header("llmwiki compile");

  // One handle for the whole run, closed in the `finally` below. Pages are rows
  // in Postgres now, so the pipeline needs a connection; building it here rather
  // than inside the pipeline keeps its lifetime bounded to this call. Constructing
  // it does not connect, so a compile of a project with no dimension work never
  // opens a socket.
  const dimensionsDb = createDimensionsDatabase();

  const locked = await acquireMutationLock(root, "ordinary");
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
    await releaseLock(root);
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

/** Phase 2: generate pages for merged concepts in parallel, capturing errors. */
async function generatePagesPhase(
  root: string,
  extractions: ExtractionResult[],
  frozenSlugs: Set<string>,
  reconciliationSlugs: ReadonlySet<string>,
  schema: SchemaConfig,
  options: CompileOptions,
  policy: ReviewPolicy,
  concurrency: number,
  pageSink: PageSink | undefined,
  pageRemover: PageRemover | undefined,
): Promise<PageGenerationResult> {
  const merged = mergeExtractions(extractions, frozenSlugs, reconciliationSlugs);
  // Build the per-source state snapshot once so each candidate can carry the
  // exact data needed to mark its sources compiled on approval.
  const shouldBuildSourceStates = options.review || !isPolicyOff(policy);
  const sourceStates = shouldBuildSourceStates
    ? await buildExtractionSourceStates(root, extractions)
    : {};
  const limit = pLimit(concurrency);
  // Collect per-outcome errors and candidate info into the ordered outcomes array
  // AFTER Promise.all, then derive candidates/review by iterating outcomes in source order.
  // This ensures stable, source-order ordering regardless of parallel completion timing.
  const outcomes = await Promise.all(
    merged.map((entry) => limit(async () => {
      const result = await generateMergedPage(root, entry, schema, options, sourceStates, policy);
      return { entry, result };
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
  const { writtenPages, batchErrors } = await commitLivePageWrites(
    root, outcomes, pageSink, pageRemover);
  errors.push(...batchErrors);
  return { pages, writtenPages, errors, candidates, review, seedSlugs: [] };
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
 * @param root - Project root the writes are confined under.
 * @param outcomes - Source-ordered generation outcomes.
 * @returns The committed entries plus any floor-skip errors.
 */
async function commitLivePageWrites(
  root: string,
  outcomes: GeneratedOutcome[],
  pageSink: PageSink | undefined,
  pageRemover: PageRemover | undefined,
): Promise<{ writtenPages: MergedConcept[]; batchErrors: string[] }> {
  const live = outcomes.filter((o) => o.result.liveWrite);
  const { skipped } = await applyCompilePageWritesLocked(
    root,
    live.map((o) => o.result.liveWrite!),
    pageStoreOptions(pageSink, pageRemover),
  );
  const skippedKeys = new Set(skipped.map((s) => `${s.item.namespace}/${s.item.slug}`));
  const writtenPages = live
    .filter((o) => !skippedKeys.has(`${o.result.liveWrite!.namespace}/${o.result.liveWrite!.slug}`))
    .map((o) => o.entry);
  const batchErrors = skipped.map(
    (s) => `Page "${s.item.slug}" skipped — ${s.reason}`,
  );
  return { writtenPages, batchErrors };
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
 * Generate seed pages unless `skipSeedPages` is set or we are in review mode.
 * Centralises both guard conditions so each call site in the pipeline is a
 * single unconditional statement instead of an inline if-block.
 */
async function maybeSeedPages(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
  options: CompileOptions,
  seams: PageSeams,
): Promise<void> {
  if (!options.review && !options.skipSeedPages) {
    await generateSeedPages(root, schema, generation, seams.content, seams.sink, seams.remover);
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
): Promise<void> {
  await maybeSeedPages(root, schema, generation, options, seams);
  await finalizeWiki(root, draft, generation.writtenPages, generation.seedSlugs, {
    scoped: options.changeFilter !== undefined,
    embeddings: options.embeddings !== false,
    embeddingStore,
    resolverSource,
    embeddingPageSource,
    seams,
    stateRows,
    jobObserver: options.jobObserver,
  });
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
  if (options.review) {
    return { ...emptyCompileResult(), skipped: input.unchangedCount };
  }
  const hasOwnerlessFrozen = await reconcileOwnerlessFrozen(
    root, draft, reconciliationSlugs, seams,
  );
  const emptyGeneration: PageGenerationResult = {
    pages: [], writtenPages: [], errors: [], candidates: [],
    review: { held: [], forced: [] }, seedSlugs: [],
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
  ));
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
  const schema = await loadSchema(root);
  const reviewPolicy = await loadReviewPolicy(root);
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
  const compileReporter = options.jobObserver?.compile;
  const detected = await timeStage("compile.detect-changes", () =>
    detectChanges(root, state, sourceChangeDetection(db, env)),
    () => reportCompileStage(compileReporter, "compile.detect-changes"));
  const changes = promoteForPromptModifiers(
    applyChangeFilter(detected, options.changeFilter),
    state,
  );
  await markUnchangedPendingSources(root, changes, sourceContentReading(db, env));
  const reusableSources = reusableSourceFiles(state, changes, detected, Boolean(options.review));
  augmentWithAffectedSources(changes, findAffectedSources(state, changes, detected));
  const reconciliationSlugs = findReconciliationSlugs(state, changes);

  const buckets = bucketChanges(changes);
  // Resolve every page seam ONCE, from one variable: a run that stores rows while
  // repairing files -- or reads rows while writing `wiki/` -- would split the
  // corpus in half and is the defect this migration kept re-introducing.
  const seams = resolvePageSeams(db, env);
  if (buckets.toCompile.length === 0 && buckets.deleted.length === 0) {
    return await finalizeNothingToCompile({
      root, options, db, env, schema, draft, seams, stateRows,
      reconciliationSlugs, unchangedCount: buckets.unchanged.length,
    });
  }

  printChangesSummary(changes);
  // In review mode the pipeline contract is "write candidates instead of
  // mutating wiki/". Deletion bookkeeping (orphan marking + frozen-slug
  // persistence) writes directly into wiki/ and updates state.json, so we
  // defer it to the next non-review compile pass. Source-state persistence
  // for compiled sources is also review-deferred — those entries land at
  // approve time so unapproved candidates remain re-detectable on subsequent
  // compiles.
  const forgetErrors: string[] = [];
  if (!options.review) {
    await markDeletedAsOrphaned(root, buckets.deleted, draft, seams);
    // Graph retirement follows the same review rule: a held-back run must not
    // retire documents the wiki has not stopped serving yet.
    forgetErrors.push(...(await forgetDeletedSources(root, buckets.deleted, state, db)));
  }

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
  ), () => reportCompileStage(compileReporter, "compile.extraction"));
  if (!options.review) {
    freezeFailedExtractions(draft, extractions, frozenSlugs);
    reportFrozenSlugs(frozenSlugs);
  }

  // Snapshot pages on disk before generation so the journal can tell which
  // produced pages are new (created) versus overwritten (updated).
  const existingIds = await listExistingPageIds(root);
  // The ONLY stage with a real denominator the pipeline computes before the work:
  // one merged concept becomes one generated page, so the count of concepts IS the
  // total. Reported on entry and again on exit, never interpolated in between --
  // generation runs under p-limit, so a half-finished count would be a guess.
  reportCompileProgress(compileReporter, 0, extractions.length);
  const generation = await timeStage("compile.page-generation", () => generatePagesPhase(
    root,
    extractions,
    frozenSlugs,
    reconciliationSlugs,
    schema,
    options,
    reviewPolicy,
    concurrency,
    seams.sink,
    seams.remover,
  ), () => reportCompileProgress(compileReporter, 0, extractions.length));
  reportCompileProgress(
    compileReporter,
    generation.writtenPages.length,
    Math.max(extractions.length, generation.writtenPages.length),
  );

  if (!options.review) {
    const written = new Set(generation.writtenPages.map((entry) => entry.slug));
    const retained = new Set(
      [...reconciliationSlugs, ...frozenSlugs].filter((slug) => !written.has(slug)),
    );
    await persistExtractionStates(draft, extractions, generation.writtenPages, retained);
    const orphanCandidates = new Set([...reconciliationSlugs, ...frozenSlugs]);
    if (orphanCandidates.size > 0) {
      await orphanUnownedFrozenPages(
        root, draft, orphanCandidates, seams.content, seams.sink, seams.remover);
    }
    persistFrozenSlugs(draft, frozenSlugs, extractions, {
      pending: reconciliationSlugs,
      replaced: written,
    });
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
    ), () => reportCompileStage(compileReporter, "compile.finalize"));
    await logCompile(root, buckets, generation, existingIds);
  }
  verbose(`compile finished in ${Date.now() - startMs} ms`);
  return summarizeCompile(buckets, generation, extractions, options, forgetErrors);
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
 * The candidate's OWN digest is the comparison, not the project's. Review mode
 * never flushes state, so a project whose only compiles were `--review` has no
 * recorded digest at all — and comparing against that absent value would make
 * clearing a modifier look like no change, because "none selected" is exactly
 * what an absent digest means.
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
    await markOrphaned(root, del.file, draft, seams.content, seams.sink, seams.remover);
  }
}

/**
 * Retire deleted sources from every registered dimension that is not the wiki.
 *
 * WHY THIS EXISTS. `compile` already marks a deleted source's pages orphaned, but
 * until the port gained `forget` nothing told the GRAPH. A removed source left its
 * document, chunks, entities, and contributions in Postgres forever, so the graph
 * kept answering with text the project no longer had.
 *
 * ONLY SOURCES WITH A RECORDED IDENTITY ARE RETIRED. `SourceState.source` is absent
 * for state written before v2 and for files whose frontmatter carried none.
 * Guessing an identity from the filename would be worse than doing nothing: the
 * filename is a title slug, never the identity the graph was written under, so a
 * guess would delete either nothing or the wrong document.
 *
 * The wiki is skipped because it owns its own removal story (`markDeletedAsOrphaned`
 * preserves pages other sources still support); retiring here too would duplicate
 * that decision in a second place.
 *
 * @param root - Project root, for dimension resolution.
 * @param deleted - Source changes already classified as deletions.
 * @param state - State BEFORE this run, which still holds the missing sources.
 * @param db - Database handle every dimension is backed by.
 * @returns One message per source that could not be retired.
 */
async function forgetDeletedSources(
  root: string,
  deleted: readonly SourceChange[],
  state: WikiState,
  db: DimensionsDatabaseHandle,
): Promise<string[]> {
  const failures: string[] = [];
  // Graph retirement is the ONLY concern here, so ask for the graph dimension
  // alone (`only`) instead of building every enabled dimension and filtering the
  // wiki out. Building and discarding was harmless while the wiki was
  // file-backed; it is Postgres-backed now, so resolving it demands a Stack id
  // this path never needed. `only` also respects the switch: a project that never
  // enabled `kg` retires nothing here, exactly as before.
  const dimensions = resolveDimensions({ root, db, only: ["kg"] });
  if (dimensions.length === 0) return failures;
  for (const change of deleted) {
    const source = state.sources[change.file]?.source;
    if (source === undefined) continue;
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
 * Resolve interlinks, regenerate index/MOC, refresh embeddings
 * post-write. Seed-page slugs are folded into both the changed-slug
 * set (so embeddings refresh covers them) and the new-slug set (so
 * inbound-link resolution scans existing pages for mentions of seed
 * titles). Without that, schema-declared seed pages would land on
 * disk but stay unlinked and absent from the embedding store.
 */
async function finalizeWiki(
  root: string,
  draft: CompileStateDraft | null,
  pages: MergedConcept[],
  seedSlugs: string[] = [],
  flags: FinalizeFlags = {},
): Promise<void> {
  const {
    scoped = false, embeddings = true, embeddingStore, resolverSource,
    embeddingPageSource, seams = {}, stateRows, jobObserver,
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
      root, allChangedSlugs, allNewSlugs, resolverSource, seams.sink, seams.remover,
    );
    // Resolution adds links for titles it recognises; repair fixes links the
    // model already wrote against a page whose slug is longer than the name it
    // used. Ordered after resolution so a link resolution has just created is
    // already valid and never looks repairable.
    await repairAndApplyLinks(root, seams.content, seams.scan, seams.sink, seams.remover);
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

  await regenerateIndices(root, process.env);
  if (embeddings) {
    await timeStage("compile.embeddings", () => safelyUpdateEmbeddings(
      root, allChangedSlugs, embeddingStore, embeddingPageSource,
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
): Promise<void> {
  const conceptsNamespace = path.basename(CONCEPTS_DIR);
  const changedPageIds = changedSlugs.map((slug) => qualifiedPageId(conceptsNamespace, slug));
  await refreshEmbeddingsDrainingPending(root, changedPageIds, embeddingStore, pageSource);
}
