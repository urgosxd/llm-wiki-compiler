/**
 * JSON-LD graph export format writer.
 *
 * Produces a JSON-LD document using schema.org vocabulary so the wiki graph
 * can be consumed by linked-data tooling, knowledge graph platforms, or any
 * agent that understands the Schema.org ontology.
 *
 * Each wiki page is represented as a schema:Article node. Links derived from
 * [[wikilinks]] are expressed as schema:mentions relationships between nodes.
 */

import type { ExportPage } from "./types.js";
import {
  buildExportLinkIndex,
  exportPageId,
  resolveExportLinkTarget,
  type ExportLinkIndex,
} from "./link-targets.js";

/** Base URL used for page IRIs when no external URL is configured. */
const LOCAL_BASE = "urn:llmwiki:";

/**
 * Build the IRI for a page's QUALIFIED id.
 *
 * `urn:llmwiki:<slug>` was ambiguous: a page is `(page_directory, slug)`
 * (`packages/wiki/src/dimensions/wiki/schema.sql:106`), so `concepts/x` and
 * `queries/x` shared one `@id` and every JSON-LD consumer merged them into a single
 * node. The qualified id is the page's identity everywhere else in the wiki.
 */
function pageIri(page: Pick<ExportPage, "pageDirectory" | "slug">): string {
  return `${LOCAL_BASE}${exportPageId(page)}`;
}

/**
 * Serialise one ExportPage as a JSON-LD Article node.
 *
 * An undated page OMITS `dateCreated`/`dateModified` rather than emitting `""`:
 * schema.org types both as a Date, and the empty string is not a Date — it is a
 * value a linked-data consumer has to special-case, where an absent property is
 * simply an unstated one.
 */
function pageToJsonLd(page: ExportPage, linkIndex: ExportLinkIndex): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@id": pageIri(page),
    "@type": "Article",
    name: page.title,
    description: page.summary,
    ...(page.createdAt ? { dateCreated: page.createdAt } : {}),
    ...(page.updatedAt ? { dateModified: page.updatedAt } : {}),
  };

  if (page.tags.length > 0) {
    node["keywords"] = page.tags;
  }

  // schema.org/isBasedOn is the standard property for citing source material.
  if (page.sources.length > 0) {
    node["isBasedOn"] = page.sources;
  }

  // One entry per target, resolved through the same index GraphML uses: a target is a
  // page REFERENCE (`concepts/y` or a bare slug), so rendering it as an IRI without
  // resolving it minted a mention that no node in this graph declares. A target the
  // export does not hold keeps the IRI it had before — an unresolved mention is a
  // legal reference to a page this graph simply does not contain, and dropping it
  // would be a second behaviour change nobody asked for.
  const iris = [
    ...new Set(
      page.links.map((target) => {
        const linked = resolveExportLinkTarget(linkIndex, target);
        return linked === null ? `${LOCAL_BASE}${target}` : pageIri(linked);
      }),
    ),
  ];
  if (iris.length > 0) {
    node["mentions"] = iris.map((iri) => ({ "@id": iri }));
  }

  return node;
}

/**
 * Build the JSON-LD graph document from a list of export pages.
 * @param pages - Sorted array of export pages.
 * @returns Pretty-printed JSON-LD string.
 */
export function buildJsonLd(pages: ExportPage[]): string {
  const linkIndex = buildExportLinkIndex(pages);
  const doc = {
    "@context": "https://schema.org",
    "@graph": pages.map((page) => pageToJsonLd(page, linkIndex)),
  };
  return JSON.stringify(doc, null, 2);
}
