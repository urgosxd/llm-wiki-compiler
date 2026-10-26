import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { withStackEnv } from "../fixtures/stack-env.js";

describe("slug validation on a Stack-backed project", () => {
  it("refuses a traversal slug before touching the store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "slug-"));
    try {
      await withStackEnv("slug", async () => {
        await expect(writeCandidate(dir, {
          title: "T", slug: "../../escape", summary: "s", sources: ["s.md"], body: "b",
        } as never)).rejects.toThrow();
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
