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
 * the target — its title, a declared alias, or a token-contiguous run of that
 * title; one link per target per section; and a per-page budget it may not
 * exceed.
 *
 * A run is measured in the gate's own canonical domain: the tokens
 * `canonicalConceptKey` produces, so a label is compared by the same plural
 * stemmer and acronym table the identity tiers use. Reordered tokens are not a
 * run, and a label that is a run of a DIFFERENT page's title is not a run of this
 * one, which is what keeps a wrong target demoted without a second rule.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildPageLinkIndex, validateContextualLinks } from "../../packages/wiki/src/compiler/link-anchoring.js";
import { canonicalConceptKey } from "../../packages/wiki/src/dimensions/wiki/concept-identity.js";
import { MAX_CONTEXTUAL_LINKS_PER_PAGE } from "../../packages/wiki/src/utils/constants.js";
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

/** A target page one run case links to: its slug, its title, and any declared aliases. */
interface RunTarget {
  /** Slug of the concept page, which is also the wikilink target. */
  slug: string;
  /** The page title the visible label is a leading, trailing or interior run of. */
  title: string;
  /** Aliases the page declares; a label may be a run of one of these instead. */
  aliases?: readonly string[];
}

/**
 * Drive one single-link body against a fresh wiki holding only the target page.
 *
 * Both run helpers assert the same three facts — the body written, the body that would
 * be written, and the counts reported — so the setup that produces them is shared here
 * rather than repeated in each direction.
 *
 * @param prefix - Prefix of the throwaway wiki root, so a failure names its case.
 * @param target - The page the link resolves to, by slug, title and declared aliases.
 * @param label - The visible text of the one link in the body.
 * @returns The body written, the body returned, and the counts reported.
 */
async function validateRun(prefix: string, target: RunTarget, label: string) {
  const root = await tempRoot(prefix);
  await writeConcept(root, target.slug, target.title, target.aliases);
  const input = `## Uses\n\nSee [[${target.slug}|${label}]] for the detail.\n`;
  const { body, counts } = await validate(root, input);
  return { input, body, counts };
}

/**
 * Assert that a label which is a run of a name of its target is KEPT, byte for byte.
 *
 * The whole claim is asserted here, never a weaker "not demoted": exactly one link
 * kept, nothing demoted on any of the five reasons, and a body identical to the one
 * written. The run cases differ only in WHICH run they anchor, never in what holds.
 *
 * @param prefix - Prefix of the throwaway wiki root, so a failure names its case.
 * @param target - The page the link resolves to, and a name of it the label runs into.
 * @param label - The visible text: a leading, trailing or interior run of that name.
 */
async function expectRunKept(prefix: string, target: RunTarget, label: string): Promise<void> {
  const { input, body, counts } = await validateRun(prefix, target, label);

  expect(counts).toEqual({ kept: 1, demoted: noDemotions() });
  expect(body).toBe(input);
}

/**
 * Assert that a label which is NOT a run of any name of its target is DEMOTED.
 *
 * The mirror of {@link expectRunKept}, and as strict in the other direction: nothing
 * kept, exactly one link demoted `unanchored` with the other four reasons at zero, and
 * the mention left in the body as plain words — a demotion drops the markup, never the
 * reader's text.
 *
 * @param prefix - Prefix of the throwaway wiki root, so a failure names its case.
 * @param target - The page the link resolved to; the label is no run of its names.
 * @param label - The visible text: not a consecutive run of the title or an alias.
 */
async function expectRunDemoted(prefix: string, target: RunTarget, label: string): Promise<void> {
  const { body, counts } = await validateRun(prefix, target, label);

  expect(counts).toEqual({ kept: 0, demoted: { ...noDemotions(), unanchored: 1 } });
  expect(body).toBe(`## Uses\n\nSee ${label} for the detail.\n`);
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
    expect(counts).toEqual({ kept: 0, demoted: { ...noDemotions(), "self-reference": 1 } });
  });
});

describe("anchored contextual links — a label that is a run of its title", () => {
  it("keeps a label that is the leading run of its target's title", async () => {
    const target = { slug: "br-dw-15", title: "BR-DW-15: Feedback visual" };
    await expectRunKept("link-anchor-prefix", target, "BR-DW-15");
  });

  it("keeps a label that is the trailing run of its target's title", async () => {
    const target = { slug: "breadth-first-search", title: "Breadth-First Search (BFS)" };
    await expectRunKept("link-anchor-suffix", target, "Search (BFS)");
  });

  it("keeps a label that is an interior run of its target's title", async () => {
    const target = { slug: "checksum-s3-key-pattern", title: "Checksum S3 Key Pattern" };
    await expectRunKept("link-anchor-interior", target, "S3 Key");
  });

  it("keeps an interior run that is a run only once plurals are stemmed", async () => {
    const target = { slug: "checksum-s3-key-pattern", title: "Checksum S3 Key Pattern" };

    // Pin the canonical domain instead of implying it: "Key Patterns" is neither a
    // substring of the title nor a run of its raw tokens. The stemmer is what makes
    // "pattern" an interior run of "pattern".
    expect(canonicalConceptKey("Key Patterns")).toBe("key pattern");
    expect(canonicalConceptKey("Checksum S3 Key Pattern")).toBe("checksum s3 key pattern");
    await expectRunKept("link-anchor-plural-run", target, "Key Patterns");
  });

  it("keeps a run that is a run only once an acronym is expanded", async () => {
    const target = { slug: "large-language-model-gateway", title: "Large Language Model Gateway" };

    // "LLM" shares no raw token with the title, so only the reviewed expansion in
    // ACRONYM_EXPANSIONS turns this label into a leading run of it.
    expect(canonicalConceptKey("LLM")).toBe("large language model");
    expect(canonicalConceptKey("Large Language Model Gateway")).toBe("large language model gateway");
    await expectRunKept("link-anchor-acronym-run", target, "LLM");
  });

  it("keeps a run of a declared alias, not only a run of the title", async () => {
    const target = {
      slug: "graph-traversal-algorithms",
      title: "Graph Traversal Algorithms",
      aliases: ["Graph Traversal Notes"],
    };

    // The run is of the ALIAS: "Traversal Notes" is no run of the title at all, so a
    // rule that only looked at titles would demote this honest link.
    expect(canonicalConceptKey("Traversal Notes")).toBe("traversal note");
    expect(canonicalConceptKey("Graph Traversal Algorithms")).toBe("graph traversal algorithm");
    await expectRunKept("link-anchor-alias-run", target, "Traversal Notes");
  });
});

describe("anchored contextual links — a label that is not a run of its title", () => {
  it("still demotes a label that shares no canonical token with its target", async () => {
    const root = await tempRoot("link-anchor-no-token");
    await writeConcept(root, "checksum-s3-key-pattern", "Checksum S3 Key Pattern");
    const input = "## Key\n\nSee [[checksum-s3-key-pattern|Solar Wind]] before upload.\n";

    const { body, counts } = await validate(root, input);

    expect(body).toBe("## Key\n\nSee Solar Wind before upload.\n");
    expect(counts).toEqual({ kept: 0, demoted: { ...noDemotions(), unanchored: 1 } });
  });

  it("still demotes a label whose tokens are the title's, reordered", async () => {
    const root = await tempRoot("link-anchor-reordered");
    await writeConcept(root, "breadth-first-search", "Breadth-First Search (BFS)");
    const input = "## Order\n\nSee [[breadth-first-search|BFS Breadth-First]] for the queue.\n";

    const { body, counts } = await validate(root, input);

    // The premise of this case: the label carries three of the title's four
    // canonical tokens, in another order, so containment alone is not a run.
    expect(canonicalConceptKey("Breadth-First Search (BFS)")).toBe("breadth first search bfs");
    expect(canonicalConceptKey("BFS Breadth-First")).toBe("bfs breadth first");
    expect(body).toBe("## Order\n\nSee BFS Breadth-First for the queue.\n");
    expect(counts).toEqual({ kept: 0, demoted: { ...noDemotions(), unanchored: 1 } });
  });

  it("still demotes a label that carries every token of its title and one more", async () => {
    const target = { slug: "checksum-s3-key-pattern", title: "Checksum S3 Key Pattern" };

    // A label LONGER than the name is not a run of it: the run may be a shorter
    // statement of the same concept, never a longer one.
    await expectRunDemoted("link-anchor-longer-label", target, "Checksum S3 Key Pattern Extra");
  });

  it("still demotes a label that skips a token of its title", async () => {
    const target = { slug: "checksum-s3-key-pattern", title: "Checksum S3 Key Pattern" };

    // This is the case that separates a RUN from a SUBSEQUENCE, and the reason the
    // rule is stated as contiguity: "Checksum Key Pattern" holds the title's tokens in
    // the title's order with one missing, so a subsequence matcher would keep it. No
    // part of the title says those three words consecutively, so a run matcher must
    // refuse it.
    await expectRunDemoted("link-anchor-skipped-token", target, "Checksum Key Pattern");
  });

  it("still demotes a label that carries no word characters at all", async () => {
    const target = { slug: "checksum-s3-key-pattern", title: "Checksum S3 Key Pattern" };

    // The empty-key guard: "!!!" canonicalises to nothing, and no tokens are not a run
    // of every title — the empty sequence is a run of everything if it is let through.
    expect(canonicalConceptKey("!!!")).toBe("");
    await expectRunDemoted("link-anchor-no-words", target, "!!!");
  });
});

describe("anchored contextual links — one label, two candidate targets", () => {
  it("separates a wrong target from the right one by whether the label is a run of its title", async () => {
    const root = await tempRoot("link-anchor-wrong-target");
    await writeConcept(
      root,
      "checksum-s3-key-pattern",
      "Checksum S3 Key Pattern ({expedienteId}/{hash}-{nombreOriginal})",
    );
    await writeConcept(root, "sha-256-checksum", "SHA-256 Checksum");
    const input = [
      "## Hashes",
      "",
      "Wrong: [[checksum-s3-key-pattern|SHA-256]].",
      "Right: [[sha-256-checksum|SHA-256]].",
      "",
    ].join("\n");

    const { body, counts } = await validate(root, input);

    // `sha 256` is a leading run of `sha 256 checksum`, and no run at all of the
    // checksum-pattern title, so the relaxation alone refuses the wrong target.
    expect(counts).toEqual({ kept: 1, demoted: { ...noDemotions(), unanchored: 1 } });
    expect(body).toBe([
      "## Hashes",
      "",
      "Wrong: SHA-256.",
      "Right: [[sha-256-checksum|SHA-256]].",
      "",
    ].join("\n"));
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

    const repeatLink = "and again [[graph-theory|Graph Theory]]";
    expect(body).toBe(input.replace(repeatLink, "and again Graph Theory"));
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

    // Exact bytes, not a contains check: which links reach the budget counter is
    // what a relaxation in the anchor rule can shift, so the shift must be visible.
    const kept = links.slice(0, MAX_CONTEXTUAL_LINKS_PER_PAGE).join(", ");
    expect(body).toBe(`## All\n\n${kept}, Topic ${total - 1}.\n`);
    expect(counts).toEqual({
      kept: MAX_CONTEXTUAL_LINKS_PER_PAGE,
      demoted: { ...noDemotions(), "over-budget": 1 },
    });
  });
});
