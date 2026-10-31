/**
 * @file test/ingest/url-source-title.test.ts
 * @description A document fetched over HTTP keeps the name its URL carries.
 *
 * ## The defect
 *
 * `ingestWeb` titled every source from the page's HTML `<title>`, falling back to the
 * literal string "Untitled". That is correct for an article and wrong for every
 * document served as a file: a `.md`, `.txt`, `.pdf` or `.vtt` fetched over HTTP has no
 * `<title>` to extract, so all of them arrived named "Untitled".
 *
 * The content was never lost -- a measured 20551-byte document arrived intact and
 * compiled -- but a wiki page called "Untitled" cannot be found by a question about what
 * the document says. The assistant answered "nothing here" about a document that was
 * fully present, and that answer was correct for the page it had been given.
 *
 * ## Why the URL and not the response
 *
 * A capability URL carries the real filename in its path BY CONSTRUCTION -- the seam
 * encodes it there precisely so the extension survives the round trip. So the name is
 * available before the response body is even read, and no server header has to
 * cooperate.
 *
 * ## What must not regress
 *
 * A page that names itself is more informative than its path segment. The URL filename
 * is the fallback for a MISSING title, never a replacement for a real one.
 */
import { describe, it, expect } from "vitest";
import { titleFromUrlPathForTest } from "../../src/ingest/web.js";

describe("title from a URL path", () => {
  it.each([
    ["http://192.168.32.3:8080/documents/e6d20161/Ab3u/test.md", "test"],
    ["http://h/docs/SGE-paper_v2.pdf?token=x", "SGE paper v2"],
    ["http://h/docs/talk.vtt#t=10", "talk"],
    ["https://example.com/article", "article"],
    ["http://h/docs/dashboard.html", "dashboard"],
  ])("names %s as %s", (url, expected) => {
    expect(titleFromUrlPathForTest(url)).toBe(expected);
  });

  it.each(["https://example.com/", "https://example.com", "https://example.com/?q=1"])(
    "borrows no name from %s",
    (url) => {
      // A host is not a filename. Slicing the string instead of parsing it made
      // `example.com` look like a stem with a `.com` extension, so the check has to
      // be on the PATHNAME.
      expect(titleFromUrlPathForTest(url)).toBeUndefined();
    },
  );

  it("strips the query before reading the extension", () => {
    // `paper.pdf?token=x` yields `extname === ".pdf?token=x"`, which would leave the
    // query glued onto the stem.
    expect(titleFromUrlPathForTest("http://h/a/paper.pdf?token=x")).toBe("paper");
  });
});
