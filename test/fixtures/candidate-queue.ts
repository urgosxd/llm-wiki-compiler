/**
 * @file test/fixtures/candidate-queue.ts
 * @description Shared exact-byte snapshot helpers and a bulk seeder for candidate
 * queue tests.
 *
 * The seeder writes the exact record the candidate writer persists for a fresh
 * generic candidate. Queue-SIZE tests use it instead of `writeCandidate` because
 * that writer re-lists the whole queue on every write to canonicalise duplicates,
 * which is O(n²) at the sizes those tests are about — and it would drown the reads
 * they measure. Distinct slugs mean there is nothing to canonicalise; the tests
 * that pin the writer's own bytes use the writer.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CANDIDATES_DIR } from "../../packages/wiki/src/utils/constants.js";

/** One pending generic candidate, in the fields a draft supplies. */
export interface PendingCandidateSeed {
  title: string;
  slug: string;
  summary: string;
  sources: string[];
  body: string;
}

/** Return pending candidate JSON bytes keyed by physical filename. */
export async function snapshotCandidateQueue(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, CANDIDATES_DIR);
  if (!existsSync(dir)) return {};
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const entries = await Promise.all(names.map(async (name) => [
    name,
    (await readFile(path.join(dir, name))).toString("base64"),
  ] as const));
  return Object.fromEntries(entries);
}

/**
 * Seed pending candidate records in bulk and return their ids, in seed order.
 *
 * @param root - Project root directory.
 * @param seeds - The drafts to persist, one record each.
 * @returns The file id of every seeded candidate.
 */
export async function seedPendingCandidates(
  root: string,
  seeds: readonly PendingCandidateSeed[],
): Promise<string[]> {
  const dir = path.join(root, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const ids = seeds.map((seed, index) => `${seed.slug}-${index.toString(16).padStart(8, "0")}`);
  await Promise.all(seeds.map(async (seed, index) => {
    const record = {
      id: ids[index],
      ...seed,
      generatedAt: `2026-01-01T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      reviewMode: "forced",
      heldReasons: [{ code: "manual-review-requested" }],
    };
    await writeFile(path.join(dir, `${ids[index]}.json`), JSON.stringify(record, null, 2));
  }));
  return ids;
}
