/**
 * @file test/mcp/read-page-links.test.ts
 * @description `read_page` must return the page's OUTGOING wikilinks so an agent can traverse.
 *
 * ## The condition these tests contain
 *
 * `read_page` used to return `{ slug, title, summary, body }` and nothing about the
 * references inside the body. An agent that met `[[beta|Beta label]]` could re-query,
 * never follow — the reference was text with no wire representation.
 *
 * The fixture therefore seeds a REAL edge: a page body whose wikilink names a second
 * page that also exists as a row. The assertion is not "a string is somewhere in the
 * payload" but "this exact edge is reported", followed by the only check that makes the
 * feature real — passing the returned `slug` back to `read_page` and getting the target
 * page's title and body.
 *
 * ## Why the wire cases call through the tool, not the reader
 *
 * The wire object is the contract. Calling `readPageBySlug` directly would pin the
 * internal return value and stay green while the tool payload changed shape, so every
 * wire case here calls `read_page` over a real in-memory transport and decodes the JSON
 * a client receives. The one exception is the `pageLinkRefs` case, which is a unit
 * check of the extractor's dedupe/alias rule — a rule no single page's payload can
 * demonstrate, since a distinct target appears once by construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { callToolPayload, seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { provisionStack, type ProvisionedStack } from "../fixtures/stack-harness.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { pageLinkRefs } from "../../packages/wiki/src/pages/read.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";

/** Body text of the page that LINKS out; long enough to stay clear of `empty-page`. */
const ALPHA_TEXT = "Alpha body text, which points at [[beta|Beta label]] for the rest.";
/**
 * Body text of a page that cites a target by its qualified page id — the form the
 * answer prompt tells the model to use — instead of a bare slug.
 */
const QUALIFIED_TEXT = "Qualified body text, which points at [[concepts/beta]] for the rest.";
/** Body text of the page the link NAMES, distinctive so a wrong page cannot pass. */
const BETA_TEXT = "Beta body text, reachable only by following the link.";
/** A page whose outgoing link names its target by QUALIFIED page id, in the OTHER namespace. */
const CROSS_NAMESPACE_TEXT = "Collision body text, which points at [[queries/x]] for the rest.";
/** A page that names no other page. */
const LONE_TEXT = "Lone body text, which points at nothing at all.";
/** Body text of a page whose only link names a page nothing ever wrote. */
const DANGLING_TEXT = "Dangling body text, which points at [[never-written]].";

/** A concept page to seed as a row, before a case reads one of the pages. */
interface SeedPage {
  slug: string;
  title: string;
  summary: string;
  /** Body text, without frontmatter — `pageBody` adds it. */
  text: string;
}

/** The linked pair: `alpha` names `beta` through an aliased wikilink. */
const ALPHA_PAGE: SeedPage = { slug: "alpha", title: "Alpha", summary: "alpha summary", text: ALPHA_TEXT };
const BETA_PAGE: SeedPage = { slug: "beta", title: "Beta", summary: "beta summary", text: BETA_TEXT };
/** A page that names no other page. */
const LONE_PAGE: SeedPage = { slug: "lone", title: "Lone", summary: "lone summary", text: LONE_TEXT };
/** A page whose only outgoing link names its target by QUALIFIED page id. */
const QUALIFIED_PAGE: SeedPage = {
  slug: "qualified", title: "Qualified", summary: "qualified summary", text: QUALIFIED_TEXT,
};
/**
 * Two pages that share one stem, one per directory. They differ in title and body so
 * that landing on the wrong one cannot pass: a page is `(page_directory, slug)`
 * (`packages/wiki/src/dimensions/wiki/schema.sql:106`), and `x` names neither.
 */
const CONCEPT_X_PAGE: SeedPage = {
  slug: "x", title: "Concept X", summary: "concept x summary", text: "Concept X body text.",
};
const QUERY_X_PAGE: SeedPage = {
  slug: "x", title: "Query X", summary: "query x summary", text: "Query X body text.",
};
/** The page whose body links to the QUERY `x` while both `x` pages exist. */
const CROSS_NAMESPACE_PAGE: SeedPage = {
  slug: "cross", title: "Cross", summary: "cross summary", text: CROSS_NAMESPACE_TEXT,
};

/**
 * A page body the compiler could have written, with frontmatter title and summary.
 *
 * Same shape the compile writes: frontmatter block, one blank line, then the body —
 * which is why the `body` a caller receives starts with a newline.
 */
function pageBody(title: string, summary: string, text: string): string {
  return `---\ntitle: ${title}\nsummary: ${summary}\n---\n\n${text}\n`;
}

/** The `read_page` payload as a client decodes it. */
interface ReadPagePayload {
  slug: string;
  title: string;
  summary: string;
  body: string;
  links: Array<{ slug: string; label: string }>;
}

let stack: ProvisionedStack;
let root: string;
let server: McpServer;

beforeEach(async () => {
  stack = await provisionStack("read-page-links");
  // No `wiki/` directory: every value asserted has to come from the seeded rows, so a
  // silent fallback to disk cannot satisfy these cases.
  root = await scratchProjectRoot("read-page-links-");
  server = buildServer(root);
});

afterEach(async () => {
  await stack.release();
  await rm(root, { recursive: true, force: true });
});

/**
 * Read one page through the tool, the way a client does.
 *
 * @param slug - Page slug to read.
 * @returns The decoded payload.
 */
async function readPage(slug: string): Promise<ReadPagePayload> {
  return (await callToolPayload(
    server,
    "read_page",
    { slug, stackId: stack.harness.stackId },
    "read-page-links",
  )) as ReadPagePayload;
}

/**
 * Seed concept rows, then read one page through the tool.
 *
 * This is the precondition every case in this file shares, so it lives here once: the
 * `reachable` guard, the rows the case depends on, and the tool call are identical in
 * all of them, and only WHICH pages exist and which one is read actually differ.
 *
 * @param readSlug - Page to read once the rows are in place.
 * @param seeded - Pages to insert as concept rows, in order.
 * @returns The decoded payload, or `null` when no database is reachable — which is
 *   the signal for the calling case to skip itself, as the hand-written guard did.
 */
async function seedAndRead(
  readSlug: string,
  ...seeded: readonly SeedPage[]
): Promise<ReadPagePayload | null> {
  if (!stack.harness.reachable) return null;
  for (const page of seeded) {
    await seedConceptPage(stack.harness, page.slug, pageBody(page.title, page.summary, page.text));
  }
  return readPage(readSlug);
}

/**
 * Seed `concepts/x` and `queries/x` — one stem, two directories — through the
 * production write sink.
 *
 * The sink takes the directory, so the second namespace needs no fixture of its own;
 * `seedConceptPage` covers `concepts` only, and a hand-written row would be a second
 * shape for state the product writes one way.
 */
async function seedBothStemHolders(): Promise<void> {
  const sink = createPageWriteSink(stack.harness.db, stack.harness.stackId);
  await seedConceptPage(
    stack.harness,
    CONCEPT_X_PAGE.slug,
    pageBody(CONCEPT_X_PAGE.title, CONCEPT_X_PAGE.summary, CONCEPT_X_PAGE.text),
  );
  await sink({
    directory: "queries",
    slug: QUERY_X_PAGE.slug,
    body: pageBody(QUERY_X_PAGE.title, QUERY_X_PAGE.summary, QUERY_X_PAGE.text),
  });
}

/**
 * Follow a reported link slug the way a client does, and prove it reaches the target.
 *
 * Both the bare-slug and the qualified-id case assert the same promise — the wire
 * `slug` is followable — so the follow lives here once instead of twice.
 *
 * @param links - The decoded `links` array of the page that was read.
 * @param expectedSlug - The page id `read_page` must answer with, which is the value
 *   the link carried: `beta` for a bare target, `concepts/beta` for a qualified one.
 */
async function expectFollowsToBeta(
  links: Array<{ slug: string }>,
  expectedSlug: string,
): Promise<void> {
  const target = await readPage(links[0].slug);
  expect(target.slug).toBe(expectedSlug);
  expect(target.title).toBe("Beta");
  expect(target.body).toContain(BETA_TEXT);
}

describe("read_page outgoing links — traversal", () => {
  it("reports the seeded edge with its target slug and the label the page used", async () => {
    const payload = await seedAndRead("alpha", ALPHA_PAGE, BETA_PAGE);
    if (payload === null) return;

    // The label is the anchor text the page actually wrote, not the target text, and
    // the slug is the followable target — not the alias.
    expect(payload.links).toEqual([{ slug: "beta", label: "Beta label" }]);
  }, 60_000);

  it("hands back a slug that read_page can follow to the target page", async () => {
    const alpha = await seedAndRead("alpha", ALPHA_PAGE, BETA_PAGE);
    if (alpha === null) return;

    // A link an agent cannot follow is not the feature: the slug it was handed must
    // resolve to the page the label named.
    await expectFollowsToBeta(alpha.links, "beta");
  }, 60_000);
});

describe("read_page outgoing links — wire shape", () => {
  it("answers links: [] — present, empty, never omitted — for a page with no wikilinks", async () => {
    const payload = await seedAndRead("lone", LONE_PAGE);
    if (payload === null) return;

    // The key must exist on the wire: an omitted key and an empty array are different
    // contracts, and only one of them lets a client iterate without a guard.
    expect(Object.hasOwn(payload, "links")).toBe(true);
    expect(payload.links).toEqual([]);
  }, 60_000);

  it("keeps the four pre-existing fields unchanged and appends links after body", async () => {
    const payload = await seedAndRead("alpha", ALPHA_PAGE, BETA_PAGE);
    if (payload === null) return;

    // Additive means additive: the same values as before, in the same order, with
    // `links` appended — adding a key is fine, reordering one is not.
    expect(Object.keys(payload)).toEqual(["slug", "title", "summary", "body", "links"]);
    expect(payload.slug).toBe("alpha");
    expect(payload.title).toBe("Alpha");
    expect(payload.summary).toBe("alpha summary");
    expect(payload.body).toBe(`\n${ALPHA_TEXT}\n`);
  }, 60_000);
});

describe("read_page links that name a page nobody wrote", () => {
  it("hands back a slug for it, which read_page then refuses", async () => {
    // LOUD precondition, deliberately not a skip: this case asserts a FAILURE, and an
    // unreachable database would let that failure pass for the wrong reason.
    expect(stack.harness.reachable).toBe(true);
    const dangling = pageBody("Dangling", "dangling summary", DANGLING_TEXT);
    await seedConceptPage(stack.harness, "dangling", dangling);

    const payload = await readPage("dangling");

    // No alias on the wikilink, so the label falls back to the target text — and the
    // slug is still a slug, not a claim that the page exists.
    expect(payload.links).toEqual([{ slug: "never-written", label: "never-written" }]);

    // Following it fails the way any unknown slug does: reporting the edge without
    // pretending to resolve it is the honest contract, and the agent sees why.
    const follow = { slug: "never-written", stackId: stack.harness.stackId };
    await expect(callTool(server, "read_page", follow)).rejects.toThrow(
      "Page not found: never-written",
    );
  }, 60_000);
});

describe("pageLinkRefs", () => {
  it("reports one ref per distinct target, in first-appearance order, with the first alias", () => {
    // The doc comment promises DISTINCT targets in first-appearance order, labelled with
    // the alias the link was FIRST written with. A second wikilink to the same page must
    // add neither a ref nor a relabel, and the un-aliased third must not win.
    expect(pageLinkRefs("[[beta|First]] then [[beta|Second]] and [[beta]].")).toEqual([
      { slug: "beta", label: "First" },
    ]);
  });

  it("keeps a qualified wikilink target as the slug read_page accepts", () => {
    // The wire field must be FOLLOWABLE, and a page is `(page_directory, slug)`, so
    // the normalized target is carried verbatim: projecting `concepts/beta` to `beta`
    // names a different page whenever `queries/beta` also exists (`read_page` reads
    // concepts first). The label keeps what the page wrote.
    expect(pageLinkRefs("See [[concepts/beta]] and [[queries/gamma|Gamma label]].")).toEqual([
      { slug: "concepts/beta", label: "concepts/beta" },
      { slug: "queries/gamma", label: "Gamma label" },
    ]);
  });
});

describe("read_page links that name their target by qualified page id", () => {
  it("hands back the qualified target and read_page follows it to that page", async () => {
    const payload = await seedAndRead("qualified", QUALIFIED_PAGE, BETA_PAGE);
    if (payload === null) return;

    // The documented promise is that `links[].slug` can be passed straight back, and
    // the only value that keeps that promise is the one the link actually carried.
    expect(payload.links).toEqual([{ slug: "concepts/beta", label: "concepts/beta" }]);

    await expectFollowsToBeta(payload.links, "concepts/beta");
  }, 60_000);

  it("follows [[queries/x]] to the QUERIES page when both directories hold x", async () => {
    // LOUD precondition, not a skip: this case asserts which page was reached, and an
    // unreachable database would let the concepts page win for the wrong reason.
    expect(stack.harness.reachable).toBe(true);
    await seedBothStemHolders();
    await seedConceptPage(
      stack.harness,
      CROSS_NAMESPACE_PAGE.slug,
      pageBody(CROSS_NAMESPACE_PAGE.title, CROSS_NAMESPACE_PAGE.summary, CROSS_NAMESPACE_PAGE.text),
    );

    const payload = await readPage("cross");

    // The link said `queries`. A bare `x` here follows the concepts-first rule and
    // arrives at a page the body never named.
    expect(payload.links).toEqual([{ slug: "queries/x", label: "queries/x" }]);
    const followed = await readPage(payload.links[0].slug);
    expect(followed.title).toBe("Query X");
    expect(followed.body).toContain("Query X body text.");
  }, 60_000);

  it("leaves the bare-slug path alone: read_page('x') still answers the CONCEPTS page", async () => {
    // PRESERVE, and pin what it is rather than choosing it: with a stem in both
    // directories, a bare slug has always meant "concepts first".
    expect(stack.harness.reachable).toBe(true);
    await seedBothStemHolders();

    const bare = await readPage("x");
    expect(bare.slug).toBe("x");
    expect(bare.title).toBe("Concept X");
    expect(bare.body).toContain("Concept X body text.");
  }, 60_000);
});
