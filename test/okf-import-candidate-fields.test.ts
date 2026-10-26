/**
 * @file test/okf-import-candidate-fields.test.ts
 * @description A candidate keeps its OKF routing fields through the store.
 *
 * This used to parse `.llmwiki/candidates/<id>.json` with `readFile` to check the
 * persisted fields. The queue is rows now, so the same question is asked by reading
 * the candidate back through the API — and the directory's ABSENCE is asserted too,
 * because a store that writes rows while still writing files is the failure this
 * project has hit repeatedly.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { readCandidate, writeCandidate } from "../src/compiler/candidates.js";
import { withStackEnv } from "./fixtures/stack-env.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("ReviewCandidate gains targetDirectory + okfPath", () => {
  it("persists targetDirectory and okfPath from the draft", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-cand-"));

    await withStackEnv("okf-cand", async () => {
      const c = await writeCandidate(dir, {
        title: "Q", slug: "my-query", summary: "s", sources: ["okf:bundle"],
        body: "---\ntitle: Q\n---\n\nbody\n",
        reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
        targetDirectory: "queries", okfPath: "queries/my-query.md",
      });
      expect(c.targetDirectory).toBe("queries");
      expect(c.okfPath).toBe("queries/my-query.md");

      // The same fields survive the round trip through the store.
      const stored = await readCandidate(dir, c.id);
      expect(stored?.targetDirectory).toBe("queries");
      expect(stored?.okfPath).toBe("queries/my-query.md");

      // And nothing landed on disk: the queue is rows.
      const onDisk = await access(path.join(dir, ".llmwiki/candidates"))
        .then(() => true, () => false);
      expect(onDisk).toBe(false);
    });
  });
});
