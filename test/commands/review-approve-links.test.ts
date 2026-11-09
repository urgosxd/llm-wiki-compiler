/**
 * @file test/commands/review-approve-links.test.ts
 * @description `review approve` must judge the links of an approved page against
 * the SAME page set the compile path judges them against (S8, S12).
 *
 * ## The gap these cases pin
 *
 * `refreshWikiAfterApproval` called `resolveAndApplyLinks` with NO gate options, so
 * the one link gate fell back to the pages the resolver had already listed. On a
 * Stack that list is the CONCEPT namespace, which is narrower than the wiki: a
 * page in `queries` was a real, linkable target when a compile wrote the body and a
 * missing target when `review approve` wrote it. Same wiki, same link, two outcomes
 * depending on which verb produced the page — a silent difference in what the wiki
 * says, from nothing but the entry point.
 *
 * ## Why the RED needs a Stack
 *
 * The fallback is only narrow on a row-backed run. On the file backend the gate
 * already lists `wiki/` (both namespaces), so A1 and A2 provision a REAL Stack and
 * approve through the real command; A3 is the file-backed PIN that the rest of the
 * command's observable behaviour did not move with the fix.
 *
 * ## What each case asserts
 *
 * A1 the kept link, in the stored row body. A2 the same body also carrying two
 * links the decision table refuses — an unresolved target and a self-reference —
 * which must come back as plain words, because parity with the compile path means
 * the RULES came along too, not just the wider page set. A3 exit code, the two
 * user-facing status lines and the written page's bytes, byte for byte.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeCandidate } from "../../packages/wiki/src/compiler/candidates.js";
import { getStoredPage, upsertStoredPage } from "../../packages/wiki/src/dimensions/wiki/page-store.js";
import { CONCEPTS_DIR } from "../../packages/wiki/src/utils/constants.js";
import { useCommandProject } from "../fixtures/command-project.js";
import { withStack } from "../fixtures/stack-harness.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import type { Page } from "../../packages/wiki/src/pages/list.js";
import { writePage } from "../fixtures/write-page.js";

const project = useCommandProject("approve-links-");

/** The candidate's slug, namespace `concepts`. */
const SLUG = "approved-links";
/** Its title, which is also the self-reference a body may name. */
const TITLE = "Approved Links";
/** The `queries/` page the valid link points at. */
const QUERY_SLUG = "saved";
/**
 * The one link every happy-path body carries: a real target in the `queries`
 * namespace, named by bare slug (the form the wiki's own citation gate recognises
 * and the form the shared target resolver maps to `queries/saved`).
 */
const VALID_LINK = `[[${QUERY_SLUG}|Saved Query]]`;

/**
 * A candidate body: frontmatter the approval validates, then the valid link and
 * whatever else the case is about.
 *
 * @param extra - Markdown appended after the paragraph, or empty.
 * @returns Full page markdown, as a staged candidate holds it.
 */
function candidateBody(extra = ""): string {
  return `---\ntitle: ${TITLE}\n---\n\n# ${TITLE}\n\nSee ${VALID_LINK} for the details.${extra}\n`;
}

/**
 * Seed the `queries/` page the approved body links to, in BOTH backends.
 *
 * The ROW is what this suite is about: the approval writes rows, so the page the
 * link must resolve against has to be a row of the same corpus.
 *
 * The FILE is a precondition of a different gate that runs before the page is
 * written, not a page of this wiki: `checkCandidatePublication` refuses a candidate
 * with "broken citation targets" using a FILE-ONLY citation index
 * (`collectAnswerCitationIndex`), so on a Stack with no `wiki/` on disk every
 * candidate link is refused before the link gate is ever reached. That is
 * pre-existing behaviour outside this task's surfaces; seeding the file keeps the
 * case measuring the link decision instead of that admission check.
 *
 * @param harness - The Stack to seed.
 */
async function seedQueriesPage(harness: KgPostgresHarness): Promise<void> {
  await upsertStoredPage(harness.db, harness.stackId, {
    slug: QUERY_SLUG,
    pageDirectory: "queries",
    title: "Saved Query",
    summary: "",
    tags: [],
    links: [],
    orphaned: false,
    archived: false,
    body: "A saved query can be rerun.",
  });
  await mkdir(path.join(project.root, "wiki", "queries"), { recursive: true });
  await writePage(
    path.join(project.root, "wiki", "queries"), QUERY_SLUG, { title: "Saved Query" },
    "A saved query can be rerun.",
  );
}

/**
 * Approve one candidate on a fresh Stack and hand back the page it wrote.
 *
 * @param body - The candidate body to approve.
 * @returns The stored page, or undefined when the approval wrote nothing.
 */
async function approveOnStack(body: string): Promise<Page | undefined> {
  return await withStack("approve-links", async (harness) => {
    await seedQueriesPage(harness);
    return await withStackEnv(harness, async () => {
      const candidate = await writeCandidate(project.root, process.env, {
        title: TITLE, slug: SLUG, summary: "", sources: [], body,
      });
      // Imported here rather than at module scope so the command graph binds to the
      // environment this Stack installs, exactly as the rows-only approve suite does.
      const { default: reviewApproveCommand } = await import("../../packages/wiki/src/commands/review-approve.js");
      await reviewApproveCommand(candidate.id);
      // Precondition asserted by the caller: an approval that bailed out early
      // satisfies no-link claims for a reason unrelated to the page set.
      return await getStoredPage(harness.db, harness.stackId, "concepts", SLUG);
    });
  });
}

/**
 * Run `body` with this Stack's id installed in the environment.
 *
 * @param harness - The Stack to bind.
 * @param body - Work to run under that binding.
 * @returns Whatever `body` produced.
 */
async function withStackEnv<T>(harness: KgPostgresHarness, body: () => Promise<T>): Promise<T> {
  const saved = process.env["AKS_STACK_ID"];
  process.env["AKS_STACK_ID"] = harness.stackId;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env["AKS_STACK_ID"];
    else process.env["AKS_STACK_ID"] = saved;
  }
}

describe("review approve — links are judged against the full page set", () => {
  it("A1 keeps an approved link whose target lives in the queries namespace", async () => {
    const page = await approveOnStack(candidateBody());

    expect(process.exitCode ?? 0).toBe(0);
    expect(page?.body ?? "").toContain(VALID_LINK);
  });

  it("A2 enforces the rules too: a self-reference and a repeat are demoted", async () => {
    const extra = `\n\nAgain: ${VALID_LINK}, and self: [[${SLUG}|${TITLE}]].`;
    const page = await approveOnStack(candidateBody(extra));

    const stored = page?.body ?? "";
    // Precondition: the approval really wrote the page.
    expect(process.exitCode ?? 0).toBe(0);
    // The anchored link survives, ONCE: the repeat in the same section is redundant.
    expect(stored).toContain(VALID_LINK);
    expect(stored.match(/\[\[saved\|/gu) ?? []).toHaveLength(1);
    // The redundant repeat keeps its words and loses its markup.
    expect(stored).toContain("Again: Saved Query");
    // Self-reference: refused by the same rule the compile path applies.
    expect(stored).toContain("self: Approved Links.");
    expect(stored).not.toContain(`[[${SLUG}|`);
  });
});

describe("review approve — the file-backed behaviour is unchanged", () => {
  it("A3 approves with the same exit code, messages and page bytes", async () => {
    const body = `---\ntitle: ${TITLE}\n---\n\n# ${TITLE}\n\nBody with no links.\n`;
    const candidate = await writeCandidate(project.root, process.env, {
      title: TITLE, slug: SLUG, summary: "", sources: [], body,
    });
    const { default: reviewApproveCommand } = await import("../../packages/wiki/src/commands/review-approve.js");

    await reviewApproveCommand(candidate.id);

    const pagePath = path.join(project.root, CONCEPTS_DIR, `${SLUG}.md`);
    const printed = vi.mocked(console.log).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(process.exitCode ?? 0).toBe(0);
    expect(printed).toContain("Approved → ");
    expect(printed).toContain(pagePath);
    expect(printed).toContain(`Candidate ${candidate.id} cleared.`);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(await readFile(pagePath, "utf-8")).toBe(body);
  });
});
