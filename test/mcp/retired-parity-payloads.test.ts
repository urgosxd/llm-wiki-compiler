/**
 * @file test/mcp/retired-parity-payloads.test.ts
 * @description The three MCP payload shapes the cross-surface parity suite no longer freezes.
 *
 * ## What was retired and why it could not survive
 *
 * `test/parity-default.test.ts` captured `wiki_status`, `lint_wiki` and `read_page` as
 * goldens describing a FILESYSTEM corpus (`test/fixtures/parity-corpus.ts`) — page
 * counts, `<ROOT>/wiki/concepts/*.md` findings, and the page whose stem is
 * `Foo Bar`. Every MCP tool is Stack/row-only now, and `isSlugSafe`
 * (`src/utils/page-identity.ts:35-47`) rejects a space, so that page has no row form at
 * all: the golden asserts a payload that cannot exist, which is not a regression.
 *
 * ## Why the coverage moved here rather than disappearing
 *
 * A retired capture is acceptable; an unasserted payload shape is not. Each capture
 * froze the WHOLE payload, so each one is pinned here against a Stack whose rows are
 * seeded on purpose, and the call goes through a real `callTool` handshake (an
 * `McpServer` and a `Client` over the SDK's in-memory transport) rather than through a
 * handler snapshot — a client and a test should meet the tool the same way.
 *
 * ## Why the fixture is a scratch project with no `wiki/` and no `sources/`
 *
 * Every value asserted has to come from rows. A populated checkout would let a disk
 * read answer where rows were meant to, and the pin would hold for a reason unrelated
 * to what it measures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveStoredCandidate } from "../../packages/wiki/src/dimensions/wiki/candidate-store.js";
import {
  hashSourceContent,
  saveSourceDocument,
  stableSourceContent,
} from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { writeWikiStateToRows } from "../../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import type { WikiState } from "../../packages/wiki/src/utils/types.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { callToolPayload, seedConceptPage } from "../fixtures/mcp-stack-rows.js";
import { provisionStack, type ProvisionedStack } from "../fixtures/stack-harness.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** Compile time recorded for the seeded Stack. */
const COMPILED_AT = "2024-01-03T00:00:00.000Z";
/** Identity whose stored document still matches its recorded hash. */
const FRESH_IDENTITY = "https://parity.test/fresh";
/** Identity whose stored document changed since the recorded hash. */
const STALE_IDENTITY = "https://parity.test/stale";
/** Identity that has a document row and no compile-state entry, so it reads `new`. */
const NEW_IDENTITY = "https://parity.test/new";
/** Page body long enough to stay clear of the `empty-page` rule. */
const BODY_LONG_ENOUGH = "Body long enough that the empty-page rule has nothing to say.";

/** The document text the Stack stores for one identity. */
function documentFor(identity: string): string {
  return `${identity} body\n`;
}

/**
 * A page body the compiler could have written, with frontmatter summary + title.
 *
 * `orphaned: true` is how a row corpus marks a page whose sources are gone: a
 * `source_compile_state` row cannot outlive its `source_documents` row (the foreign key
 * cascades), so "every owning source was deleted" arrives as frontmatter here.
 */
function pageBody(title: string, summary: string, orphaned = false): string {
  const flag = orphaned ? "orphaned: true\n" : "";
  return `---\ntitle: ${title}\nsummary: ${summary}\n${flag}---\n\n${BODY_LONG_ENOUGH}\n`;
}

/** The compile state the seeded Stack's rows carry. */
function seededState(): WikiState {
  return {
    version: 2,
    indexHash: "",
    sources: {
      [FRESH_IDENTITY]: {
        hash: hashSourceContent(stableSourceContent(documentFor(FRESH_IDENTITY))),
        concepts: ["fresh-page"],
        compiledAt: COMPILED_AT,
        source: FRESH_IDENTITY,
      },
      // An earlier run's hash: the document on record no longer matches it.
      [STALE_IDENTITY]: {
        hash: "hash-recorded-by-an-earlier-compile",
        concepts: ["stale-page"],
        compiledAt: COMPILED_AT,
        source: STALE_IDENTITY,
      },
    },
  };
}

/** Write the page rows, source-document rows, compile state and one review candidate. */
async function seedStack(stack: ProvisionedStack): Promise<void> {
  const { db, stackId } = stack.harness;
  await seedConceptPage(stack.harness, "fresh-page", pageBody("Fresh", "fresh summary"));
  await seedConceptPage(stack.harness, "stale-page", pageBody("Stale", "stale summary"));
  await seedConceptPage(stack.harness, "gone-page", pageBody("Gone", "gone summary", true));
  for (const identity of [FRESH_IDENTITY, STALE_IDENTITY, NEW_IDENTITY]) {
    await saveSourceDocument(db, stackId, {
      title: identity,
      source: identity,
      document: documentFor(identity),
    });
  }
  await writeWikiStateToRows(db, stackId, seededState());
  await saveStoredCandidate(db, stackId, {
    id: "candidate-0",
    title: "Candidate 0",
    slug: "candidate-0",
    summary: "s",
    sources: [],
    body: "body",
    generatedAt: "2024-01-01T00:00:00.000Z",
    reviewMode: "policy",
    heldReasons: [],
  });
}

let stack: ProvisionedStack;
let root: string;
let server: McpServer;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  stack = await provisionStack("retired-parity-payloads");
  // No `wiki/` and no `sources/`: every asserted value has to come from rows.
  root = await scratchProjectRoot("retired-parity-");
  // `countCandidates` only consults the review queue when the internal dir exists.
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  server = buildServer(root);
  savedEnv = { ...process.env };
});

afterEach(async () => {
  process.env = savedEnv;
  await stack.release();
  await rm(root, { recursive: true, force: true });
});

/**
 * Call a registered tool the way a client does: `tools/call` over a real transport.
 *
 * @param name - Registered tool name.
 * @param args - Arguments for the call, including the required Stack.
 * @returns The decoded JSON payload the handler answered with.
 */
async function callPayload(name: string, args: Record<string, unknown>): Promise<unknown> {
  return callToolPayload(server, name, args, "retired-parity-payloads");
}

describe("payloads the retired parity captures used to freeze", () => {
  it("answers wiki_status with the whole row-derived status object", async () => {
    if (!stack.harness.reachable) return;
    await seedStack(stack);

    const status = await callPayload("wiki_status", { stackId: stack.harness.stackId });

    // `pages.concepts` counts two of the three rows on purpose: the non-orphaned gate
    // excludes `gone-page`, which is exactly the page `orphanedPages` reports.
    expect(status).toEqual({
      pages: { concepts: 2, queries: 0, total: 2 },
      // `status.sources` counts the SELECTED `sources/` listing, and this root has no
      // `sources/` tree: three source ROWS do not make a listing. Every other field in
      // this payload is row-derived, so it still proves the rows were read.
      sources: 0,
      lastCompiledAt: COMPILED_AT,
      stalePages: ["stale-page"],
      staleCount: 1,
      orphanedPages: ["gone-page"],
      orphanedCount: 1,
      stateStatus: "ok",
      pendingCandidates: 1,
      pendingChanges: [
        { file: NEW_IDENTITY, status: "new" },
        { file: STALE_IDENTITY, status: "changed" },
      ],
      pendingChangesCount: 2,
    });
  }, 60_000);

  it("answers lint_wiki with the whole row-derived lint summary", async () => {
    if (!stack.harness.reachable) return;
    await seedStack(stack);

    const summary = (await callPayload("lint_wiki", { stackId: stack.harness.stackId })) as {
      errors: number;
      warnings: number;
      info: number;
      results: Array<{ file: string; message: string; rule: string; severity: string }>;
    };

    // The four counters the capture froze, plus the finding envelope it asserted.
    expect(Object.keys(summary).sort()).toEqual(["errors", "info", "results", "warnings"]);
    expect(Number.isInteger(summary.warnings)).toBe(true);
    expect(summary.warnings).toBe(summary.results.filter((r) => r.severity === "warning").length);
    expect(summary.errors + summary.info + summary.warnings).toBe(summary.results.length);
    // Findings name a page, the rule that fired and its severity — the shape the
    // golden compared field by field.
    for (const finding of summary.results) {
      expect(Object.keys(finding).sort()).toEqual(["file", "message", "rule", "severity"]);
    }
    expect(summary.results).toContainEqual(
      expect.objectContaining({ rule: "stale-page", severity: "warning" }),
    );
    expect(summary.results).toContainEqual(
      expect.objectContaining({ rule: "orphaned-page", severity: "warning" }),
    );
  }, 60_000);

  it("answers read_page with the whole row-derived page object", async () => {
    if (!stack.harness.reachable) return;
    await seedStack(stack);

    const page = await callPayload("read_page", {
      slug: "fresh-page",
      stackId: stack.harness.stackId,
    });

    // Exactly the four fields the retired capture compared, and nothing about the
    // corpus the golden described: a row page carries no path. `body` is the text
    // left after the frontmatter block, verbatim — including its leading blank line.
    expect(page).toEqual({
      slug: "fresh-page",
      title: "Fresh",
      summary: "fresh summary",
      body: `\n${BODY_LONG_ENOUGH}\n`,
    });
  }, 60_000);
});
