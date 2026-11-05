/**
 * @file test/ingest/document-fixtures.ts
 * @description Shared helpers for the ingest adapter suites.
 *
 * ## Not a suite
 *
 * The filename carries neither a `.test.` nor a `.spec.` segment, so vitest's
 * default `include` pattern (`*.test.ts` / `*.spec.ts` variants) never collects
 * this module as a suite with zero tests in it. It is imported by the suites that
 * need it, exactly like any other helper.
 *
 * ## Why these two functions live here
 *
 * `fixture` and `settle` were duplicated verbatim in the PDF and DOCX adapter
 * tests, which is the kind of copy that drifts silently: a fix applied to one
 * copy — a narrower sentinel check, a different rejection shape — leaves the
 * other asserting yesterday's behaviour while both suites stay green. They exist
 * once, here, so the adapter tests cannot disagree about how a fixture is found
 * or how a rejection is captured.
 */

import { fileURLToPath } from "node:url";

/**
 * Resolve a document fixture by name.
 *
 * Resolved from `import.meta.url`, never from the working directory: the same
 * suite must find its fixtures whether vitest runs from the repository root or a
 * single file is run from somewhere else.
 *
 * @param name - File name inside `test/fixtures/documents/`.
 * @returns The absolute path to that fixture.
 */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/documents/${name}`, import.meta.url));
}

/** What an ingest attempt produced: the content, or the rejection. */
export interface SettledIngest {
  content: string;
  error?: Error;
}

/**
 * Await an ingest attempt and return whichever it produced.
 *
 * Turning "did it throw" into data keeps each test free of try/catch blocks and
 * lets one assertion pin the content and the message of the same run.
 *
 * @param run - The ingest call to await.
 * @returns The content on success, or `content: ""` plus the error on failure.
 */
export async function settle(run: () => Promise<{ content: string }>): Promise<SettledIngest> {
  try {
    const { content } = await run();
    return { content };
  } catch (error) {
    return { content: "", error: error as Error };
  }
}
