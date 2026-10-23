/**
 * @file test/dimensions/wiki-reader.test.ts
 * @description The `wiki` dimension's READER, through the `DimensionReader` port.
 *
 * WHY THIS SUITE EXISTS AT ALL. It proves the port is genuinely dimension-neutral:
 * the wiki has no edges and no confidence, yet it answers the SAME `read(query)`
 * call the graph answers. If this suite needed a different method, the port would
 * be a graph contract wearing a generic name.
 *
 * The pages are written by hand rather than compiled, because compiling needs a
 * provider and what is under test is the read path, not page generation.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWikiReader } from "../../src/dimensions/wiki/reader.js";
import { expectNamedLookupContract } from "../fixtures/reader-assertions.js";

/** A project with three compiled concept pages and one query page. */
async function projectWithPages(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "wiki-reader-")));
  const concepts = path.join(root, "wiki", "concepts");
  const queries = path.join(root, "wiki", "queries");
  await mkdir(concepts, { recursive: true });
  await mkdir(queries, { recursive: true });

  const page = (title: string, summary: string): string =>
    `---\ntitle: ${title}\nsummary: ${summary}\nsources:\n  - a.md\n---\n\nBody about ${title}.\n`;

  await writeFile(path.join(concepts, "agents.md"), page("Agents", "Autonomous actors"), "utf8");
  await writeFile(path.join(concepts, "tools.md"), page("Tools", "Things agents use"), "utf8");
  await writeFile(path.join(concepts, "goals.md"), page("Goals", "Desired outcomes"), "utf8");
  await writeFile(path.join(queries, "how-do-agents-work.md"), page("How do agents work", "Explainer"), "utf8");
  return root;
}

describe("the wiki dimension as a DimensionReader", () => {
  it("is named wiki, matching its write side", async () => {
    expect(createWikiReader(await projectWithPages()).name).toBe("wiki");
  }, 30_000);

  it("lists compiled pages as entities whose kind is their directory", async () => {
    const reader = createWikiReader(await projectWithPages());
    const result = await reader.read({ limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.entities.map((entity) => entity.name);
    expect(names).toContain("Agents");
    const agents = result.value.entities.find((entity) => entity.name === "Agents");
    // The directory IS the taxonomy: concepts vs queries.
    expect(agents?.kind).toBe("concepts");
    expect(agents?.description).toBe("Autonomous actors");
  }, 30_000);

  it("reports no relationships and no confidence, because the wiki has neither", async () => {
    const reader = createWikiReader(await projectWithPages());
    const result = await reader.read({ limit: 50, depth: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A wikilink is not a typed edge; inventing one would make cross-dimension
    // ranking compare a real confidence against a fabricated one.
    expect(result.value.relationships).toHaveLength(0);
    expect(result.value.entities[0]?.confidence).toBeUndefined();
  }, 30_000);

  it("narrows by kind, which is the page directory", async () => {
    const reader = createWikiReader(await projectWithPages());
    const result = await reader.read({ kinds: ["queries"], limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.map((entity) => entity.name)).toEqual(["How do agents work"]);
  }, 30_000);

  it("finds a page by title and reports not_found as a code", async () => {
    const reader = createWikiReader(await projectWithPages());

    // The same assertion the graph suite uses: one port, one failure contract.
    await expectNamedLookupContract(reader, "agents", "Agents");
  }, 30_000);

  it("answers a listing even when no embedding store exists", async () => {
    const reader = createWikiReader(await projectWithPages());
    // Text search needs vectors a hand-made project lacks; the listing must still
    // work, or a project without embeddings would appear to have no pages.
    const result = await reader.read({ limit: 50, text: "agents" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.length).toBeGreaterThan(0);
  }, 30_000);
});
