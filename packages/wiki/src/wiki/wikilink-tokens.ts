/**
 * Shared production wikilink tokenization for the viewer and answer reporting.
 * Token recognition stays independent of page resolution and HTML rendering.
 * Registration follows markdown-it's link rule so link labels, escapes, and
 * code retain the viewer's existing literal-text behavior. Empty targets and
 * repeated occurrences are preserved; reporting owns any deduplication.
 */
import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { slugify } from "../utils/markdown.js";
import { parseQualifiedPageId, qualifiedPageId } from "../utils/page-id.js";
import { shouldDeferInlineRule } from "../viewer/markdown-it-helpers.js";
import { registerCitationTokens } from "./citation-tokens.js";

const OPEN = "[";
const CHAR_OPEN_BRACKET = 0x5b; // "["

/** Register production wikilink recognition without resolution or rendering. */
export function registerWikilinkTokens(md: MarkdownIt): void {
  md.inline.ruler.after("link", "wikilink", parseWikilink);
}

/** Return normalized target occurrences in Markdown document order. */
export function recognizedWikilinkTargets(body: string): string[] {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  registerWikilinkTokens(md);
  registerCitationTokens(md);
  const targets: string[] = [];
  collectTargets(md.parse(body, {}), targets);
  return targets;
}

/** Collect recognized tokens, including those nested in inline/image children. */
function collectTargets(tokens: Token[], result: string[]): void {
  for (const token of tokens) {
    if (token.type === "wikilink") result.push(token.meta.slug);
    if (token.children) collectTargets(token.children, result);
  }
}

/** Recognize one wikilink using the viewer's existing Markdown exclusions. */
function parseWikilink(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== CHAR_OPEN_BRACKET) return false;
  if (state.src.charCodeAt(state.pos + 1) !== CHAR_OPEN_BRACKET) return false;
  if (shouldDeferInlineRule(state, silent)) return false;
  const closeAt = state.src.indexOf("]]", state.pos + 2);
  if (closeAt < 0) return false;
  const inner = state.src.slice(state.pos + 2, closeAt);
  // Markdown convention: forbid newlines inside a single wikilink span.
  if (inner.includes("\n") || inner.includes(OPEN)) return false;
  const { rawTarget, display } = splitTargetAndAlias(inner);
  const slug = normalizeWikilinkTarget(rawTarget.trim());
  const token = state.push("wikilink", "", 0);
  token.meta = { slug, display };
  state.pos = closeAt + 2;
  return true;
}

/**
 * Normalize one raw wikilink target into the form page resolution matches against.
 *
 * A qualified `<namespace>/<page-part>` target keeps its namespace VERBATIM and
 * slugifies only the page part: `slugify` deletes `/` (it keeps only
 * `[^\p{L}\p{N}\s-]`), so slugifying the whole target would fold
 * `concepts/test2` into the unusable `conceptstest2` before any resolver saw the
 * namespace. Any target that is not a valid qualified id is slugified whole,
 * exactly as before.
 *
 * This is the ONE normalization rule for wikilink targets: this tokenizer and the
 * body link extractors in `wiki/collect.ts` both call it, so rendering, answer
 * reporting and the link graph cannot diverge on the same response.
 *
 * @param rawTarget - Inside-brackets target text, already trimmed.
 * @returns The normalized target: `<namespace>/<page-slug>` or a bare slug.
 */
export function normalizeWikilinkTarget(rawTarget: string): string {
  const qualified = parseQualifiedPageId(rawTarget);
  if (!qualified) return slugify(rawTarget);
  return qualifiedPageId(qualified.namespace, slugify(qualified.pagePart));
}

/** Split the inside-brackets text into a raw target and a display label. */
function splitTargetAndAlias(inner: string): { rawTarget: string; display: string } {
  const pipe = inner.indexOf("|");
  if (pipe < 0) return { rawTarget: inner, display: inner.trim() };
  return {
    rawTarget: inner.slice(0, pipe),
    display: inner.slice(pipe + 1).trim() || inner.slice(0, pipe).trim(),
  };
}
