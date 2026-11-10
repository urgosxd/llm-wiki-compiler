/**
 * @file test/fixtures/project-seeding.ts
 * @description Seed a project's structural files without running a pipeline.
 *
 * `llmwiki next` classifies a project by counting files and reading one cache
 * file, so its tests need sources, pages and a pending candidate to exist —
 * never a real compile. Two suites wrote that seeding inline and fallow flagged
 * the copy, which is the same defect class the repository keeps paying for: the
 * second copy is free to drift, and a `seedCandidate` that stops matching the
 * candidate contract turns a classification test into a test of nothing.
 *
 * Kept deliberately free of any import that spawns or provisions: a suite that
 * seeds a directory is a UNIT test, and pulling a process fixture in here would
 * silently move it into the integration tier.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CANDIDATES_DIR } from "../../packages/wiki/src/utils/constants.js";

/** Default body of a structural stub, so callers do not repeat inert prose. */
const STUB_BODY = "# stub";

/**
 * Write a markdown stub into `dir`, creating parents as needed.
 *
 * @param dir - Directory the file belongs in (absolute, e.g. `<root>/sources`).
 * @param name - Filename including its extension.
 * @param body - File content; the default is inert so only the FILE's existence
 *   drives a count.
 */
export async function touchMarkdown(dir: string, name: string, body = STUB_BODY): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body, "utf-8");
}

/**
 * Write one parseable pending candidate, so the review queue is non-empty.
 *
 * The body carries every field the candidate reader requires; a partial record
 * is skipped by the reader (it is race-tolerant by design), which would make a
 * queue-count assertion pass for the wrong reason.
 *
 * @param root - Project root; the candidate goes to `<root>/.llmwiki/candidates/`.
 * @param id - Candidate id, also the filename stem.
 */
export async function seedPendingCandidate(root: string, id: string): Promise<void> {
  const dir = path.join(root, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const body = {
    id,
    title: "Stub",
    slug: id,
    summary: "stub",
    sources: ["x.md"],
    body: "stub",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(body), "utf-8");
}
