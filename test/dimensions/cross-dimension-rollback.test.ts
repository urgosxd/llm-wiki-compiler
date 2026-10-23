/**
 * @file test/dimensions/cross-dimension-rollback.test.ts
 * @description The transaction the dimension layer exists for: a failure in one
 * dimension must leave the other one unwritten.
 *
 * WHY THIS FILE EXISTS. `coordinator.test.ts` proves the ordering and
 * compensation protocol using a mock dimension on BOTH sides. That verifies the
 * coordinator's bookkeeping but never proves that the real wiki dimension
 * actually leaves the filesystem untouched when a later dimension fails — the
 * property a user depends on when they enable the graph.
 *
 * So this suite pairs the REAL `createWikiDimension` with a stub second
 * dimension whose `commit` throws, and then looks at the filesystem. It asserts
 * the outcome a reader can check by hand: no file under `sources/`.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestDimensions } from "../../src/dimensions/coordinator.js";
import { createWikiDimension } from "../../src/dimensions/wiki/index.js";
import type { Dimension } from "../../src/dimensions/types.js";

/** One document, as an ingest would hand it to the coordinator. */
const INPUT = { source: "https://example.test/a", title: "A", document: "# A\nbody", body: "body" };

/** A fresh project root that `createWikiDimension` can write into. */
async function projectRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "dim-rollback-")));
}

/**
 * A second dimension that prepares cleanly and then fails at commit.
 *
 * `commit` is where the coordinator can no longer undo on its own, which is the
 * only interesting failure position: a `prepare` failure happens before anything
 * is committed and proves less.
 */
function explodingDimension(): Dimension {
  return {
    name: "kg",
    prepare: async () => ({ unchanged: false, handle: {} }),
    commit: async () => {
      throw new Error("kg commit exploded");
    },
    discard: async () => {},
  };
}

describe("cross-dimension rollback", () => {
  it("leaves no wiki file behind when a later dimension fails to commit", async () => {
    const root = await projectRoot();

    await expect(
      ingestDimensions(root, INPUT, [createWikiDimension(root), explodingDimension()]),
    ).rejects.toThrow("kg commit exploded");

    await expect(readdir(path.join(root, "sources"))).resolves.toEqual([]);
  });
});
