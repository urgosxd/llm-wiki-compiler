/**
 * @file test/compiler/link-anchoring.test.ts
 * @description Contextual links survive only when they are anchored to a real
 * mention of a real page of this wiki (S8).
 *
 * Every case drives the public page-body surface: a generated body plus the
 * wiki's page set goes in, and the body that would be written comes out. The
 * assertions are on those bytes and on the per-reason counts the compile
 * reports — never on an internal map of decisions.
 *
 * The rules, in the order the validator applies them: the target must resolve to
 * a real page; it must not be the page being written; the visible text must name
 * the target (its title or a declared alias); one link per target per section;
 * and a per-page budget it may not exceed.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildPageLinkIndex, validateContextualLinks } from "../../src/compiler/link-anchoring.js";
import { MAX_CONTEXTUAL_LINKS_PER_PAGE } from "../../src/utils/constants.js";
import { useManagedTempRoots } from "../fixtures/temp-root.js";
import { writePage } from "../fixtures/write-page.js";

/** Throwaway wiki roots, one per case, removed after each test. */
const { tempRoot } = useManagedTempRoots();

/** Write one concept page, with its title and declared aliases, into the wiki. */
async function writeConcept(
  root: string,
  slug: string,
  title: string,
  aliases: readonly string[] = [],
): Promise<void> {
  const fields: Record<string, unknown> = aliases.length === 0 ? { title } : { title, aliases: [...aliases] };
  await writePage(path.join(root, "wiki/concepts"), slug, fields, "Body.");
}

/** Run the validator as the renderer does: page "Networks" against this wiki. */
async function validate(root: string, body: string) {
  const index = await buildPageLinkIndex(root, { id: "concepts/networks", title: "Networks" });
  return await validateContextualLinks(body, index);
}

/** Counts with nothing demoted, the shape every kept-only case expects. */
function noDemotions() {
  return {
    "unresolved-target": 0,
    "self-reference": 0,
    unanchored: 0,
    redundant: 0,
    "over-budget": 0,
  };
}

describe("anchored contextual links — keep and demote", () => {
  it("keeps a link whose visible text names its target, byte for byte", async () => {
    const root = await tempRoot("link-anchor-keep");
    await writeConcept(root, "graph-theory", "Graph Theory");
    const input = "## Uses\n\nNetworks rely on [[graph-theory|Graph Theory]] daily.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe(input);
    expect(counts).toEqual({ kept: 1, demoted: noDemotions() });
  });

  it("demotes a link whose visible text names something else, keeping the mention", async () => {
    const root = await tempRoot("link-anchor-unanchored");
    await writeConcept(root, "graph-theory", "Graph Theory");
    const input = "## Uses\n\nNetworks rely on [[graph-theory|sourdough starters]] daily.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe("## Uses\n\nNetworks rely on sourdough starters daily.\n");
    expect(counts.kept).toBe(0);
    expect(counts.demoted.unanchored).toBe(1);
  });

  it("accepts a declared alias of the target as a real anchor", async () => {
    const root = await tempRoot("link-anchor-alias");
    await writeConcept(root, "vector-database", "Vector Database", ["Vector DB"]);
    const input = "A [[vector-database|Vector DB]] stores embeddings.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe(input);
    expect(counts.kept).toBe(1);
  });

  it("demotes a link to a page this wiki does not have and reports it unresolved", async () => {
    const root = await tempRoot("link-anchor-missing");
    const input = "Uses [[event-sourcing|Event Sourcing]] widely.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe("Uses Event Sourcing widely.\n");
    expect(counts.demoted["unresolved-target"]).toBe(1);
  });

  it("demotes a link back to the page being written", async () => {
    const root = await tempRoot("link-anchor-self");
    const input = "## Self\n\nNetworks build on [[networks|Networks]] too.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe("## Self\n\nNetworks build on Networks too.\n");
    expect(counts.demoted["self-reference"]).toBe(1);
  });
});

describe("anchored contextual links — redundancy and budget", () => {
  it("demotes a repeat link in one section but keeps the one in another section", async () => {
    const root = await tempRoot("link-anchor-redundant");
    await writeConcept(root, "graph-theory", "Graph Theory");
    const input = [
      "## First",
      "",
      "Uses [[graph-theory|Graph Theory]] and again [[graph-theory|Graph Theory]].",
      "",
      "## Second",
      "",
      "Also [[graph-theory|Graph Theory]].",
      "",
    ].join("\n");

    const { body, counts } = await validate(root, input);

    expect(body).toContain("Uses [[graph-theory|Graph Theory]] and again Graph Theory.");
    expect(body).toContain("Also [[graph-theory|Graph Theory]].");
    expect(counts).toEqual({ kept: 2, demoted: { ...noDemotions(), redundant: 1 } });
  });

  it("keeps at most the named per-page budget and reports the truncation", async () => {
    const root = await tempRoot("link-anchor-budget");
    const total = MAX_CONTEXTUAL_LINKS_PER_PAGE + 1;
    for (let index = 0; index < total; index += 1) {
      await writeConcept(root, `topic-${index}`, `Topic ${index}`);
    }
    const links = Array.from({ length: total }, (_, index) => `[[topic-${index}|Topic ${index}]]`);
    const input = `## All\n\n${links.join(", ")}.\n`;

    const { body, counts } = await validate(root, input);

    expect(counts.kept).toBe(MAX_CONTEXTUAL_LINKS_PER_PAGE);
    expect(counts.demoted["over-budget"]).toBe(1);
    expect(body).toContain(`Topic ${total - 1}.`);
    expect(body).not.toContain(`[[topic-${total - 1}|`);
  });
});
