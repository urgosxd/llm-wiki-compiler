/**
 * @file test/fixtures/candidate-queue.ts
 * @description Shared exact-byte snapshot helpers and THE seed helper for candidate
 * queue tests.
 *
 * Every test that needs a pending candidate on disk plants it here. The store's own
 * writers are retired, so this fixture is the only implementation of record
 * construction in the test tree — one shape, so a validator change cannot pass one
 * suite and fail another. It writes the exact record the store reads: the required
 * fields, `generatedAt`, and a `reviewMode`/`heldReasons` pair the validator accepts.
 *
 * Bulk seeding stays bulk because queue-SIZE tests measure reads, not writes:
 * distinct slugs mean there is nothing to canonicalise.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CANDIDATES_DIR } from "../../packages/wiki/src/utils/constants.js";
import type { ReviewCandidate } from "../../packages/wiki/src/utils/types.js";

/** The fields a record must carry, as the type requires them. */
type RequiredSeedFields = Pick<ReviewCandidate, "title" | "slug" | "summary" | "sources" | "body">;

/**
 * One pending candidate to plant: the required fields plus any optional record
 * field — `reviewMode`, `heldReasons`, `targetDirectory`, `okfPath`, `candidateKind`,
 * `citationManifest` and the rest — and optionally the `id`/`generatedAt` identity.
 */
export type PendingCandidateSeed = RequiredSeedFields &
  Partial<Omit<ReviewCandidate, keyof RequiredSeedFields>>;

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
 * The identity a seed is stored under: its own `id` when given, else its slug plus
 * the seed's position, so a repeated slug cannot collide.
 *
 * @param seed - The candidate to plant.
 * @param index - The seed's position in the batch.
 * @returns The record identity.
 */
function seedId(seed: PendingCandidateSeed, index: number): string {
  return seed.id ?? `${seed.slug}-${index.toString(16).padStart(8, "0")}`;
}

/**
 * The timestamp a seed is stored with: its own `generatedAt`, else a fixed base plus
 * the seed's position, so ordering is deterministic and no test depends on a clock.
 *
 * @param seed - The candidate to plant.
 * @param index - The seed's position in the batch.
 * @returns An ISO timestamp.
 */
function seedTimestamp(seed: PendingCandidateSeed, index: number): string {
  const minutes = String(Math.floor(index / 60) % 60).padStart(2, "0");
  const seconds = String(index % 60).padStart(2, "0");
  return seed.generatedAt ?? `2026-01-01T00:${minutes}:${seconds}.000Z`;
}

/**
 * Plant pending candidate records in bulk and return their ids, in seed order.
 *
 * @param root - Project root directory.
 * @param seeds - The records to plant, one file each.
 * @returns The file id of every planted candidate.
 */
export async function seedPendingCandidates(
  root: string,
  seeds: readonly PendingCandidateSeed[],
): Promise<string[]> {
  const dir = path.join(root, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const ids = seeds.map(seedId);
  await Promise.all(seeds.map(async (seed, index) => {
    const record = {
      ...seed,
      id: ids[index],
      generatedAt: seedTimestamp(seed, index),
      reviewMode: seed.reviewMode ?? "forced",
      heldReasons: seed.heldReasons ?? [{ code: "manual-review-requested" }],
    };
    await writeFile(path.join(dir, `${ids[index]}.json`), JSON.stringify(record, null, 2));
  }));
  return ids;
}

/**
 * Plant ONE pending candidate record and return its id.
 *
 * @param root - Project root directory.
 * @param seed - The record to plant.
 * @returns The planted candidate's file id.
 */
export async function seedPendingCandidate(
  root: string,
  seed: PendingCandidateSeed,
): Promise<string> {
  const [id] = await seedPendingCandidates(root, [seed]);
  return id;
}
