/**
 * @file The ONE shared application of the curated-link overlay to bodies about to be
 * written (S9, S12).
 *
 * WHY ONE FUNCTION. Three kinds of site can replace a page body -- generation, seed-page
 * rendering, and the resolution phase that `review approve` and an OKF import also go
 * through -- and each doing its own lookup and insertion is how a wiki ends up with three
 * slightly different notions of whether a curated link is still anchored, plus a record
 * store that grows on every render. So the store is read ONCE per batch here, every
 * record is re-anchored by `curated-links-overlay.ts`, each refused record is reported by
 * page and reason, and the refused records are forgotten through the store.
 *
 * Reporting is part of the application rather than the caller's business: a dropped
 * curated link is a link the wiki just lost, and S12 is explicit that no limit and no
 * partial processing may be silent.
 *
 * ONE OVERLAY, TWO STORES. The records are read and forgotten through a
 * `CuratedLinkStorePort`, which is the confined file on a project with no Stack and the
 * Stack's `wiki.curated_links` rows on a row-backed one. Nothing below branches on the
 * backend: the re-anchoring rule is this function, so the two paths cannot disagree
 * about whether a mention still supports its link.
 */

import { parseFrontmatter } from "../utils/markdown.js";
import {
  emptyCuratedLinkCounts,
  type CuratedLinkCounts,
  type CuratedLinkStorePort,
} from "./curated-links.js";
import {
  overlayCuratedLinks,
  reportCuratedLinkDrops,
  type CuratedOverlayOutcome,
} from "./curated-links-overlay.js";
import { createFileCuratedLinkStore } from "./curated-links-store.js";
import type { CompilePageWrite } from "./compile-write.js";

/** One body to overlay: the page it belongs to, and its prose without frontmatter. */
export interface CuratedBodyTarget {
  /** Resolved page id of the page the body belongs to. */
  pageId: string;
  /** The body's prose, frontmatter already stripped. */
  body: string;
}

/** What one batch overlay did. */
export interface CuratedOverlayBatch {
  /** The new prose per page id, in the order the targets arrived. */
  bodies: Map<string, CuratedOverlayOutcome>;
  /** What the batch restored, dropped and truncated. */
  counts: CuratedLinkCounts;
}

/**
 * THE shared application of the overlay: read the store ONCE, re-anchor every record onto
 * the body it belongs to, report each refused record, and forget the refused ones.
 *
 * One function for every caller on purpose. The alternative -- each body-rewriting site
 * doing its own lookup and insertion -- is how a wiki ends up with three slightly
 * different notions of whether a curated link is still anchored, and with a record
 * store that grows every time a page is regenerated.
 *
 * @param root - Absolute project root the file backend is confined under.
 * @param targets - The bodies to overlay, with their page ids.
 * @param store - The durable store to read and forget through; omitted means the
 *   confined file, which is what every caller without a Stack gets.
 * @returns The overlaid bodies and the batch's counts.
 */
export async function applyCuratedOverlay(
  root: string,
  targets: readonly CuratedBodyTarget[],
  store?: CuratedLinkStorePort,
): Promise<CuratedOverlayBatch> {
  const batch: CuratedOverlayBatch = { bodies: new Map(), counts: emptyCuratedLinkCounts() };
  if (targets.length === 0) return batch;
  const backend = store ?? createFileCuratedLinkStore(root);
  const records = await backend.load();
  if (records.length === 0) return batch;
  const dropped: string[] = [];
  for (const target of targets) {
    const outcome = overlayCuratedLinks(target.body, target.pageId, records);
    batch.bodies.set(target.pageId, outcome);
    if (outcome.applied === 0 && outcome.dropped.length === 0 && outcome.truncated === 0) continue;
    batch.counts.applied += outcome.applied;
    batch.counts.truncated["page-cap"] += outcome.truncated;
    batch.counts.dropped["anchor-missing"] += outcome.dropped.length;
    reportCuratedLinkDrops(target.pageId, outcome.dropped);
    for (const record of outcome.dropped) dropped.push(record.stableKey);
  }
  await backend.drop(dropped);
  return batch;
}

/**
 * Overlay the curated records onto a set of page writes about to commit.
 *
 * The caller is a body-REWRITING site: a place where a whole body is replaced by fresh
 * content, which is the only kind of site that can destroy a curated link. Each write's
 * frontmatter is preserved byte for byte -- the overlay edits prose only, and the rebuild
 * is a replacement FUNCTION so page prose containing `$&` or `$$` is never reinterpreted.
 *
 * @param root - Absolute project root the file backend is confined under.
 * @param writes - The page writes about to be applied.
 * @param store - The durable store to read and forget through; omitted means the file.
 * @returns The writes to apply instead, and what the overlay did.
 */
export async function overlayCuratedPageWrites(
  root: string,
  writes: readonly CompilePageWrite[],
  store?: CuratedLinkStorePort,
): Promise<{ writes: CompilePageWrite[]; counts: CuratedLinkCounts }> {
  const prose = writes.map((write) => ({
    write, parsed: parseFrontmatter(write.body), pageId: `${write.namespace}/${write.slug}`,
  }));
  const batch = await applyCuratedOverlay(
    root,
    prose.map((item) => ({ pageId: item.pageId, body: item.parsed.body })),
    store,
  );
  const overlaid = prose.map((item) => {
    const outcome = batch.bodies.get(item.pageId);
    if (outcome === undefined || outcome.body === item.parsed.body) return item.write;
    return {
      ...item.write,
      body: item.write.body.replace(item.parsed.body, () => outcome.body),
    };
  });
  return { writes: overlaid, counts: batch.counts };
}
