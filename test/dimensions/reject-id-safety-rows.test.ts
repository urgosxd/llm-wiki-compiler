/**
 * @file test/dimensions/reject-id-safety-rows.test.ts
 * @description `review reject` must refuse an unsafe id on a Stack, not report absence.
 *
 * A row is addressed by a bound parameter, so a traversal id cannot escape a path the
 * way the file backend can. That is a reason the id is harmless, NOT a reason to skip
 * validating it: the file path answers `../outside` with a typed `UnsafeCandidateIdError`,
 * while a "Candidate not found" message would report a bad caller as a missing record.
 *
 * Found by probe: with a Stack, `review reject ../outside` resolved silently and printed
 * "not found" instead of throwing. It removed nothing, so nothing was ever corrupted --
 * only the diagnosis was wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import reviewRejectCommand from "../../src/commands/review-reject.js";
import { listCandidates, writeCandidate } from "../../src/compiler/candidates.js";
import { withStackEnv } from "../fixtures/stack-env.js";

const REPO_ROOT = process.cwd();
let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "reject-id-"));
  process.chdir(projectDir);
  process.exitCode = 0;
});

afterEach(async () => {
  process.chdir(REPO_ROOT);
  process.exitCode = 0;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

describe("reject refuses unsafe ids on rows", () => {
  it("throws the typed error for a traversal id", async () => {
    await withStackEnv("reject-traversal", async () => {
      await expect(reviewRejectCommand("../outside")).rejects.toMatchObject({
        name: "UnsafeCandidateIdError",
      });
    });
  });

  it("leaves the queue untouched when the id is unsafe", async () => {
    await withStackEnv("reject-untouched", async () => {
      const kept = await writeCandidate(projectDir, {
        title: "Keep", slug: "keep-me", summary: "", sources: [], body: "# Keep\n",
      } as never);

      await expect(reviewRejectCommand("../outside")).rejects.toThrow();
      expect((await listCandidates(projectDir)).map((c) => c.id)).toEqual([kept.id]);
    });
  });

  it("still reports a genuinely missing id as absence", async () => {
    await withStackEnv("reject-missing", async () => {
      // A SAFE but absent id must not be confused with an unsafe one.
      await reviewRejectCommand("no-such-candidate-abc123");

      expect(process.exitCode).toBe(1);
    });
  });
});
