/**
 * @file test/candidate-identity-limits.test.ts
 * @description Candidate filename limits preserve atomic-write headroom and
 * reject oversized slugs or legacy identifiers before store mutation.
 *
 * `deleteCandidateBySlug` is the surviving mutation entry point, so the slug ceiling
 * is pinned there. The writer-side cases — the draft that mints an id, and the atomic
 * replacement of a legacy record — went with `writeCandidate`: nothing mints a
 * candidate identity any more.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsafeCandidateIdError,
  deleteCandidateBySlug,
  readCandidate,
  archiveCandidate,
} from "../packages/wiki/src/compiler/candidates.js";
import {
  archivePath,
  candidatePath,
  MAX_CANDIDATE_ID_BYTES,
  MAX_CANDIDATE_SLUG_BYTES,
  MAX_WRITABLE_CANDIDATE_ID_BYTES,
} from "../packages/wiki/src/compiler/candidate-paths.js";
import { CANDIDATES_DIR } from "../packages/wiki/src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const ATOMIC_TEMP_SUFFIX = `.${"a".repeat(16)}.tmp`;
const SECRET_SENTINEL = "SAFE_ASCII_LIMIT_SENTINEL";

/** Build the smallest complete candidate record body for one physical slug. */
function draftFor(slug: string) {
  return {
    title: "Candidate limit fixture",
    slug,
    summary: "",
    sources: [],
    body: "---\ntitle: Candidate limit fixture\n---\nBody\n",
  };
}

/** Plant one target-matching legacy record under an independently sized ID. */
async function plantLegacyCandidate(id: string): Promise<void> {
  const dir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const candidate = {
    ...draftFor("legacy-over-cap"),
    id,
    generatedAt: "2026-01-01T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(candidate));
}

/** Assert a slug refusal is typed and creates no candidate-store directory. */
async function expectSlugRefusal(slug: string): Promise<void> {
  await expect(deleteCandidateBySlug(root.dir, process.env, slug)).rejects.toBeInstanceOf(
    UnsafeCandidateIdError,
  );
  expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
}

describe("candidate physical identity ceilings", () => {
  it("derives the 229-byte id ceiling from the complete atomic component", () => {
    const extensionBytes = Buffer.byteLength(".json", "utf8");
    const tempSuffixBytes = Buffer.byteLength(ATOMIC_TEMP_SUFFIX, "utf8");

    expect(MAX_WRITABLE_CANDIDATE_ID_BYTES + extensionBytes + tempSuffixBytes).toBe(255);
    expect(MAX_CANDIDATE_SLUG_BYTES + 1 + 8).toBe(MAX_WRITABLE_CANDIDATE_ID_BYTES);
    expect(MAX_CANDIDATE_ID_BYTES + extensionBytes).toBe(255);
  });

  it("rejects a 221-byte ASCII slug before store access", async () => {
    await expectSlugRefusal("a".repeat(221));
  });

  it("rejects a slug one byte past the multibyte boundary", async () => {
    await expectSlugRefusal(`${"é".repeat(110)}a`);
  });

  it.each([228, 229, 230, 250])("accepts a direct %i-byte candidate id", async (bytes) => {
    const id = "a".repeat(bytes);

    await expect(candidatePath(root.dir, id)).resolves.toContain(`${id}.json`);
    await expect(archivePath(root.dir, id)).resolves.toContain(`${id}.json`);
  });

  it("rejects a physically impossible 251-byte candidate id before path resolution", async () => {
    const id = "a".repeat(251);

    await expect(candidatePath(root.dir, id)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    await expect(archivePath(root.dir, id)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
  });

  it("accepts and rejects exact multibyte id boundaries", async () => {
    const accepted = "é".repeat(125);
    const rejected = `${accepted}a`;

    await expect(candidatePath(root.dir, accepted)).resolves.toContain(`${accepted}.json`);
    await expect(candidatePath(root.dir, rejected)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
  });

  it("rejects a huge safe-ASCII slug without reflecting or creating the store", async () => {
    const slug = `${"a".repeat(10_000)}${SECRET_SENTINEL}`;
    let caught: unknown;

    try { await deleteCandidateBySlug(root.dir, process.env, slug); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(UnsafeCandidateIdError);
    expect((caught as Error).message).not.toContain(SECRET_SENTINEL);
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
  });

  it("reads and archives a valid legacy filename without needing write-temp headroom", async () => {
    const id = "a".repeat(250);
    await plantLegacyCandidate(id);
    expect((await readCandidate(root.dir, process.env, id))?.id).toBe(id);
    expect(await archiveCandidate(root.dir, id)).toBe(true);
    expect(existsSync(await candidatePath(root.dir, id))).toBe(false);
    expect(existsSync(await archivePath(root.dir, id))).toBe(true);
  });
});
