/**
 * @file test/compiler/curated-link-overlay.test.ts
 * @description The overlay RULE itself (S8, S12), driven at the module boundary: what a
 * curated record does to a body, what it must never do, and what its two named bounds
 * refuse.
 *
 * WHY UNIT CASES NEXT TO THE PIPELINE ONES. The pipeline cases (`curated-links.test.ts`)
 * prove the record survives a real compile. These prove the three properties a compile
 * cannot isolate: that the overlay is IDEMPOTENT, that a MECHANICALLY derived link is
 * never overlaid (only the curated channel is), and that each cap refuses and is COUNTED
 * rather than silently truncating. Reaching the per-page cap through compiles would take
 * eight curated links into one page, which the review's three-writes-per-run bound makes
 * impossible by design.
 */

import { describe, it, expect } from "vitest";
import {
  addCuratedLinks,
  createCuratedLink,
  describeCuratedLinks,
  emptyCuratedLinkCounts,
  type CuratedLinkRecord,
} from "../../src/compiler/curated-links.js";
import { overlayCuratedLinks } from "../../src/compiler/curated-links-overlay.js";
import { emptyCuratedLinkStore } from "../../src/compiler/curated-links-store.js";
import { MAX_CURATED_LINKS_PER_PAGE, MAX_CURATED_LINKS_PER_RUN } from "../../src/utils/constants.js";

/** The page the link lives on. */
const SOURCE = "concepts/alpha-topic";

/** The page the link points at. */
const TARGET = "concepts/vector-db";

/** The alias mention the record is anchored to. */
const ANCHOR = "pgvector store";

/** A body that holds the anchor as a plain mention. */
const BODY = "Alpha Topic stores vectors in a pgvector store. ^[alpha.md]";

/** A body whose prose no longer contains the anchor. */
const BODY_WITHOUT_ANCHOR = "Alpha Topic stores vectors only. ^[alpha.md]";

/**
 * One curated record.
 *
 * @param text - The mention to anchor on; defaults to {@link ANCHOR}.
 * @param targetPageId - The page to link; defaults to {@link TARGET}.
 * @returns The record.
 */
function record(text = ANCHOR, targetPageId = TARGET): CuratedLinkRecord {
  return createCuratedLink({
    sourcePageId: SOURCE,
    targetPageId,
    anchor: { text, before: "Alpha Topic stores vectors in a ", after: ". ^[alpha.md]" },
    provenance: "model-verdict",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("curated link overlay", () => {
  it("re-anchors a record onto a freshly generated body", () => {
    const outcome = overlayCuratedLinks(BODY, SOURCE, [record()]);

    expect(outcome.body).toBe(`Alpha Topic stores vectors in a [[vector-db|${ANCHOR}]]. ^[alpha.md]`);
    expect(outcome.applied).toBe(1);
    expect(outcome.dropped).toEqual([]);
  });

  it("is idempotent: applying twice equals applying once, and an applied link is not a drop", () => {
    const once = overlayCuratedLinks(BODY, SOURCE, [record()]);
    const twice = overlayCuratedLinks(once.body, SOURCE, [record()]);

    expect(twice.body).toBe(once.body);
    expect(twice.applied).toBe(0);
    expect(twice.dropped).toEqual([]);
  });

  it("drops a record whose mention the new body no longer holds, and says why", () => {
    const outcome = overlayCuratedLinks(BODY_WITHOUT_ANCHOR, SOURCE, [record()]);

    expect(outcome.body).toBe(BODY_WITHOUT_ANCHOR);
    expect(outcome.applied).toBe(0);
    expect(outcome.dropped).toEqual([
      { stableKey: record().stableKey, targetPageId: TARGET, reason: "anchor-missing", anchor: ANCHOR },
    ]);
  });

  it("never overlays a MECHANICALLY derived link, which the page re-derives itself", () => {
    // A resolver-wrapped or repaired link exists only because the text says so, and both
    // passes that create one run again on every render. Overlaying them would pin a
    // derivation and could duplicate what those passes already do.
    const mechanical = { ...record(), provenance: "resolver-wrap" as const };
    const outcome = overlayCuratedLinks(BODY, SOURCE, [mechanical]);

    expect(outcome.body).toBe(BODY);
    expect(outcome.applied).toBe(0);
    expect(outcome.dropped).toEqual([]);
  });

  it("stores a record once per link and counts each cap it refuses", () => {
    const tally = emptyCuratedLinkCounts();
    const pageFull = Array.from({ length: MAX_CURATED_LINKS_PER_PAGE }, (_, index) =>
      record(`mention ${index}`));
    const afterPage = addCuratedLinks(emptyCuratedLinkStore(), pageFull, tally);
    const overflow = addCuratedLinks(afterPage, [record("one mention too many")], tally);

    expect(afterPage.links).toHaveLength(MAX_CURATED_LINKS_PER_PAGE);
    expect(overflow.links).toHaveLength(MAX_CURATED_LINKS_PER_PAGE);
    expect(tally.truncated["page-cap"]).toBe(1);
    // A repeat of a stored link is the same link, not a second one.
    const repeat = addCuratedLinks(afterPage, [record("mention 0")], tally);
    expect(repeat.links).toHaveLength(MAX_CURATED_LINKS_PER_PAGE);
    expect(describeCuratedLinks(tally) ?? "").toContain("truncated 1 page-cap");
  });

  it("refuses records past the per-run bound and reports the truncation", () => {
    const tally = emptyCuratedLinkCounts();
    const pages = Array.from({ length: MAX_CURATED_LINKS_PER_RUN + 2 }, (_, index) =>
      createCuratedLink({
        sourcePageId: `concepts/page-${index}`,
        targetPageId: TARGET,
        anchor: { text: ANCHOR, before: "", after: "" },
        provenance: "model-verdict",
      }));
    const store = addCuratedLinks(emptyCuratedLinkStore(), pages, tally);

    expect(store.links).toHaveLength(MAX_CURATED_LINKS_PER_RUN);
    expect(tally.recorded).toBe(MAX_CURATED_LINKS_PER_RUN);
    expect(tally.truncated["run-cap"]).toBe(2);
    expect(describeCuratedLinks(tally) ?? "").toContain("truncated 2 run-cap");
  });
});
