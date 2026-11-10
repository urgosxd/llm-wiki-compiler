/**
 * @file test/candidate-identity-binding.test.ts
 * @description Mutation-authority tests for pending candidate filename and
 * embedded-record identity binding. A record assertion must never redirect a
 * mutation away from its store-owned filename locator.
 *
 * The mutation entry point is `deleteCandidateBySlug`: it is the surviving consumer
 * of the selection authority, so the refusals are pinned there. The two
 * canonicalisation cases went with `writeCandidate` — nothing reconciles duplicate
 * files any more, because nothing writes one.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CandidateIdentityMismatchError,
  UnsafeCandidateIdError,
  deleteCandidateBySlug,
} from "../packages/wiki/src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../packages/wiki/src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const TARGET_SLUG = "target-topic";
const UNRELATED_SLUG = "unrelated-topic";
const TARGET_BODY = "---\ntitle: Target\n---\n\nLatest target body.\n";
const ERROR_MESSAGE_LIMIT = 512;

interface PlantedCandidate {
  readonly fileId: string;
  readonly recordId?: string;
  readonly slug?: string;
  readonly generatedAt?: string;
}

/** Build the target record used for every mutation attempt. */
function targetDraft() {
  return {
    title: "Target",
    slug: TARGET_SLUG,
    summary: "",
    sources: [],
    body: TARGET_BODY,
  };
}

/** Plant a complete candidate with independently controlled file and record IDs. */
async function plantCandidate(options: PlantedCandidate): Promise<void> {
  const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(candidatesDir, { recursive: true });
  const record = {
    ...targetDraft(),
    id: options.recordId ?? options.fileId,
    slug: options.slug ?? TARGET_SLUG,
    generatedAt: options.generatedAt ?? "2026-01-01T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  };
  await writeFile(path.join(candidatesDir, `${options.fileId}.json`), JSON.stringify(record));
}

/** Snapshot every regular pending-queue file as exact base64 bytes. */
async function snapshotQueueFiles(): Promise<Record<string, string>> {
  const candidatesDir = path.join(root.dir, CANDIDATES_DIR);
  if (!existsSync(candidatesDir)) return {};
  const entries = await readdir(candidatesDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const snapshots: Record<string, string> = {};
  for (const name of names) {
    snapshots[name] = (await readFile(path.join(candidatesDir, name))).toString("base64");
  }
  return snapshots;
}

/** Assert typed bounded refusal and exact queue-byte preservation. */
async function expectMismatchRefusal(
  expectedType: typeof CandidateIdentityMismatchError | typeof UnsafeCandidateIdError =
    CandidateIdentityMismatchError,
): Promise<Error> {
  const before = await snapshotQueueFiles();
  let caught: unknown;
  try {
    await deleteCandidateBySlug(root.dir, process.env, TARGET_SLUG);
  } catch (error) {
    caught = error;
  }
  expect(await snapshotQueueFiles()).toEqual(before);
  expect(caught).toBeInstanceOf(expectedType);
  expect((caught as Error).message.length).toBeLessThanOrEqual(ERROR_MESSAGE_LIMIT);
  return caught as Error;
}

describe("candidate mutation identity binding", () => {
  it("refuses a canonical mismatch naming an unrelated candidate file", async () => {
    await plantCandidate({ fileId: "mismatch", recordId: "unrelated-file" });
    await plantCandidate({ fileId: "unrelated-file", slug: UNRELATED_SLUG });

    await expectMismatchRefusal();
  });

  it("refuses an extra mismatch naming an unrelated candidate file", async () => {
    await plantCandidate({ fileId: "canonical" });
    await plantCandidate({
      fileId: "mismatch", recordId: "unrelated-file", generatedAt: "2026-01-02T00:00:00.000Z",
    });
    await plantCandidate({ fileId: "unrelated-file", slug: UNRELATED_SLUG });

    await expectMismatchRefusal();
  });

  it("refuses an extra mismatch naming the valid canonical file", async () => {
    await plantCandidate({ fileId: "canonical" });
    await plantCandidate({
      fileId: "mismatch", recordId: "canonical", generatedAt: "2026-01-02T00:00:00.000Z",
    });

    await expectMismatchRefusal();
  });

  it("refuses a mismatch mixed with otherwise valid duplicates", async () => {
    await plantCandidate({ fileId: "canonical" });
    await plantCandidate({ fileId: "valid-extra", generatedAt: "2026-01-02T00:00:00.000Z" });
    await plantCandidate({
      fileId: "mismatch", recordId: "absent-record", generatedAt: "2026-01-03T00:00:00.000Z",
    });

    await expectMismatchRefusal();
  });

  it("classifies an oversized embedded id before ordinary mismatch comparison", async () => {
    await plantCandidate({ fileId: "mismatch", recordId: "\u0000".repeat(10_000) });

    await expectMismatchRefusal(UnsafeCandidateIdError);
  });
});
