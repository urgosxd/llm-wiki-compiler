/**
 * @file test/viewer-shell-stack-query.test.ts
 * @description The bundled shell hands the page's own query string to `/api/pages`.
 *
 * ## Why the shell has to do it
 *
 * `/api/pages` reads the Stack a request NAMES (`?stackId=`), and the shell is what asks
 * it. Without this the operator's URL and the shell's own fetch disagree: an operator who
 * opens `http://host/?stackId=<id>` would still be served the boot snapshot, which is the
 * "I created a Stack and the viewer shows nothing" symptom this branch exists to end.
 *
 * ## What is deliberately NOT here
 *
 * A selector, an ambient default, or any synthesised value: the shell passes through what
 * the page was opened with and nothing else. A page opened with no query must ask for the
 * bare endpoint exactly as before, because that request is what keeps a database-backed
 * deployment's dashboard loading.
 *
 * These cases observe the request URL the shell really built, through the fetch spy the
 * jsdom harness already returns — no server, no network.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_DEMO_ENVELOPE, jsonResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

/** A well-formed Stack id, so a truncation or a re-encoding would be visible. */
const STACK_ID = "3f7c9a52-0b1e-4c7d-9a1b-0c2d3e4f5a6b";

/** Serve both bootstrap endpoints, whatever query string the shell appends to them. */
function bootstrapFor(url: string): Response | null {
  if (url.startsWith("/api/pages")) return jsonResponse(EMPTY_DEMO_ENVELOPE);
  if (url.startsWith("/api/health")) return jsonResponse({ lint: null });
  return null;
}

/** Every URL the shell asked for during one mount, in call order. */
function requestedUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/**
 * The DISTINCT envelope URLs one mount asked for.
 *
 * Distinct rather than in order because the shell legitimately asks twice — once before the
 * bootstrap settles and once after (`viewer.js` routes a pre-settle render through the same
 * `loadBootstrapData`) — and the count is not this file's contract. What is: every one of those
 * requests carries the same query.
 */
function pagesUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return [...new Set(requestedUrls(fetchMock).filter((url) => url.startsWith("/api/pages")))];
}

describe("the shell's /api/pages request", () => {
  it("carries the stackId the page was opened with", async () => {
    const { fetchMock } = await mountViewerDom(bootstrapFor, `?stackId=${STACK_ID}`);
    expect(pagesUrls(fetchMock), "the page's own query must reach every envelope request").toEqual([
      `/api/pages?stackId=${STACK_ID}`,
    ]);
  });

  it("asks for the bare endpoint when the page was opened with no query", async () => {
    const { fetchMock } = await mountViewerDom(bootstrapFor);
    expect(pagesUrls(fetchMock), "no query in, no query out: a synthesised default would break this").toEqual([
      "/api/pages",
    ]);
  });
});
