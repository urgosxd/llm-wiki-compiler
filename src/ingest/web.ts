/**
 * Web URL ingestion module.
 * Fetches a URL, extracts readable content using Mozilla Readability,
 * and converts the result to clean markdown via Turndown.
 *
 * Throws descriptive errors on network failures or when the page
 * cannot be parsed into readable content.
 */

import { JSDOM } from "jsdom";
import { extname } from "node:path";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

interface WebIngestResult {
  title: string;
  content: string;
}

/** Fetch a URL and return its readable content as markdown. */
async function fetchAndParse(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response;
}

/**
 * The filename a URL's path ends with, as a human-readable title.
 *
 * A capability URL carries the real filename in its path by construction, so a
 * document served this way has a title available even when the response has no HTML
 * `<title>` to extract -- which is every `.md`, `.txt`, `.pdf` and `.vtt` fetched this
 * way. Without it those sources were all titled "Untitled", and a wiki page called
 * "Untitled" cannot be found by a question about what the document is about.
 *
 * Query and fragment are stripped first: `paper.pdf?token=x` otherwise yields
 * `extname === ".pdf?token=x"`, so the stem would keep the whole query string.
 *
 * @param url - The URL the content came from.
 * @returns The cleaned filename stem, or `undefined` when the path has no name.
 */
export function titleFromUrlPathForTest(url: string): string | undefined {
  return titleFromUrlPath(url);
}

function titleFromUrlPath(url: string): string | undefined {
  // `new URL` rather than string slicing: on `https://example.com/` the pathname is
  // `/`, while slicing the whole string hands back `example.com` and `extname` then
  // reads `.com` as a filename extension.
  const pathname = safePathname(url);
  const pathOnly = pathname.replace(/\/+$/, "");
  const basename = pathOnly.slice(pathOnly.lastIndexOf("/") + 1);
  if (basename === "") return undefined;
  // Strip a known extension when there is one; a bare segment like `/article` is
  // already the name and must not be discarded for lacking one. Only a name that
  // IS an extension (a path ending in `/.md`) yields nothing.
  const ext = extname(basename);
  const stem = (ext === "" ? basename : basename.slice(0, -ext.length))
    .replace(/[-_]+/g, " ")
    .trim();
  return stem === "" ? undefined : stem;
}

/** The pathname of a URL, or `""` when the string is not parseable as one. */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** Extract readable content from raw HTML using Readability. */
function extractReadableContent(html: string, url: string): { title: string; htmlContent: string } {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error(`Could not extract readable content from ${url}`);
  }

  // The URL's filename is preferred over "Untitled" but never over a real HTML
  // title: a page that names itself is more informative than its path segment.
  return {
    title: article.title || titleFromUrlPath(url) || "Untitled",
    htmlContent: article.content,
  };
}

/** Convert HTML to clean markdown using Turndown. */
function convertToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx" });
  return turndown.turndown(html);
}

/**
 * Ingest a web URL and return its content as markdown.
 * @param url - The URL to fetch and convert.
 * @returns An object with the extracted title and markdown content.
 * @throws On network failure or unparseable content.
 */
export default async function ingestWeb(url: string): Promise<WebIngestResult> {
  const response = await fetchAndParse(url);
  const html = await response.text();
  const { title, htmlContent } = extractReadableContent(html, url);
  const content = convertToMarkdown(htmlContent);

  return { title, content };
}
