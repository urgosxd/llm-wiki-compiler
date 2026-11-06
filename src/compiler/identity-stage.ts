/**
 * @file src/compiler/identity-stage.ts
 * @description The pipeline stage that applies ONE concept-identity decision to a
 * whole compile run, before anything derives a slug from a concept name.
 *
 * ## Where it sits, and why exactly there
 *
 * It runs after extraction (the concepts are known) and after the page snapshot
 * (which supplies the incumbents), but before page generation and before the
 * progress denominator. Everything downstream — the merge accumulators, the
 * affected-page set, the persisted source state, the extraction snapshot, the page
 * writes — then reads one consistent set of names, because they all slugify the
 * extractions this stage already rewrote.
 *
 * ## Why the incumbents are a snapshot, not a slug set
 *
 * The canonical-name rule is "the incumbent survives", and the alias rule is "a name
 * this page already answers to resolves to it". A bare `ReadonlySet<string>` can
 * express neither the canonical title nor the aliases, so the orchestrator hands over
 * {@link ConceptIncumbentSnapshot} instead: one value carrying both, loaded once by
 * {@link snapshotIncumbentConcepts}. The decision itself stays pure — it reads no
 * files — so it cannot disagree with the snapshot the rest of the run is using.
 */

import { readdir } from "fs/promises";
import path from "path";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { conceptEmbeddingPortOrUndefined } from "../dimensions/wiki/concept-embeddings.js";
import type {
  ConceptIncumbentPage,
  ConceptIncumbentSnapshot,
} from "../dimensions/wiki/concept-resolution.js";
import type { PageContentSource } from "../dimensions/wiki/page-scan-source.js";
import { readWikiPageFrom } from "./confined-wiki-read.js";
import {
  bindConceptsToCanonicalNames,
  conceptIdentityDecisions,
  foldedNamesByGroupSlug,
  reportConceptIdentity,
  resolveExtractionIdentity,
  supersededPageSlugs,
  type ConceptIdentityDecision,
} from "./extraction-identity.js";
import type { ExtractionResult } from "./deps.js";

/** What the stage decided, for the stages after it. */
export interface ConceptIdentityOutcome {
  /** The run's extractions, carrying canonical concept names. */
  readonly extractions: ExtractionResult[];
  /** Per-concept decisions, in flatten order. */
  readonly decisions: readonly ConceptIdentityDecision[];
  /**
   * Pages whose concept name folded into another group, mapped to the slug that
   * absorbed it.
   *
   * Each of those pages now describes a concept the wiki no longer stores under
   * that name, so a later pass retires it. Left in place, one concept is split
   * across two files — the defect this feature exists to remove.
   */
  readonly superseded: ReadonlyMap<string, string>;
  /**
   * Folded-away names per surviving page slug.
   *
   * Persisted into that page's frontmatter `aliases`, which is what makes the
   * decision stick: the next ingest folds these names by rule instead of by score.
   */
  readonly aliasesBySlug: ReadonlyMap<string, readonly string[]>;
}

/** Coerce a frontmatter `aliases` value into plain strings, dropping anything else. */
function readDeclaredAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((alias): alias is string => typeof alias === "string" && alias.trim() !== "")
    .map((alias) => alias.trim());
}

/** The concept page slugs to snapshot, from rows when they are the corpus. */
async function incumbentSlugs(
  root: string,
  source: PageContentSource | undefined,
): Promise<string[]> {
  if (source !== undefined) {
    return [...(await source.listSlugs("concepts"))].sort();
  }
  const files = await readdir(path.join(root, CONCEPTS_DIR)).catch(() => [] as string[]);
  return files
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .sort();
}

/**
 * Load every existing concept page's slug, canonical name and declared aliases.
 *
 * The page's title is the canonical name identity must respect; it is only trusted
 * when it is a non-empty string, and the slug stands in otherwise. A page that cannot
 * be read contributes nothing at all rather than aborting the compile, matching the
 * confined read's drop-and-warn policy.
 *
 * @param root - Project root the concept pages live under.
 * @param source - Row-backed page source, or undefined to read `wiki/concepts`.
 * @returns The snapshot identity resolution reads.
 */
export async function snapshotIncumbentConcepts(
  root: string,
  source?: PageContentSource,
): Promise<ConceptIncumbentSnapshot> {
  const snapshot = new Map<string, ConceptIncumbentPage>();
  for (const slug of await incumbentSlugs(root, source)) {
    // warnAlways=false: a page listed by the backend but unreadable is dropped
    // quietly; an ESCAPING entry still warns, because it physically exists.
    const content = await readWikiPageFrom(root, CONCEPTS_DIR, slug, source, false);
    if (content === "") {
      continue;
    }
    const { meta } = parseFrontmatter(content);
    const title = typeof meta.title === "string" ? meta.title.trim() : "";
    snapshot.set(slug, {
      canonicalName: title === "" ? slug : title,
      aliases: readDeclaredAliases(meta.aliases),
    });
  }
  return snapshot;
}

/**
 * Resolve, bind and report concept identity for one compile run.
 *
 * Degrades to "every concept keeps its own name" when nothing was extracted: a run
 * with no concepts has no identity to decide, and must not fail for the absence.
 * Why similarity proposals did not run is reported by the resolver rather than
 * swallowed here.
 *
 * @param extractions - This run's extraction results, as extracted.
 * @param incumbents - Existing concept pages: their names and declared aliases.
 * @returns Canonical-named extractions plus the decisions taken.
 */
export async function applyConceptIdentity(
  extractions: ExtractionResult[],
  incumbents: ConceptIncumbentSnapshot,
): Promise<ConceptIdentityOutcome> {
  const plan = await resolveExtractionIdentity(extractions, {
    incumbents,
    embed: conceptEmbeddingPortOrUndefined(),
  });
  if (plan === undefined) {
    return { extractions, decisions: [], superseded: new Map(), aliasesBySlug: new Map() };
  }
  reportConceptIdentity(plan);
  const decisions = conceptIdentityDecisions(extractions, plan);
  // A folded name loses its producer. The guard inside `supersededPageSlugs` is
  // that its slug is not ALSO a group slug: an unrelated concept may legitimately
  // own that page, and retiring it would remove a live concept over a collision.
  const groupSlugs = new Set(decisions.map((decision) => decision.entry.groupSlug));
  return {
    extractions: bindConceptsToCanonicalNames(extractions, plan),
    decisions,
    superseded: supersededPageSlugs(groupSlugs, decisions),
    aliasesBySlug: foldedNamesByGroupSlug(decisions),
  };
}
