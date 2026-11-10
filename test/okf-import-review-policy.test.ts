import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { listCandidates } from "../packages/wiki/src/compiler/candidates.js";
import { seedPendingCandidate } from "./fixtures/candidate-queue.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("imported mode/reason survive candidate sanitization", () => {
  it("keeps reviewMode=imported and code=imported-okf after listCandidates", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-mode-"));
    // The record is planted, not written: the OKF stager that used to produce it is
    // retired, but records it already wrote must still sanitize without losing the
    // mode or the hold reason that explain where they came from.
    await seedPendingCandidate(dir, {
      title: "A", slug: "a", summary: "s", sources: ["okf:b"], body: "---\ntitle: A\n---\n\nx\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    });
    const [c] = await listCandidates(dir);
    expect(c.reviewMode).toBe("imported");
    expect(c.heldReasons[0].code).toBe("imported-okf");
  });
});
