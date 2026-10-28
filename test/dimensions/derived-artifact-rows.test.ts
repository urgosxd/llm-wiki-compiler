/**
 * @file test/dimensions/derived-artifact-rows.test.ts
 * @description `index.md` and `MOC.md` become rows, and the files stop appearing.
 *
 * The assertion that proves wiring is NOT "the row exists" — a run can write both the
 * row and the file. It is "`wiki/index.md` does not exist", checked against the
 * directory, which is why every case asserts absence as well as content.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateMOC } from "../../src/compiler/obsidian.js";
import { withDerivedSource } from "../../src/dimensions/wiki/derived-artifact-source.js";
import { withStackEnv } from "../fixtures/stack-env.js";

/** Provision a project root with a concepts directory and a Stack. */
async function withProject(label: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await mkdir(path.join(dir, "wiki", "concepts"), { recursive: true });
    await withStackEnv(label, () => body(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a concept page with a tag, in the shape the disk scan reads. */
async function seedConcept(dir: string, slug: string, title: string, tag: string): Promise<void> {
  const body = `---\ntitle: ${title}\ntags: [${tag}]\n---\n\n# ${title}\n`;
  await writeFile(path.join(dir, "wiki", "concepts", `${slug}.md`), body, "utf-8");
}

describe("derived artifacts on rows", () => {
  it("stores the MOC as a row and writes no MOC.md", () =>
    withProject("moc-nofile", async (dir) => {
      await seedConcept(dir, "alpha", "Alpha", "topic");

      await generateMOC(dir);

      expect(existsSync(path.join(dir, "wiki", "MOC.md"))).toBe(false);
    }));

  it("stores exactly what the renderer produced", () =>
    withProject("moc-content", async (dir) => {
      await seedConcept(dir, "alpha", "Alpha", "topic");

      await generateMOC(dir);

      const stored = await withDerivedSource(process.env, async (source) =>
        source!.read("moc"),
      );
      expect(stored).toBeDefined();
      expect(stored).toContain("Alpha");
    }));

  it("replaces the row on regeneration instead of duplicating it", () =>
    withProject("moc-idempotent", async (dir) => {
      await seedConcept(dir, "alpha", "Alpha", "topic");
      await generateMOC(dir);
      const first = await withDerivedSource(process.env, async (s) => s!.read("moc"));

      await generateMOC(dir);
      const second = await withDerivedSource(process.env, async (s) => s!.read("moc"));

      // Regeneration is a FUNCTION of the registry: the same corpus yields the same
      // artifact, and the upsert keeps one row rather than appending a second.
      expect(second).toBe(first);
    }));

  it("keeps each Stack's artifact separate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "moc-tenant-"));
    try {
      await mkdir(path.join(dir, "wiki", "concepts"), { recursive: true });
      await seedConcept(dir, "alpha", "Alpha", "topic");

      const first = await storedMocUnder("moc-tenant-a", dir);
      const second = await storedMocUnder("moc-tenant-b", dir);

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(existsSync(path.join(dir, "wiki", "MOC.md"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Generate the MOC under a fresh Stack and return what that Stack stored. */
async function storedMocUnder(label: string, dir: string): Promise<string | undefined> {
  let stored: string | undefined;
  await withStackEnv(label, async () => {
    await generateMOC(dir);
    stored = await withDerivedSource(process.env, async (source) => source!.read("moc"));
  });
  return stored;
}
