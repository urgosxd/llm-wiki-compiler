/**
 * LLM prompt templates and tool schemas for the compilation pipeline.
 * Contains the Anthropic tool definition for concept extraction,
 * prompt builders for both extraction and page generation phases,
 * and a parser for the structured tool output.
 */

import type {
  ContradictionRef,
  ExtractedConcept,
  ProvenanceState,
} from "../utils/types.js";
import type { PageKindRule, SeedPage } from "../schema/index.js";
import { languageDirective } from "../utils/output-language.js";
import { activeSystemPolicy } from "./prompt-modifiers.js";
import { sourcesSectionEnabled } from "../utils/sources-section.js";
import { MAX_CONCEPTS_PER_SOURCE } from "../utils/constants.js";

/**
 * Build a list of optional prompt lines, omitting empty entries so the
 * default-case prompt is byte-identical to the previous version. Used by
 * the prompt builders to splice in the output-language directive only
 * when the user opted in.
 */
export function withLangLine(...lines: string[]): string[] {
  const lang = languageDirective();
  return lang ? [...lines, lang] : lines;
}

/**
 * The page-generation instruction for the trailing `## Sources` section, or
 * nothing when the project opted out. Spreadable so the default prompt keeps
 * its exact wording instead of gaining a blank line where the request was.
 */
function sourcesSectionLines(): string[] {
  if (!sourcesSectionEnabled()) return [];
  return ["Include a ## Sources section at the end listing the source document."];
}

/**
 * Named version of the extraction + page-generation prompt contract.
 *
 * Bump this whenever the wording of the extraction tool schema, the
 * extraction system prompt, or the page-generation prompt changes in a way
 * that could alter compiled page content. The export provenance stamp
 * (`promptVersion` in the JSON export envelope) carries this value so a
 * downstream auditor can distinguish pages produced under different prompt
 * generations even when the model id is identical. Format is `vMAJOR`.
 *
 * v5: extraction asks for exhaustive concept recall capped at
 * {@link MAX_CONCEPTS_PER_SOURCE} instead of a brief 3-8 selection.
 * v6: the extraction concept ceiling moved from 100 to 50 per source.
 * v7: the page prompt asks for ANCHORED contextual links (a link only where the
 * text already names the target, only where it helps the reader, never for
 * connectivity, never to itself, at most once per target per section). The link
 * validator in `link-anchoring.ts` enforces the same rule on the result.
 * v8: adds the reference-review prompt, which asks a yes/no question about ONE
 * mention that already exists on an EARLIER page. It writes no prose and takes no
 * part in page generation, so no compiled page changes shape under it; it is
 * versioned because the answers it produces are part of what a run judged.
 * v9: the page prompt requires PER-SOURCE ATTRIBUTION of a merged article: several
 * sources become ONE article, and every contributing source is cited somewhere in it.
 * The v8 rule said how to write one citation; this says what a merge owes each source.
 *
 * NOT bumped by the CATEGORY-ASSIGNMENT prompt (`buildCategoryAssignmentPrompt`).
 * That prompt never writes a byte of a page: it proposes categories, which are their
 * own object type in `wiki/categories/`, and the version stamped into a page's
 * frontmatter is a statement about how that page's PROSE was produced. Bumping it
 * here would claim every page in the wiki was regenerated under a new wording when
 * nothing about page generation changed.
 */
export const PROMPT_VERSION = "v9";

/**
 * The caller's system policy as prompt lines, or nothing when none is set.
 *
 * ADDITIVE by construction: the policy lands after every built-in instruction
 * and is introduced as something to follow *in addition to* them, never as a
 * replacement. It is also placed before the source material, so the whole
 * instruction block still precedes the untrusted content it describes. (The
 * page prompt names its concept after the source material, so pages sharing
 * sources share a prompt prefix; the concept is repeated in the user message.)
 *
 * This is advisory prompt text, not an enforceable boundary. A policy makes a
 * model more likely to follow an editorial or publication rule; it cannot make
 * the model obey one, and nothing downstream verifies that it did. Anything
 * that must hold should be a lint rule or a trust gate instead.
 *
 * Read from run state rather than taken as a parameter so the three prompt
 * builders keep their signatures and the option does not have to be threaded
 * through extraction, page rendering, the review pipeline and seed pages, none
 * of which otherwise need to know it exists.
 */
function systemPolicyLines(): string[] {
  const policy = activeSystemPolicy();
  if (!policy) return [];
  return [
    "",
    "Additional system policy (follow in addition to every built-in instruction above):",
    policy,
  ];
}

/** Allowed provenance state strings emitted by the LLM tool schema. */
const PROVENANCE_STATE_VALUES: ProvenanceState[] = [
  "extracted",
  "merged",
  "inferred",
  "ambiguous",
];

/**
 * Anthropic Tool definition for extracting knowledge concepts from a source.
 * Used with callClaude's tool_use mode to get structured concept data.
 */
export const CONCEPT_EXTRACTION_TOOL = {
  name: "extract_concepts",
  description: "Extract knowledge concepts from a source document",
  input_schema: {
    type: "object" as const,
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            concept: {
              type: "string",
              description: "Human-readable concept title",
            },
            summary: {
              type: "string",
              description: "One-line description",
            },
            is_new: {
              type: "boolean",
              description: "True if this is a new concept not in existing wiki",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "2-4 categorical tags for organizing this concept (e.g., 'machine-learning', 'optimization')",
            },
            confidence: {
              type: "number",
              description:
                "Confidence in this concept on a 0..1 scale (1 = directly stated, 0 = highly speculative).",
            },
            provenance_state: {
              type: "string",
              enum: PROVENANCE_STATE_VALUES,
              description:
                "How this concept was produced: 'extracted' (direct from source), 'merged' (synthesised across sources), 'inferred' (model deduction), or 'ambiguous' (sources disagree).",
            },
            contradicted_by: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  slug: { type: "string", description: "Slug of the contradicting concept." },
                  reason: { type: "string", description: "Brief reason for the contradiction." },
                },
                required: ["slug"],
              },
              description: "Slugs of other concepts whose evidence contradicts this one.",
            },
          },
          required: ["concept", "summary", "is_new"],
        },
      },
    },
    required: ["concepts"],
  },
};

/**
 * Build the system prompt for the concept extraction phase.
 * Instructs the LLM to analyze a source document and identify distinct concepts.
 * @param sourceContent - The full text of the source document.
 * @param existingIndex - The current wiki index.md contents (may be empty).
 * @returns System prompt string for the extraction call.
 */
export function buildExtractionPrompt(
  sourceContent: string,
  existingIndex: string,
): string {
  const indexSection = existingIndex
    ? `\n\nHere is the existing wiki index — avoid duplicating concepts already covered:\n\n${existingIndex}`
    : "\n\nNo existing wiki pages yet.";

  return [
    ...withLangLine(
      "You are a knowledge extraction engine. Analyze the following source document",
      `and identify every distinct, meaningful concept it substantiates, up to a`,
      `maximum of ${MAX_CONCEPTS_PER_SOURCE} concepts.`,
      "Each concept should be a standalone topic that someone might look up.",
      "Be exhaustive rather than selective: a long, dense source legitimately" +
        " yields many concepts, and omitting one loses knowledge that no later" +
        " stage can recover. Include key ideas, techniques, patterns, and entities.",
      "Do not pad the list. Every concept you return must be grounded in the" +
        " source and nameable on its own — never split one topic into near-duplicate" +
        " variants just to raise the count.",
      "Use the extract_concepts tool to return your findings.",
    ),
    "",
    "For every concept, emit provenance metadata so downstream tools can reason",
    "about reliability:",
    "  - confidence: 0..1 — how certain you are the source supports this concept.",
    "  - provenance_state: 'extracted' if directly stated, 'merged' if synthesised",
    "    from multiple parts of the source, 'inferred' if reasoned from context,",
    "    or 'ambiguous' if the source is contradictory or unclear.",
    "  - contradicted_by: slugs of other concepts (in this batch or the index)",
    "    whose evidence conflicts with this one.",
    ...systemPolicyLines(),
    indexSection,
    "\n\n--- SOURCE DOCUMENT ---\n\n",
    sourceContent,
  ].join("\n");
}

/**
 * The page prompt's fixed citation and inference instructions. Static text, so
 * it is part of the prefix every page prompt shares.
 */
const PAGE_ATTRIBUTION_LINES: readonly string[] = [
  "Source attribution: at the end of each prose paragraph, append a citation",
  "marker identifying which source file(s) and line range the paragraph drew from.",
  "PREFERRED format: ^[filename.md:START-END] where START and END are the line numbers",
  "shown in the numbered source content below (e.g. ' 42 | some text' → line 42).",
  "Use this whenever you can identify the specific numbered lines supporting the claim.",
  "Fallback format: ^[filename.md] when the claim draws from the source broadly and",
  "no specific line range applies. For multi-source paragraphs: ^[a.md:1-5, b.md:10-12].",
  "Place citations only at the end of prose paragraphs or sentences — not on",
  "headings, list items, or code blocks.",
  "Do not cite YAML frontmatter lines (the --- ... --- block at the top of a file) as",
  "source evidence for substantive claims — those lines are metadata, not content.",
  "If a claim relates to a metadata field (e.g. document date or author), leave it uncited.",
  "Source filenames are visible as `--- SOURCE: filename.md ---` headers in the content below.",
  "",
  "If a paragraph is your inference rather than a direct extraction, leave it",
  "uncited — downstream lint rules will count uncited paragraphs as 'inferred'",
  "so lint can surface excess-inferred-paragraphs warnings on review.",
];

/**
 * The page prompt's MULTI-SOURCE rule: what a merged article owes its sources (S2, S7).
 *
 * WHY IT IS SEPARATE FROM {@link PAGE_ATTRIBUTION_LINES}. That block says HOW to write a
 * citation marker; this one says what a page with several contributing sources must do
 * with them. Without it a model handed two sources can cite one and silently drop the
 * other, which is concatenation with an attribution hole rather than synthesis: the page
 * still LISTS both sources in its frontmatter while no claim is traceable to the second.
 *
 * It names the same `--- SOURCE: filename ---` headers and the same `^[file.md:lines]`
 * convention the citation block and the normalizer already use, so "attributed" means
 * something the pipeline can read rather than a request the model answers on its honour.
 * The rendering census (`page-renderer.ts` `censusSourceAttribution`) counts what came
 * back, because a rule only a model can enforce is a rule nobody verifies.
 */
const PAGE_MULTI_SOURCE_LINES: readonly string[] = [
  "When more than one source contributes to this page, merge what they say into ONE article.",
  "Do not write one section per source, and do not join their texts without attribution.",
  "Attribute every contributing source: each --- SOURCE: filename --- block above must be cited",
  "somewhere in the page, and a claim taken from one source never appears without naming that source.",
];

/**
 * The page prompt's contextual-link instruction.
 *
 * Static text, so it belongs to the prefix every page prompt shares. It states
 * the same rule `link-anchoring.ts` enforces downstream, because a validator can
 * only refuse a bad link while the prompt is the only place that can ask for a
 * good one. Naming the ANCHOR (not "related concepts") is the point: the reader
 * must be able to see why the two pages are connected, and a link written for
 * connectivity or from a similarity score is exactly the link with no anchor.
 */
const PAGE_LINK_LINES: readonly string[] = [
  "Link a concept only where the page text already names it.",
  "Write each link as [[target|the words that name it]] so the anchor stays visible.",
  "Add a link only when it helps the reader understand the passage.",
  "Never add a link to increase connectivity or to match a related list.",
  "Never link the page to itself.",
  "Link a target at most once per section.",
];

/**
 * Build the system prompt for wiki page generation.
 * Instructs the LLM to write a complete wiki page for a single concept.
 *
 * Ordered from most to least shared: fixed instructions, then the source
 * material (closed by an end marker, so wiki context after it is never read as
 * source), then the per-page parts (existing page, related pages, concept).
 * Every page drawn from the same sources then starts with an identical prefix,
 * which backends that reuse a common prompt prefix can skip re-reading; for
 * backends that do not, the prompt stays essentially the same size.
 * @param concept - The concept title to write about.
 * @param sourceContent - The source material to draw from.
 * @param existingPage - The current page content if updating (empty for new pages).
 * @param relatedPages - Concatenated content of related wiki pages for context.
 * @returns System prompt string for the page generation call.
 */
export function buildPagePrompt(
  concept: string,
  sourceContent: string,
  existingPage: string,
  relatedPages: string,
): string {
  const existingSection = existingPage
    ? `\n\nExisting page to update:\n\n${existingPage}`
    : "";

  const relatedSection = relatedPages
    ? `\n\nRelated wiki pages for cross-referencing:\n\n${relatedPages}`
    : "";

  return [
    ...withLangLine(
      'You are a wiki author. Write a clear, well-structured markdown page about the concept named in the "Concept to write about" line after the source material.',
      "Draw facts only from the provided source material.",
      ...sourcesSectionLines(),
      ...PAGE_LINK_LINES,
      "Write in a neutral, informative tone. Be concise but thorough.",
    ),
    "",
    ...PAGE_ATTRIBUTION_LINES,
    ...PAGE_MULTI_SOURCE_LINES,
    ...systemPolicyLines(),
    "\n\n--- SOURCE MATERIAL ---\n\n",
    sourceContent,
    "\n\n--- END SOURCE MATERIAL ---",
    existingSection,
    relatedSection,
    `\n\nConcept to write about: "${concept}".`,
  ].join("\n");
}

/**
 * Anthropic tool definition for the REFERENCE REVIEW of an earlier page (S9).
 *
 * The question is deliberately narrow: one mention that already exists in a page's
 * own text, one article written today, one yes/no answer. The schema forces the
 * model to quote the words it judged, so a verdict can be tied back to a real span
 * of the page and a claim nobody can locate is rejected instead of applied.
 */
export const LINK_REVIEW_TOOL = {
  name: "judge_reference",
  description:
    "Decide whether one existing mention on a wiki page should become a link to another article",
  input_schema: {
    type: "object" as const,
    properties: {
      should_link: {
        type: "boolean",
        description:
          "True only when linking this mention helps a reader of this passage understand it.",
      },
      mention: {
        type: "string",
        description:
          "The exact words of the mention being judged, copied verbatim from the passage.",
      },
    },
    required: ["should_link", "mention"],
  },
};

/** What one reference review decided. */
export interface LinkVerdict {
  /** True when the mention should become a link. */
  shouldLink: boolean;
  /** The words the model judged, as it quoted them (may be empty). */
  mention: string;
}

/**
 * Build the system prompt for ONE reference review of an earlier page.
 *
 * It hands the model the page's own title, the passage containing the mention and
 * the target article's title and summary -- never a similarity score, never a list
 * of "related" pages. The decision belongs to the content: whether this page's
 * reader, at this sentence, is helped by being able to follow the link. Asking for
 * anything else is how the connectivity-for-its-own-sake defect reappears.
 *
 * @param input - The page and passage being judged, plus the article it could link to.
 * @returns System prompt string for the review call.
 */
export function buildLinkReviewPrompt(input: {
  pageTitle: string;
  passage: string;
  articleTitle: string;
  articleSummary: string;
}): string {
  const summaryLine = input.articleSummary.trim() === ""
    ? ""
    : `Summary of that article: ${input.articleSummary}`;
  return [
    ...withLangLine(
      "You are reviewing an existing wiki page for ONE possible link.",
      `The page is titled "${input.pageTitle}". Its passage below already names "${input.articleTitle}".`,
      "Say whether turning that mention into a link helps THIS page's reader understand the passage.",
      "Link only when the target article explains something this passage raises.",
      "Do not link because the two pages are related, similar, or both important.",
      "Do not link to increase connectivity, and never invent a mention: quote words that are already there.",
      "Use the judge_reference tool to answer.",
    ),
    "",
    `Article the mention could link to: "${input.articleTitle}".`,
    summaryLine,
    "\n\n--- PASSAGE FROM THE PAGE ---\n\n",
    input.passage,
    "\n\n--- END PASSAGE ---",
  ].filter((line) => line !== "").join("\n");
}

/**
 * Read a reference-review tool response.
 *
 * Returns `null` when the payload cannot be understood at all, which a caller must
 * count separately from a refusal: "the model said no" and "we could not read the
 * answer" are different facts about a run, and only one of them is a silence.
 *
 * @param toolOutput - Raw JSON string returned from the judge_reference tool.
 * @returns The verdict, or null when the payload is unreadable.
 */
export function parseLinkVerdict(toolOutput: string): LinkVerdict | null {
  try {
    const parsed: unknown = JSON.parse(toolOutput);
    if (typeof parsed !== "object" || parsed === null) return null;
    const payload = parsed as { should_link?: unknown; mention?: unknown };
    if (typeof payload.should_link !== "boolean") return null;
    return {
      shouldLink: payload.should_link,
      mention: typeof payload.mention === "string" ? payload.mention : "",
    };
  } catch {
    return null;
  }
}

/** Raw concept shape as it arrives from the tool JSON. */
interface RawConcept {
  concept: unknown;
  summary: unknown;
  is_new: unknown;
  tags?: unknown;
  confidence?: unknown;
  provenance_state?: unknown;
  contradicted_by?: unknown;
}

/** True if the raw concept has the required string/boolean fields. */
function isValidRawConcept(c: RawConcept): boolean {
  return (
    typeof c.concept === "string" &&
    typeof c.summary === "string" &&
    typeof c.is_new === "boolean" &&
    (c.tags === undefined || Array.isArray(c.tags))
  );
}

/** Coerce raw contradiction entries from the tool into typed refs. */
function coerceContradictedBy(raw: unknown): ContradictionRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: ContradictionRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as { slug?: unknown; reason?: unknown };
    if (typeof obj.slug !== "string" || obj.slug.trim().length === 0) continue;
    const ref: ContradictionRef = { slug: obj.slug.trim() };
    if (typeof obj.reason === "string") ref.reason = obj.reason;
    refs.push(ref);
  }
  return refs.length > 0 ? refs : undefined;
}

/** Map a validated raw concept into an ExtractedConcept. */
function mapRawConcept(c: RawConcept): ExtractedConcept {
  const provenance = typeof c.provenance_state === "string" &&
    PROVENANCE_STATE_VALUES.includes(c.provenance_state as ProvenanceState)
    ? (c.provenance_state as ProvenanceState)
    : undefined;
  return {
    concept: c.concept as string,
    summary: c.summary as string,
    is_new: c.is_new as boolean,
    tags: Array.isArray(c.tags) ? (c.tags as string[]) : undefined,
    confidence: typeof c.confidence === "number" ? c.confidence : undefined,
    provenanceState: provenance,
    contradictedBy: coerceContradictedBy(c.contradicted_by),
  };
}

/**
 * Build a system prompt for generating a seed page (overview / comparison /
 * entity) declared in the project's schema config. Seed pages weave together
 * material from related concept pages rather than from raw source files.
 * @param seed - Seed page definition pulled from the schema.
 * @param rule - Per-kind rule (used for the description and link minimum).
 * @param relatedPagesContent - Concatenated content of related concept pages.
 * @returns System prompt string for the page generation call.
 */
export function buildSeedPagePrompt(
  seed: SeedPage,
  rule: PageKindRule,
  relatedPagesContent: string,
): string {
  const minLinks = rule.minWikilinks;
  const linkExpectation = minLinks > 0
    ? `Include at least ${minLinks} [[wikilinks]] to related pages.`
    : "Use [[wikilinks]] when referencing other pages.";
  return [
    ...withLangLine(
      `You are a wiki author. Write a ${seed.kind} page titled "${seed.title}".`,
      `Page-kind guidance: ${rule.description}`,
      `Summary line for context: ${seed.summary}`,
      "Draw facts only from the related wiki pages provided below.",
      linkExpectation,
      "Write in a neutral, informative tone. Be concise but thorough.",
    ),
    ...systemPolicyLines(),
    "\n\n--- RELATED PAGES ---\n\n",
    relatedPagesContent,
  ].join("\n");
}

/**
 * The outcome of reading an extraction tool response.
 *
 * `settled` separates two situations that both produce zero concepts but have
 * opposite meanings downstream: the model answered with a well-formed (possibly
 * empty) concept list, versus the response could not be understood at all. Only
 * the second is a failure worth retrying. An empty list is normal on a re-compile,
 * because the extraction prompt hands the model the existing concept titles as
 * dedup context and it correctly reports nothing new.
 */
export interface ParsedConcepts {
  /** True when the payload was a readable concept list, empty or not. */
  settled: boolean;
  /** Valid concepts that survived field validation, in model order. */
  concepts: ExtractedConcept[];
}

/**
 * Read an extraction tool response, reporting whether it was understood.
 *
 * @param toolOutput - Raw JSON string returned from the extract_concepts tool.
 * @returns The concepts plus whether the payload parsed as a concept list.
 */
export function parseConceptsResult(toolOutput: string): ParsedConcepts {
  try {
    const parsed: unknown = JSON.parse(toolOutput);
    if (typeof parsed !== "object" || parsed === null) return { settled: false, concepts: [] };
    let concepts: unknown = (parsed as { concepts?: unknown }).concepts ?? [];
    if (typeof concepts === "string") {
      concepts = JSON.parse(concepts);
    }
    if (!Array.isArray(concepts)) return { settled: false, concepts: [] };
    return { settled: true, concepts: concepts.filter(isValidRawConcept).map(mapRawConcept) };
  } catch {
    return { settled: false, concepts: [] };
  }
}

/**
 * Parse the JSON tool output from concept extraction into typed objects.
 * @param toolOutput - Raw JSON string returned from the extract_concepts tool.
 * @returns Array of ExtractedConcept objects.
 */
export function parseConcepts(toolOutput: string): ExtractedConcept[] {
  return parseConceptsResult(toolOutput).concepts;
}
