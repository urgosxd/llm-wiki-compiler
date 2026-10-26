/**
 * @file test/dimensions/eval-queue-wired.test.ts
 * @description The evaluator sees a Stack-backed candidate queue.
 *
 * `evaluateCandidates` walked `.llmwiki/candidates` to inventory the queue. On a
 * Stack-backed project that directory does not exist, so the walk answered "no
 * candidates" and every evaluation reported an empty queue -- including when
 * candidates were genuinely pending. Nothing failed; the report was just empty.
 */

import { describe, expect, it } from "vitest";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { evaluateCandidates } from "../../src/eval/candidates.js";
import { withStackEnv } from "./../fixtures/stack-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("eval sees the Stack queue", () => {
  it("counts a pending candidate written to rows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ev-"));
    try {
      await withStackEnv("ev", async () => {
        await writeCandidate(dir, {
          title: "Pending", slug: "same", summary: "D", sources: ["s.md"],
          body: "---\ntitle: P\n---\n\nbody\n",
        } as never);
        const report = await evaluateCandidates(dir, "fast");
        expect(report.skippedCandidates.length + report.candidates.length).toBe(1);
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
