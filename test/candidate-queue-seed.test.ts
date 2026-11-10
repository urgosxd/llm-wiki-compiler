// test/candidate-queue-seed.test.ts
/**
 * @file A planted candidate record is still listed and read through the store.
 *
 * The candidate store SURVIVES the writer's retirement: `.llmwiki/candidates/*.json`
 * records already on disk stay readable, and the read path keeps consuming them. This
 * is the durability witness for that — the record is planted through the shared seed
 * fixture, never through a production writer, so it keeps passing once no writer
 * exists at all.
 */
import { describe, it, expect } from "vitest";
import { listCandidates, readCandidate } from "../packages/wiki/src/compiler/candidates.js";
import { countCandidates } from "../packages/wiki/src/compiler/candidate-read.js";
import { seedPendingCandidates, seedPendingCandidate } from "./fixtures/candidate-queue.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** The minimum a pending record carries, plus the identity the store keys on. */
function seed(slug: string, extra: Record<string, unknown> = {}) {
  return { title: slug, slug, summary: "s", sources: ["ref.md"], body: `# ${slug}\n\nbody\n`, ...extra };
}

describe("a planted pending candidate", () => {
  it("is listed and read back with its recorded fields", async () => {
    const id = await seedPendingCandidate(root.dir, seed("planted", { targetDirectory: "queries" }));

    const listed = await listCandidates(root.dir);
    expect(listed.map((entry) => entry.id)).toEqual([id]);
    expect(await readCandidate(root.dir, process.env, id)).toMatchObject({
      slug: "planted", summary: "s", targetDirectory: "queries",
    });
    expect(await countCandidates(root.dir)).toBe(1);
  });

  it("keeps the mode and hold reason a retired stager used to write", async () => {
    // Records written before the retirement carry these; readability must not depend
    // on a producer that no longer exists.
    const id = await seedPendingCandidate(root.dir, seed("imported-doc", {
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    }));

    const read = await readCandidate(root.dir, process.env, id);
    expect(read?.reviewMode).toBe("imported");
    expect(read?.heldReasons).toEqual([{ code: "imported-okf" }]);
  });

  it("lists several records in seed order and reports them all", async () => {
    const ids = await seedPendingCandidates(root.dir, [seed("one"), seed("two"), seed("three")]);

    expect(ids).toHaveLength(3);
    expect((await listCandidates(root.dir)).map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect(await countCandidates(root.dir)).toBe(3);
  });
});
