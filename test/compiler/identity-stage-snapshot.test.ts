/**
 * @file test/compiler/identity-stage-snapshot.test.ts
 * @description The identity stage needs more than page slugs: it needs each
 * existing page's canonical name and the aliases that page already answers to
 * (S6). This pins the snapshot loader that supplies them.
 *
 * The loader is the only I/O in the identity path, and it must stay confined:
 * a page that cannot be read contributes nothing rather than aborting a compile.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { snapshotIncumbentConcepts } from "../../src/compiler/identity-stage.js";
import { makeTempRoot } from "../fixtures/temp-root.js";

/** Write one raw page file under a temp root's concepts directory. */
async function writePage(root: string, dir: string, slug: string, content: string): Promise<void> {
  const target = path.join(root, dir);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, `${slug}.md`), content, "utf-8");
}

/** A concept page carrying a title and the given raw aliases block. */
function pageWith(title: string, aliases?: string): string {
  const lines = ["---", `title: ${title}`, "summary: Existing.", "sources:", "  - a.md", "kind: concept"];
  if (aliases !== undefined) lines.push(`aliases: ${aliases}`);
  lines.push("createdAt: 2026-01-01T00:00:00.000Z", "updatedAt: 2026-01-01T00:00:00.000Z", "---", "", "Body.");
  return lines.join("\n");
}

describe("snapshotIncumbentConcepts", () => {
  it("carries each concept page's canonical name and declared aliases", async () => {
    const root = await makeTempRoot("identity-snapshot");
    await writePage(root, "wiki/concepts", "vector-db", pageWith("Vector Database", '\n  - pgvector store'));
    const snapshot = await snapshotIncumbentConcepts(root);
    expect(snapshot.get("vector-db")).toEqual({
      canonicalName: "Vector Database",
      aliases: ["pgvector store"],
    });
    await rm(root, { recursive: true, force: true });
  });

  it("falls back to the slug as the canonical name and to no aliases", async () => {
    const root = await makeTempRoot("identity-snapshot-bare");
    await writePage(root, "wiki/concepts", "baking-bread", pageWith("Baking Bread"));
    const snapshot = await snapshotIncumbentConcepts(root);
    expect(snapshot.get("baking-bread")).toEqual({
      canonicalName: "Baking Bread",
      aliases: [],
    });
    await rm(root, { recursive: true, force: true });
  });

  it("ignores query pages, which are not concept incumbents", async () => {
    const root = await makeTempRoot("identity-snapshot-queries");
    await writePage(root, "wiki/queries", "how-to-bake", pageWith("How To Bake"));
    expect((await snapshotIncumbentConcepts(root)).size).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it("drops malformed alias entries instead of trusting them", async () => {
    const root = await makeTempRoot("identity-snapshot-malformed");
    await writePage(root, "wiki/concepts", "vector-db", pageWith("Vector Database", " 42"));
    const snapshot = await snapshotIncumbentConcepts(root);
    expect(snapshot.get("vector-db")?.aliases).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("yields an empty snapshot for a project with no concept pages yet", async () => {
    const root = await makeTempRoot("identity-snapshot-empty");
    expect((await snapshotIncumbentConcepts(root)).size).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
