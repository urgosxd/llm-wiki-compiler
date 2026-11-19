/**
 * The two graph export writers, driven from real pages on disk, over a body that
 * links to a page in a namespace that the bare slug cannot disambiguate.
 *
 * WHAT THE SYSTEM DOES (every locator below was read while writing this file):
 * - A page IS `(page_directory, slug)`: `packages/wiki/src/dimensions/wiki/schema.sql:106`
 *   declares `primary key (stack_id, page_directory, slug)`, so `concepts/x` and
 *   `queries/x` are two different pages that the string `x` names neither of.
 * - `ExportPage.links` is built by `extractWikilinkSlugs`
 *   (`packages/wiki/src/export/collect.ts:180`), which normalizes through
 *   `normalizeWikilinkTarget` (`packages/wiki/src/wiki/wikilink-tokens.ts:77`):
 *   a qualified target keeps its namespace and only its page part is slugified.
 * - `buildGraphml` compared those targets against a set of BARE slugs
 *   (`packages/wiki/src/export/graphml.ts:84`, `new Set(pages.map((p) => p.slug))`)
 *   and dropped every target it did not find (`:69`,
 *   `.filter((slug) => knownSlugs.has(slug))`), so a body link `[[concepts/y]]`
 *   produced NO edge. Its node ids were the bare slug too (`:55`, and the edge
 *   endpoints at `:72`), which is not a unique identity once both directories hold
 *   the same stem.
 * - `buildJsonLd` minted `urn:llmwiki:<slug>` for both a node (`:32`) and a mention
 *   (`:50`), so a qualified mention pointed at an IRI no node in the document
 *   declares, and two pages sharing a stem collapsed into one `@id`.
 *
 * The pinned invariant is a property, not a literal: every edge endpoint and every
 * mention IRI in an export names a node/`@id` that the SAME document declares.
 */
import "../../../../test/fixtures/file-mode.js";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectExportPages } from "./collect.js";
import { buildGraphml } from "./graphml.js";
import { buildJsonLd } from "./json-ld.js";
import type { ExportPage } from "./types.js";

const roots: string[] = [];

/** A throwaway project root, removed after every case. */
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llmwiki-export-links-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await fs.mkdir(path.join(root, "wiki/queries"), { recursive: true });
  return root;
}

/** One page written the way the compiler writes them: frontmatter, then body. */
async function writePage(dir: string, slug: string, body: string): Promise<void> {
  const frontmatter = `---\ntitle: ${slug}\nsummary: about ${slug}\n---`;
  await fs.writeFile(path.join(dir, `${slug}.md`), `${frontmatter}\n\n${body}\n`);
}

/** Export pages for a project whose concepts/x links `linkTargets`. */
async function exportPages(linkTargets: string): Promise<ExportPage[]> {
  const root = await tempRoot();
  await writePage(path.join(root, "wiki/concepts"), "x", `See ${linkTargets}.`);
  await writePage(path.join(root, "wiki/concepts"), "y", "No links here.");
  await writePage(path.join(root, "wiki/queries"), "y", "The other y.");
  return collectExportPages(root);
}

/** `source`/`target` of every `<edge>` in a GraphML document. */
function edges(graphml: string): { source: string; target: string }[] {
  return [...graphml.matchAll(/<edge source="([^"]*)" target="([^"]*)"/g)].map((match) => ({
    source: match[1] as string,
    target: match[2] as string,
  }));
}

/** `id` of every `<node>` in a GraphML document, in document order. */
function nodeIds(graphml: string): string[] {
  return [...graphml.matchAll(/<node id="([^"]*)"/g)].map((match) => match[1] as string);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("graphml export over qualified wikilink targets", () => {
  it("emits the edge a qualified body link names", async () => {
    const graphml = buildGraphml(await exportPages("[[concepts/y]]"));

    expect(edges(graphml)).toEqual([{ source: "concepts/x", target: "concepts/y" }]);
  });

  it("keeps a bare body link resolving concepts-first", async () => {
    const graphml = buildGraphml(await exportPages("[[y]]"));

    expect(edges(graphml)).toEqual([{ source: "concepts/x", target: "concepts/y" }]);
  });

  it("confines a qualified target to its own namespace and keeps node ids unique", async () => {
    const graphml = buildGraphml(await exportPages("[[queries/y]]"));

    // The bare stem `y` exists in BOTH directories, so it cannot be the node id:
    // the link said `queries`, and `concepts/y` is a different page.
    expect(nodeIds(graphml).sort()).toEqual(["concepts/x", "concepts/y", "queries/y"]);
    expect(edges(graphml)).toEqual([{ source: "concepts/x", target: "queries/y" }]);
  });

  it("declares every edge endpoint as a node in the same document", async () => {
    const graphml = buildGraphml(await exportPages("[[concepts/y]] and [[queries/y]]"));
    const known = new Set(nodeIds(graphml));

    for (const { source, target } of edges(graphml)) {
      expect(known.has(source)).toBe(true);
      expect(known.has(target)).toBe(true);
    }
  });
});

describe("json-ld export over qualified wikilink targets", () => {
  it("mints a mention IRI that the same graph declares as a node", async () => {
    const doc = JSON.parse(buildJsonLd(await exportPages("[[queries/y]]"))) as {
      "@graph": { "@id": string; mentions?: { "@id": string }[] }[];
    };
    const declared = new Set(doc["@graph"].map((node) => node["@id"]));

    expect(declared.size).toBe(3);
    for (const node of doc["@graph"]) {
      for (const mention of node.mentions ?? []) {
        expect(declared.has(mention["@id"])).toBe(true);
      }
    }
  });

  it("gives two pages that share a stem two distinct @ids", async () => {
    const doc = JSON.parse(buildJsonLd(await exportPages("[[y]]"))) as {
      "@graph": { "@id": string; mentions?: { "@id": string }[] }[];
    };

    expect(doc["@graph"].map((node) => node["@id"]).sort()).toEqual([
      "urn:llmwiki:concepts/x",
      "urn:llmwiki:concepts/y",
      "urn:llmwiki:queries/y",
    ]);
    // A bare target keeps the concepts-first precedence the wiki resolves it with.
    const source = doc["@graph"].find((node) => node["@id"] === "urn:llmwiki:concepts/x");
    expect(source?.mentions).toEqual([{ "@id": "urn:llmwiki:concepts/y" }]);
  });
});
