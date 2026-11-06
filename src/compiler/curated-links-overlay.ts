/**
 * @file The render-time curated-link OVERLAY: re-anchoring a durable record onto a
 * freshly generated body (S8, S12).
 *
 * THE DEFECT THIS REPAIRS. Stage 5 curates a link by editing a page's generated body, and
 * bodies are regenerated wholesale whenever the page's own source changes, so the link
 * disappears and returns only if the target article is reviewed again. Present -> absent ->
 * present with no source change makes the link graph a function of which source was
 * ingested last.
 *
 * THE ASYMMETRY THAT HID IT. A mention of the target's TITLE is re-wrapped on every render
 * by the resolver, so a title-anchored curated link comes back by itself. A mention of an
 * ALIAS has no such passive channel, so alias-anchored links are the ones destroyed --
 * and the ones the tests use.
 *
 * THE ANCHOR IS RE-VALIDATED ON EVERY RENDER, which is what keeps S8 intact: "Los enlaces
 * deben estar asociados a una mención o sección real del artículo." The mention is looked
 * for with the SAME primitive retrieval used to propose it ({@link firstPlainMention}), so
 * a proposal and its re-validation cannot disagree about what a mention is. If the words
 * are gone the link is NOT injected and the record is DROPPED with a reason the run
 * reports: silently keeping an unanchored link would break S8, and silently dropping it
 * would reproduce the oscillation.
 *
 * THE OVERLAY IS IDEMPOTENT and holds two named bounds: a body already linked to the
 * record's target with the record's words is left alone, and at most
 * `MAX_CURATED_LINKS_PER_PAGE` records are considered per page, with the rest counted.
 */

import { MAX_CURATED_LINKS_PER_PAGE } from "../utils/constants.js";
import { firstPlainMention } from "./link-review-candidates.js";
import {
  isCurated,
  slugOfPageId,
  type CuratedLinkDropReason,
  type CuratedLinkRecord,
} from "./curated-links.js";
import * as output from "../utils/output.js";

/** A record the overlay could not re-anchor, with the evidence it reported. */
export interface CuratedLinkDrop {
  /** Which record was dropped. */
  stableKey: string;
  /** The link target that will not be re-created. */
  targetPageId: string;
  /** Why it was dropped. */
  reason: CuratedLinkDropReason;
  /** The mention text the record required. */
  anchor: string;
}

/** What one overlay application did to one body. */
export interface CuratedOverlayOutcome {
  /** The body to write: restored links applied, refused ones left as plain text. */
  body: string;
  /** How many curated records were re-injected. */
  applied: number;
  /** The records refused because their mention is gone. */
  dropped: CuratedLinkDrop[];
  /** Records over the per-page bound that were not considered. */
  truncated: number;
}


/**
 * Report every record the overlay refused, one line each, naming the page and the reason.
 *
 * Per-record detail rather than a count, because the operator's next question is WHICH
 * link went and where it was anchored, and only this line can answer it.
 *
 * @param sourcePageId - The page whose body no longer supports the link.
 * @param drops - What the overlay refused on that page.
 */
export function reportCuratedLinkDrops(
  sourcePageId: string,
  drops: readonly CuratedLinkDrop[],
): void {
  for (const drop of drops) {
    output.status("!", output.warn(
      `Curated link dropped on ${sourcePageId}: ${drop.targetPageId} — ${drop.reason} ` +
        `("${drop.anchor}" is no longer a plain mention).`,
    ));
  }
}

/**
 * Re-anchor every curated record of ONE page onto a freshly generated body.
 *
 * The order of the three tests per record is what makes this idempotent:
 *
 *  1. ALREADY A LINK -- the body already carries `[[target|anchor]]` (the previous render
 *     kept it, or the resolver restored it). Nothing to do, and in particular NOT a drop:
 *     the record is still valid, it is just already applied.
 *  2. THE MENTION IS A PLAIN MENTION -- `firstPlainMention` finds the anchor as words a
 *     link can attach to: not inside an existing link, a citation marker or a code span,
 *     and not glued to a longer word. That is exactly the rule retrieval used to propose
 *     the link, so proposal and re-validation cannot disagree.
 *  3. OTHERWISE the body no longer supports the link. The record is dropped with its
 *     reason, and the caller reports it.
 *
 * @param body - The fresh body, frontmatter already stripped.
 * @param sourcePageId - The page this body belongs to.
 * @param records - Every record the store holds; records of other pages are ignored.
 * @returns The body to write, and what the overlay did.
 */
export function overlayCuratedLinks(
  body: string,
  sourcePageId: string,
  records: readonly CuratedLinkRecord[],
): CuratedOverlayOutcome {
  const outcome: CuratedOverlayOutcome = { body, applied: 0, dropped: [], truncated: 0 };
  const mine = records
    .filter((record) => record.sourcePageId === sourcePageId && isCurated(record))
    .sort((left, right) => (left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0));
  outcome.truncated = Math.max(0, mine.length - MAX_CURATED_LINKS_PER_PAGE);
  for (const record of mine.slice(0, MAX_CURATED_LINKS_PER_PAGE)) {
    const linked = overlayOne(outcome.body, record);
    if (linked === null) {
      outcome.dropped.push({
        stableKey: record.stableKey,
        targetPageId: record.targetPageId,
        reason: "anchor-missing",
        anchor: record.anchor.text,
      });
      continue;
    }
    if (linked !== outcome.body) {
      outcome.body = linked;
      outcome.applied += 1;
    }
  }
  return outcome;
}

/**
 * Re-anchor one record, or report that the body cannot hold it.
 *
 * @param body - The body as it stands, possibly already edited by an earlier record.
 * @param record - The curated link to restore.
 * @returns The body (unchanged when the link is already there), or null when the anchor
 *   mention no longer exists.
 */
function overlayOne(body: string, record: CuratedLinkRecord): string | null {
  if (carriesLink(body, record)) return body;
  const mention = firstPlainMention(body, [record.anchor.text]);
  if (mention === null) return null;
  const link = `[[${slugOfPageId(record.targetPageId)}|${mention.text}]]`;
  return `${body.slice(0, mention.start)}${link}${body.slice(mention.end)}`;
}

/**
 * Whether a body is already linked to the record's target with the record's words.
 *
 * The visible text is compared on the same folded spelling the mention scan uses, so
 * `[[vector-db|pgvector store]]` and `[[vector-db|PGVector Store]]` count as the same
 * applied link. A bare `[[vector-db]]` counts too: it names the target, which is all the
 * record asks for, and re-wrapping it would put a link inside a link.
 *
 * @param body - The body to inspect.
 * @param record - The record to look for.
 * @returns True when the link is already present.
 */
function carriesLink(body: string, record: CuratedLinkRecord): boolean {
  const slug = slugOfPageId(record.targetPageId);
  const wanted = foldText(record.anchor.text);
  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/gu)) {
    const [target = "", alias] = (match[1] ?? "").split("|");
    const written = target.trim().replace(/^concepts\//u, "");
    if (written !== slug) continue;
    if (alias === undefined || foldText(alias) === wanted) return true;
  }
  return false;
}

/** The spelling two names are compared on: trimmed, whitespace-collapsed, lower-cased. */
function foldText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}
