/**
 * @file The wiki's synthesis-version split, and the ONE rule that keeps version-shaped
 * state observable.
 *
 * ## What this exists for
 *
 * `PROMPT_VERSION` names the prompt implementation that produced a page, and
 * `addModelProvenanceMeta` stamps it into every page's frontmatter. Nothing compared a
 * stored value to the current one, so a prompt bump left a corpus holding two prompt
 * generations at once and the only surface that said so was the JSON export, which
 * nobody reads. This module computes that split from the pages the wiki actually stores
 * and renders it as ONE line printed on every compile run:
 *
 *     1 page(s) compiled at v1, 2 page(s) compiled at v8 (the current version)
 *
 * ## Why REPORT-ONLY, and what a bump does
 *
 * A bump does NOT invalidate anything: no page is rewritten, no curated-link overlay is
 * re-rooted, and no source is re-extracted. A prompt tweak must not rewrite the corpus on
 * a deploy, because regeneration is a paid model call per page and a mass rewrite would
 * re-root the anchor of every curated link the wiki has accumulated. Staleness is
 * therefore REPORTED, and the operator decides — `llmwiki compile --recompile <page>`
 * regenerates one page (or `--recompile all` a whole stack) at the current version.
 * Observability without that lever would be a dashboard nobody can act on, which is why
 * the printed line names it whenever a page is behind.
 *
 * ## The standing standard for any future version-shaped state
 *
 * Anything else this compiler ever stamps per artifact — an embedding-space version, a
 * schema version, a linker version — must be observable BY THIS SAME STANDARD: it is
 * aggregated over what the wiki stores, reported on a normal run without a verbose flag
 * (plainly when it is uniform, with the counts when it is not), and paired with a
 * documented, bounded way to regenerate one artifact at the current value. Silent
 * version-shaped state is indistinguishable from broken state, so it is not allowed here.
 *
 * ## Bounded, and no silent limits
 *
 * The read is a bounded walk over the concept namespace only (the derived synthesis; a
 * saved query is an answer, not a compiled article), it drops nothing quietly — a page
 * with no recorded version is COUNTED, not skipped — and it never writes.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { PROMPT_VERSION } from "./prompts.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import type { SourceChange, WikiState } from "../utils/types.js";

/** One stored page and the synthesis version its frontmatter records. */
export interface PageVersionRecord {
  /** Namespaced page id, e.g. `concepts/change-detection`. */
  readonly pageId: string;
  /** The recorded version, or `null` when the page carries none. */
  readonly promptVersion: string | null;
}

/** How many stored pages carry one version. */
export interface VersionTally {
  readonly version: string;
  readonly pages: number;
  /** True for the version this build compiles pages at. */
  readonly current: boolean;
}

/** The whole split, as counted over the pages the wiki stores. */
export interface VersionSplit {
  /** The version this build compiles pages at (`PROMPT_VERSION`). */
  readonly current: string;
  /** Every readable stored page, whatever version it records. */
  readonly pages: number;
  /** Distinct versions, in ascending version order. */
  readonly versions: readonly VersionTally[];
  /** Pages with no recorded version at all. */
  readonly unversioned: number;
  /** Pages not at {@link current}: the ones the lever exists for. */
  readonly stalePages: number;
}

/** How a caller is told to refresh a stale page. Printed with every stale report. */
const RECOMPILE_HINT = "regenerate a stale page with `llmwiki compile --recompile <page-id>`";

/** `v<number>` shape used to compare versions numerically instead of lexically. */
const NUMBERED_VERSION = /^v(\d+)$/;

/**
 * Order two recorded versions so the printed line cannot depend on discovery order.
 *
 * `v10` sorts after `v2` when both are numbered (lexical order would put it before, and
 * a wiki three bumps ahead would print in an order nobody expects); anything that is not
 * numbered falls back to a plain code-unit comparison, which is locale-independent.
 *
 * @param left - One recorded version.
 * @param right - The other.
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function compareVersions(left: string, right: string): number {
  const leftNumber = NUMBERED_VERSION.exec(left);
  const rightNumber = NUMBERED_VERSION.exec(right);
  if (leftNumber !== null && rightNumber !== null) {
    return Number(leftNumber[1]) - Number(rightNumber[1]);
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Count a set of page records into the split that is reported.
 *
 * Pure: the caller supplies the records, so the counting rule is testable without a wiki
 * and the reading rule ({@link readWikiVersions}) has one job.
 *
 * @param records - One record per readable stored page.
 * @param current - The version this build compiles at.
 * @returns The split, with the current version always present when the wiki has pages.
 */
export function summarizeVersions(
  records: readonly PageVersionRecord[],
  current: string,
): VersionSplit {
  const counts = new Map<string, number>();
  let unversioned = 0;
  for (const record of records) {
    if (record.promptVersion === null) {
      unversioned += 1;
      continue;
    }
    counts.set(record.promptVersion, (counts.get(record.promptVersion) ?? 0) + 1);
  }
  const versions = [...counts.entries()]
    .map(([version, pages]) => ({ version, pages, current: version === current }))
    .sort((left, right) => compareVersions(left.version, right.version));
  const atCurrent = counts.get(current) ?? 0;
  return {
    current,
    pages: records.length,
    versions,
    unversioned,
    stalePages: records.length - atCurrent,
  };
}

/**
 * Render the split as the ONE line a compile prints.
 *
 * Three shapes, and every one of them names the version(s) in play: uniform and current,
 * uniform and stale (which also names the current version and the lever), and mixed. A
 * wiki with no pages says so instead of printing nothing, because a line that sometimes
 * disappears cannot be told apart from a line that broke.
 *
 * @param split - The counted split.
 * @returns The sentence, without an icon or colour.
 */
export function describeVersionSplit(split: VersionSplit): string {
  if (split.pages === 0) {
    return `Synthesis version: no pages stored yet (the current version is ${split.current}).`;
  }
  const unversioned = split.unversioned === 0
    ? ""
    : `, ${split.unversioned} page(s) with no recorded version`;
  const only = split.versions.length === 1 ? split.versions[0] : undefined;
  if (only !== undefined && split.unversioned === 0 && only.current) {
    return `Synthesis version: ${only.pages} page(s) compiled at ${only.version} (the current version).`;
  }
  if (only !== undefined && split.unversioned === 0) {
    return `Synthesis version: ${only.pages} page(s) compiled at ${only.version} ` +
      `(the current version is ${split.current}) — ${RECOMPILE_HINT}.`;
  }
  const tallies = split.versions
    .map((tally) =>
      `${tally.pages} page(s) compiled at ${tally.version}${tally.current ? " (the current version)" : ""}`)
    .join(", ");
  const head = split.versions.length <= 1 ? "Synthesis version" : "Synthesis version split";
  return `${head}: ${tallies}${unversioned} — ${RECOMPILE_HINT}.`;
}

/** Every concept page slug the wiki stores, in code-unit order. */
async function storedConceptSlugs(root: string, source?: PageContentSource): Promise<string[]> {
  if (source !== undefined) return [...(await source.listSlugs("concepts"))].sort();
  const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)).sort();
}

/**
 * Read the recorded synthesis version of every concept page the wiki stores.
 *
 * Uses the run's page-content seam when one is supplied, so a row-backed project reads the
 * rows it just wrote rather than a filesystem that holds nothing. A page the backend lists
 * but cannot read contributes no record (the confined read's drop-and-warn policy) — which
 * is why the report counts RECORDS, and why an unreadable page cannot masquerade as a page
 * at the current version.
 *
 * @param root - Project root the reads are confined under.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns One record per readable stored concept page, in slug order.
 */
async function readWikiVersions(
  root: string,
  source?: PageContentSource,
): Promise<PageVersionRecord[]> {
  const records: PageVersionRecord[] = [];
  for (const slug of await storedConceptSlugs(root, source)) {
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, slug, source, false);
    if (content === "") continue;
    const recorded = parseFrontmatter(content).meta.promptVersion;
    records.push({
      pageId: `${CONCEPTS_DIR}/${slug}`,
      promptVersion: typeof recorded === "string" && recorded.trim() !== "" ? recorded.trim() : null,
    });
  }
  return records;
}

/**
 * Read and count the split in one step, against the version this build compiles at.
 *
 * @param root - Project root the reads are confined under.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The split, ready to report.
 */
export async function readVersionSplit(
  root: string,
  source?: PageContentSource,
): Promise<VersionSplit> {
  return summarizeVersions(await readWikiVersions(root, source), PROMPT_VERSION);
}

/*
 * ---------------------------------------------------------------------------
 * The LEVER: planning a scoped `llmwiki compile --recompile` run.
 *
 * A page is stamped with the version that produced it, and the report above says
 * which pages are behind. This half turns that report into an action: which pages
 * a request names, which sources can regenerate them, and what a run must do to
 * change NOTHING else. It lives beside the report because the two are one rule --
 * version-shaped state is observable only if it is also actionable.
 * ---------------------------------------------------------------------------
 */

/** Why one requested page cannot be regenerated. Each reason is reported verbatim. */
export type RecompileRefusalReason = "empty-wiki" | "unknown-page" | "no-owner";

/** One request that cannot be honoured, with the reason a caller is told. */
export interface RecompileRefusal {
  readonly request: string;
  readonly reason: RecompileRefusalReason;
}

/** What a scoped regeneration resolved to, before any work is done. */
export interface RecompilePlan {
  /** Page slugs to regenerate, in code-unit order and deduplicated. */
  readonly slugs: readonly string[];
  /** Source files whose ownership makes those pages regenerable. */
  readonly sourceFiles: ReadonlySet<string>;
  /** Requests that cannot be honoured; a non-empty list refuses the whole run. */
  readonly refused: readonly RecompileRefusal[];
}

/** The literal a caller uses to mean "every page the wiki stores". */
const RECOMPILE_ALL = "all";

/** `concepts/<slug>` -> `<slug>`, leaving a bare slug untouched. */
/** The namespace a caller types for a concept page, as `links-here` and `race` accept it. */
const CONCEPT_NAMESPACE = "concepts";

/**
 * Reduce a caller's page reference to the bare slug under `wiki/concepts`.
 *
 * Three forms are accepted, and all three mean the same page: the namespaced page id a
 * reader sees in a link (`concepts/foo`), the project-relative path a path copy-paste
 * produces (`wiki/concepts/foo`), and the bare slug (`foo`). The stripping order matters —
 * `wiki/concepts/foo` also starts with a prefix of the namespace form — so the longer
 * prefix is removed first.
 *
 * @param requested - Whatever the caller typed.
 * @returns The bare slug.
 */
function barePageSlug(requested: string): string {
  const trimmed = requested.trim();
  if (trimmed.startsWith(`${CONCEPTS_DIR}/`)) return trimmed.slice(CONCEPTS_DIR.length + 1);
  if (trimmed.startsWith(`${CONCEPT_NAMESPACE}/`)) {
    return trimmed.slice(CONCEPT_NAMESPACE.length + 1);
  }
  return trimmed;
}

/**
 * Resolve what a scoped `--recompile` run should regenerate, and what it cannot.
 *
 * Validation happens BEFORE any write, so an unusable request is a refusal instead of a
 * run that quietly regenerated nothing: the pages are looked up in what the wiki stores,
 * and each one must have a live source owner in `state.json`, because the owner's source
 * text is the only input a page can be regenerated from.
 *
 * @param root - Project root the reads are confined under.
 * @param state - The run's state, i.e. recorded source ownership.
 * @param requested - Page ids, bare slugs, or `all`.
 * @param source - Row-backed page reader, or undefined to read `wiki/concepts`.
 * @returns The plan: slugs to regenerate, their owning sources, and every refusal.
 */
export async function planRecompile(
  root: string,
  state: WikiState,
  requested: readonly string[],
  source?: PageContentSource,
): Promise<RecompilePlan> {
  const stored = (await readWikiVersions(root, source)).map((record) => barePageSlug(record.pageId));
  if (stored.length === 0) {
    return {
      slugs: [],
      sourceFiles: new Set<string>(),
      refused: [{ request: requested[0] ?? RECOMPILE_ALL, reason: "empty-wiki" }],
    };
  }
  const refused: RecompileRefusal[] = [];
  const slugs: string[] = [];
  const sourceFiles = new Set<string>();
  for (const slug of resolveRequestedSlugs(requested, new Set(stored), refused)) {
    const owners = sourceOwnersOf(state, slug);
    if (owners.size === 0) {
      refused.push({ request: `${CONCEPTS_DIR}/${slug}`, reason: "no-owner" });
      continue;
    }
    slugs.push(slug);
    for (const file of owners) sourceFiles.add(file);
  }
  return { slugs: slugs.sort(), sourceFiles, refused };
}

/**
 * Narrow the requested names to the stored page slugs, collecting what does not match.
 *
 * @param requested - Page ids, bare slugs, or `all`.
 * @param known - Every page slug the wiki stores.
 * @param refused - Refusals collected so far, extended in place.
 * @returns The stored slugs the run should regenerate.
 */
function resolveRequestedSlugs(
  requested: readonly string[],
  known: ReadonlySet<string>,
  refused: RecompileRefusal[],
): Set<string> {
  const slugs = new Set<string>();
  for (const request of requested) {
    if (request.trim() === RECOMPILE_ALL) {
      for (const slug of known) slugs.add(slug);
      continue;
    }
    const slug = barePageSlug(request);
    if (known.has(slug)) slugs.add(slug);
    else refused.push({ request: request.trim(), reason: "unknown-page" });
  }
  return slugs;
}

/** Every source file whose recorded ownership includes `slug`. */
function sourceOwnersOf(state: WikiState, slug: string): Set<string> {
  const owners = new Set<string>();
  for (const [file, entry] of Object.entries(state.sources)) {
    if (entry.concepts.includes(slug)) owners.add(file);
  }
  return owners;
}

/** The operator-facing sentence for one refusal. */
export function describeRecompileRefusal(refusal: RecompileRefusal): string {
  if (refusal.reason === "empty-wiki") {
    return "Cannot recompile: this wiki stores no pages yet (nothing to regenerate).";
  }
  if (refusal.reason === "no-owner") {
    return `Cannot recompile ${refusal.request}: no source owns this page, ` +
      "so no compile can regenerate it.";
  }
  return `Cannot recompile: no page named "${refusal.request}" exists in this wiki.`;
}

/**
 * The change list a scoped regeneration acts on.
 *
 * The owning sources are FORCED to `changed`: their bytes did not move, so change
 * detection says `unchanged`, and a run that honoured that would regenerate nothing at
 * all. Every other source is dropped from the list — that is what keeps the run scoped to
 * the pages that were asked for. Co-contributing sources are re-added by the ordinary
 * affected-source expansion, which is what makes the regenerated page keep every source
 * that answers for it.
 *
 * @param detected - The full change detection result.
 * @param plan - The resolved regeneration plan.
 * @returns Changes for the owning sources only, all but deletions forced to `changed`.
 */
export function scopeChangesToRecompile(
  detected: SourceChange[],
  plan: RecompilePlan,
): SourceChange[] {
  return detected
    .filter((change) => plan.sourceFiles.has(change.file))
    .map((change) => (change.status === "deleted" ? change : { ...change, status: "changed" as const }));
}
