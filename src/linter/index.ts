/**
 * Wiki linter orchestrator.
 *
 * Imports all lint rules, runs them concurrently, and aggregates
 * results into a summary with error/warning/info counts.
 * This is the main entry point for programmatic lint access.
 */

import type { LintResult, LintRule, LintSummary, SchemaAwareLintRule } from "./types.js";
import {
  checkBrokenWikilinks,
  checkOrphanedPages,
  checkMissingSummaries,
  checkDuplicateConcepts,
  checkEmptyPages,
  checkBrokenCitations,
  checkMalformedClaimCitations,
  checkLowConfidencePages,
  checkContradictedPages,
  checkInferredWithoutCitations,
  checkSchemaCrossLinks,
  checkStalePages,
} from "./rules.js";
import { checkJournalHealth } from "./journal-rule.js";
import { checkPendingEmbeddings } from "./pending-embeddings-rule.js";
import { loadSchema } from "../schema/index.js";
import { buildProjectFreshnessSnapshot } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { loadProfile } from "../profile/load.js";
import {
  groupByDeclaredTier, tieredReport, type LintTierV1, type TieredLintReportV1, type TieredResultGroupV1,
} from "./tiers.js";
import { collectProfileLintFindings, collectProfileLintInput } from "../profile/lint.js";
import { collectAllPages, type PageScope } from "./rules-shared.js";
import { corpusFromRawPages, withLintCorpus, type LintCorpus } from "./corpus.js";
import { withRawPageSource, withSourceDocuments } from "../dimensions/wiki/page-source-seam.js";

/** Rule-only lint checks that don't depend on the schema layer. */
/**
 * Every rule with the KIND of claim it makes (section §4.6 tiering).
 *
 * The tier sits beside the function rather than in a lookup keyed by rule id,
 * because rule ids are computed in places (`profile/${kind}`) and a table keyed
 * by them could never be proven complete. Ordering is load-bearing: `lint`
 * flattens these in registry order and suites pin that output byte-for-byte.
 */
const RULES_WITHOUT_SCHEMA: ReadonlyArray<{ rule: LintRule; tier: LintTierV1 }> = [
  { rule: checkBrokenWikilinks, tier: "deterministic" },
  { rule: checkOrphanedPages, tier: "deterministic" },
  { rule: checkMissingSummaries, tier: "deterministic" },
  { rule: checkDuplicateConcepts, tier: "deterministic" },
  { rule: checkEmptyPages, tier: "deterministic" },
  { rule: checkBrokenCitations, tier: "deterministic" },
  { rule: checkMalformedClaimCitations, tier: "deterministic" },
  // A model's assessment of a page, not a fact about it.
  { rule: checkLowConfidencePages, tier: "provider-judgement" },
  { rule: checkContradictedPages, tier: "provider-judgement" },
  { rule: checkInferredWithoutCitations, tier: "provider-judgement" },
  { rule: checkJournalHealth, tier: "deterministic" },
  // Embeddings not yet computed: a derived view is behind, nothing is wrong.
  { rule: checkPendingEmbeddings, tier: "derived-view" },
];

/** Lint rules that need the resolved schema to know per-kind expectations. */
const RULES_WITH_SCHEMA: ReadonlyArray<{ rule: SchemaAwareLintRule; tier: LintTierV1 }> = [
  { rule: checkSchemaCrossLinks, tier: "deterministic" },
];

type FreshnessLintRule = (root: string, snapshot: FreshnessSnapshot) => Promise<LintResult[]>;
const RULES_WITH_FRESHNESS: ReadonlyArray<{ rule: FreshnessLintRule; tier: LintTierV1 }> = [
  // A page whose sources moved on: regenerating fixes it.
  { rule: checkStalePages, tier: "derived-view" },
];

/**
 * Count occurrences of a specific severity level in the results.
 */
function countBySeverity(
  results: LintResult[],
  severity: LintResult["severity"],
): number {
  return results.filter((r) => r.severity === severity).length;
}

/** Build a summary from a flat result list, computing the severity counts. */
function summarize(results: LintResult[]): LintSummary {
  return {
    errors: countBySeverity(results, "error"),
    warnings: countBySeverity(results, "warning"),
    info: countBySeverity(results, "info"),
    results,
  };
}

/**
 * Append profile-aware entity findings when the project runs a NON-default
 * profile. A default/built-in profile (`loadedFrom === null`) returns the
 * default results UNCHANGED, so the default lint output stays byte-identical.
 */
async function profileGroups(root: string, defaultResults: readonly LintResult[]): Promise<TieredResultGroupV1[]> {
  const { profile, loadedFrom } = await loadProfile(root);
  if (loadedFrom === null) return [];
  // One entity collection feeds every profile check, including the declared
  // numeric confidence judgement, so a tiered view never walks entities twice.
  const collected = await collectProfileLintFindings(await collectProfileLintInput(root, profile));
  // Only an overlapping default confidence finding wins; unrelated duplicates survive.
  const defaultConfidenceFiles = new Set(
    defaultResults.filter((r) => r.rule === "low-confidence").map((r) => r.file),
  );
  const results = collected.results.filter((r) => r.rule !== "low-confidence" || !defaultConfidenceFiles.has(r.file));
  // Profile rule ids are declared beside their emitters; grouping preserves the
  // emission order and refuses any id nobody declared.
  return groupByDeclaredTier(results, collected.ruleTiers);
}

/**
 * Run every registered rule once, keeping each rule's results paired with the
 * tier its registry entry declared.
 *
 * ORDER IS THE CONTRACT. `lint` flattens these groups in exactly the order the
 * registries and the profile appendix produce them, which is the order the
 * frozen parity suites pin — so this must never sort or regroup.
 */
/**
 * Index a Stack's documents by the filename a page cites.
 *
 * A page cites the source FILENAME (`^[abc123.md]`), while a document row is keyed
 * by its source IDENTITY (a capability URL). `filename` is the column that joins
 * them, and it is what lands in `sources/` on the file-backed path — so a citation
 * resolves to the same document on both backends.
 *
 * @param documents - The Stack's documents.
 * @returns Filename → document text, for the documents that carry text.
 */
function sourceTextByFilename(
  documents: ReadonlyArray<{ filename?: string; content?: string }>,
): Map<string, string> {
  const byFilename = new Map<string, string>();
  for (const document of documents) {
    if (document.filename === undefined || document.content === undefined) continue;
    byFilename.set(document.filename, document.content);
  }
  return byFilename;
}

/**
 * Resolve the pages this run may inspect, from whichever corpus the project has.
 *
 * On a Stack the pages are rows; `collectAllPages` would walk an empty `wiki/`
 * and every page-scoped rule would report nothing — a clean verdict for a corpus
 * nobody read. The corpus is put in scope by {@link collectTieredGroups}, so the
 * rules keep their signatures and still see the right pages.
 *
 * @param root - Project root, used only by the on-disk fallback.
 * @param scope - Which pages this run claims.
 * @returns The corpus, ready for {@link withLintCorpus}.
 */
async function resolveLintCorpus(
  root: string,
  scope: PageScope,
  env: NodeJS.ProcessEnv,
): Promise<LintCorpus> {
  return await withRawPageSource(root, env, async (source) => {
    if (source === undefined) {
      // File-backed: no corpus override for sources either, so the citation rules
      // keep reading `sources/` exactly as they always have.
      return { pages: (await collectAllPages(root, scope)).map((page) => ({ ...page })) };
    }
    // A Stack's citation targets are its `source_documents` rows. Without this the
    // citation rules join every cited filename against `sources/`, where a Stack
    // has nothing, and report EVERY citation as broken.
    const sources = await withSourceDocuments(env, async (listing) => {
      if (listing === undefined) return undefined;
      return sourceTextByFilename(await listing.list());
    });
    return corpusFromRawPages(await source.collect(), scope, sources);
  });
}

async function collectTieredGroups(
  root: string,
  scope: PageScope = "generic",
  env: NodeJS.ProcessEnv = process.env,
): Promise<TieredResultGroupV1[]> {
  const corpus = await resolveLintCorpus(root, scope, env);
  return await withLintCorpus(corpus, () => collectGroupsInScope(root, scope));
}

/** The rule fan-out itself, run with a corpus already in scope. */
async function collectGroupsInScope(root: string, scope: PageScope): Promise<TieredResultGroupV1[]> {
  const schema = await loadSchema(root);
  // Resolves the corpus itself: on a Stack the documents are rows, and every source
  // identity is a capability URL that no `sources/` file can match. Omitting that
  // classified every owned page `orphaned` here while `status` reported them fine --
  // the same corpus, two answers. See `buildProjectFreshnessSnapshot`.
  const freshness = await buildProjectFreshnessSnapshot(root);
  const [plain, schemaGroups, freshnessGroups] = await Promise.all([
    Promise.all(RULES_WITHOUT_SCHEMA.map(async (entry) => ({
      tier: entry.tier,
      results: await (entry.rule === checkBrokenWikilinks ? checkBrokenWikilinks(root, scope) : entry.rule(root)),
    }))),
    Promise.all(RULES_WITH_SCHEMA.map(async (entry) => ({ tier: entry.tier, results: await entry.rule(root, schema) }))),
    Promise.all(RULES_WITH_FRESHNESS.map(async (entry) => ({ tier: entry.tier, results: await entry.rule(root, freshness) }))),
  ]);
  const defaultResults = [...plain, ...schemaGroups, ...freshnessGroups];
  return [...defaultResults, ...await profileGroups(root, defaultResults.flatMap((group) => group.results))];
}

/**
 * Run all lint rules concurrently against the wiki at the given root.
 * Loads the project schema (or defaults) so schema-aware rules can enforce
 * per-kind cross-link minimums alongside structural checks. When the project
 * declares a NON-default profile, profile-aware entity findings are appended;
 * a default profile leaves the output byte-identical to the pre-profile linter.
 * @param root - Absolute path to the project root directory.
 * @returns A summary containing all diagnostics and severity counts.
 */
export async function lint(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LintSummary> {
  // lint is intentionally not journaled to log.md — it is a read-only check,
  // and the MCP `lint_wiki` tool documents it as non-mutating.
  return summarize((await collectTieredGroups(root, "generic", env)).flatMap((group) => group.results));
}

/**
 * The same check, split by the KIND of claim each finding makes (§4.6).
 *
 * Same rules, same order, same findings as {@link lint} — only the grouping
 * differs, so the two can never disagree about what is wrong with a wiki.
 * Read-only, like `lint`.
 *
 * @param root - Absolute path to the project root directory.
 * @returns Findings split into deterministic, provider-judgement and derived-view.
 */
/**
 * Every registered rule with the tier its registry entry declares.
 *
 * EXPOSED SO A CONTROL CAN PIN THE COMPLETE SET. Mis-tiering is silent by
 * nature — a model's judgement filed as `deterministic` makes
 * {@link TieredLintReportV1.deterministicErrors} claim a wiki is broken when it
 * only holds an opinion — and no behavioural test catches it, because the rule
 * still runs and still reports. The label is the rule FUNCTION's own name, so
 * the list is derived from the registry rather than hand-written beside it and
 * a newly registered rule shows up here without anyone remembering to add it.
 *
 * @returns One entry per registered rule, in registry order.
 */
export function declaredRuleTiers(): ReadonlyArray<{ rule: string; tier: LintTierV1 }> {
  return [...RULES_WITHOUT_SCHEMA, ...RULES_WITH_SCHEMA, ...RULES_WITH_FRESHNESS]
    .map((entry) => ({ rule: entry.rule.name, tier: entry.tier }));
}

export async function lintByTier(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TieredLintReportV1> {
  return tieredReport(await collectTieredGroups(root, "generic", env));
}

/**
 * Both views of ONE run: the flat summary and the tiered report.
 *
 * A caller that needs both — the CLI writes the summary to the lint cache and
 * prints the tiers — would otherwise run every rule twice, and two runs of a
 * filesystem check can legitimately disagree if the tree changes between them.
 *
 * @param root - Absolute path to the project root directory.
 */
export async function lintBothViews(
  root: string,
  scope: PageScope = "generic",
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ summary: LintSummary; tiered: TieredLintReportV1 }> {
  const groups = await collectTieredGroups(root, scope, env);
  return { summary: summarize(groups.flatMap((group) => group.results)), tiered: tieredReport(groups) };
}
