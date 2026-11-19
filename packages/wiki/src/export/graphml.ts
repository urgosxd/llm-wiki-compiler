/**
 * GraphML export format writer.
 *
 * Produces a GraphML XML document representing the wiki link graph.
 * Each page becomes a node; each [[wikilink]] between pages becomes a
 * directed edge. Node attributes carry page metadata (title, summary, tags).
 *
 * GraphML is the standard XML format for graph exchange and is supported by
 * Gephi, yEd, NetworkX, and many other graph tools.
 */

import type { ExportPage } from "./types.js";
import {
  buildExportLinkIndex,
  exportPageId,
  resolveExportPageLinks,
  type ExportLinkIndex,
} from "./link-targets.js";

/** XML special characters that must be escaped in attribute values and text. */
const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape a string for safe inclusion in XML. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** GraphML attribute key definitions. */
const KEY_DEFS = [
  '<key id="title"     for="node" attr.name="title"     attr.type="string"/>',
  '<key id="summary"   for="node" attr.name="summary"   attr.type="string"/>',
  '<key id="tags"      for="node" attr.name="tags"      attr.type="string"/>',
  '<key id="sources"   for="node" attr.name="sources"   attr.type="string"/>',
  '<key id="createdAt" for="node" attr.name="createdAt" attr.type="string"/>',
  '<key id="updatedAt" for="node" attr.name="updatedAt" attr.type="string"/>',
].join("\n  ");

/**
 * One `<data>` element, or nothing when the page declares no value.
 *
 * GraphML treats an absent `<data>` as "this node does not carry that
 * attribute", which is exactly what an undeclared timestamp means. An empty
 * element would instead assert the attribute IS the empty string — a value a
 * consumer parsing dates has to special-case.
 */
function optionalData(key: string, value: string | undefined): string[] {
  return value ? [`    <data key="${key}">${escapeXml(value)}</data>`] : [];
}

/**
 * Serialise one ExportPage as a GraphML <node> element.
 *
 * The node id is the QUALIFIED page id (`concepts/retrieval`), not the bare slug: a
 * page is `(page_directory, slug)` (`packages/wiki/src/dimensions/wiki/schema.sql:106`),
 * so two pages in different directories may share a stem and a bare-slug id would
 * make the document declare the same node twice.
 */
function pageToNode(page: ExportPage): string {
  const tags = page.tags.join(", ");
  const sources = page.sources.join(", ");
  return [
    `  <node id="${escapeXml(exportPageId(page))}">`,
    `    <data key="title">${escapeXml(page.title)}</data>`,
    `    <data key="summary">${escapeXml(page.summary)}</data>`,
    `    <data key="tags">${escapeXml(tags)}</data>`,
    `    <data key="sources">${escapeXml(sources)}</data>`,
    ...optionalData("createdAt", page.createdAt),
    ...optionalData("updatedAt", page.updatedAt),
    `  </node>`,
  ].join("\n");
}

/**
 * Build all <edge> elements for a single source page's outgoing links.
 *
 * The targets are resolved to PAGES first ({@link resolveExportPageLinks}) and only
 * then rendered as ids, because a link target is a page reference: comparing it to a
 * set of bare slugs dropped every `[[concepts/y]]` edge silently.
 */
function pageToEdges(page: ExportPage, linkIndex: ExportLinkIndex): string[] {
  return resolveExportPageLinks(linkIndex, page).map(
    (target) =>
      `  <edge source="${escapeXml(exportPageId(page))}" target="${escapeXml(exportPageId(target))}"/>`,
  );
}

/**
 * Build the GraphML document from a list of export pages.
 * Only edges whose target resolves to a page in the export are included so the
 * graph contains no dangling references.
 * @param pages - Sorted array of export pages.
 * @returns GraphML XML string.
 */
export function buildGraphml(pages: ExportPage[]): string {
  const linkIndex = buildExportLinkIndex(pages);
  const nodes = pages.map(pageToNode).join("\n");
  const edges = pages.flatMap((p) => pageToEdges(p, linkIndex)).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/graphml"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://graphml.graphdrawing.org/graphml',
    '           http://graphml.graphdrawing.org/graphml/1.0/graphml.xsd">',
    `  ${KEY_DEFS}`,
    '  <graph id="wiki" edgedefault="directed">',
    nodes,
    edges,
    "  </graph>",
    "</graphml>",
    "",
  ].join("\n");
}
