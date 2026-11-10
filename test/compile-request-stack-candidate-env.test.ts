/**
 * @file test/compile-request-stack-candidate-env.test.ts
 * @description T2 — the review candidate belongs to the Stack the REQUEST names.
 *
 * ## The defect this pins
 *
 * The candidate and pages seams resolved their tenant as `(process.env[AKS_STACK_ID]
 * ?? "").trim()` at every call site, so running inside request-scoped code they named
 * the DEPLOYMENT rather than the request. `persistReviewCandidate` reaches
 * `writeCandidate`, and `createWikiCore` reaches `withPageSource`; neither had the
 * request's environment in lexical scope, so both used `process.env`. ONE process
 * serving MANY Stacks — a different `options.env` per request — staged its candidate
 * into the ambient tenant while its pages, lock and journal went to the request's.
 *
 * ## Why the ambient half is the assertion that bites
 *
 * "The request's Stack received the candidate" is TRUE of a run that also wrote the
 * ambient Stack, and that is the bug. So the ambient tenant's rows are snapshotted
 * through the shared helper (`test/fixtures/tenant-snapshot.ts`) before the run and
 * compared byte-for-byte afterwards. S9's framing: the defect is the displacement at
 * B, not the absence at A — a fix that only mirrored the write into A would leave the
 * leak in place and must fail here.
 *
 * ## Why the read case seeds BOTH Stacks
 *
 * A read case seeded in the ambient Stack ALONE cannot tell a correct read from a
 * broken one: "did not return B's row" is also satisfied by a read that returns
 * nothing at all. Seeding the same slug in both tenants under different titles makes
 * the assertion two-sided — the correct title and the wrong one are both observable,
 * so neither an always-ambient read nor an always-empty read can pass.
 *
 * ## Why T10 reaches for the LIVE-WRITE branch
 *
 * `generateMergedPage` resolves the request env ONCE and hands it to two consumers:
 * `persistReviewCandidate` and, on the branch where the page is written instead of
 * staged, `deleteCandidateBySlug`. The candidate branch is what the rest of this file
 * exercises, so that second consumer had no assertion of its own — an inverse edit that
 * dropped the resolved env failed exactly the same assertions whether or not it also
 * reached the delete. T10 closes that by making the run take the live-write branch and
 * seeding a candidate in the REQUEST's Stack for the live write to clear.
 *
 * Reaching that branch needs a page that the review policy LETS THROUGH, and the
 * fixture's default (a Stack with no config row) is policy-off, where `evaluatePolicy`
 * lets anything through and the provenance signal is decorative. So T10 gives Stack A a
 * policy that HOLDS on `provenance-violating` and then satisfies it honestly: the
 * provenance rule reads `sources/` ON DISK while this fixture's corpus is ROWS, so the
 * cited document is written to both. With the disk copy missing the page is held and the
 * delete never runs, which is precisely what `expect(report.candidates ?? [])` catches.
 *
 * The Stack pair, the ambient environment binding, the teardown and the seed corpus
 * (`seedConceptPage`, `draftFor`, `holdOnProvenanceViolations`) live in
 * `test/fixtures/request-stack.ts`, shared with the sibling request-stack suites.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import {
  listCandidates,
  listCandidatePage,
  readCandidate,
  readCandidateBySlug,
  writeCandidate,
} from "../packages/wiki/src/compiler/candidates.js";
import { lint } from "../packages/wiki/src/linter/index.js";
import { createPageWriteSink } from "../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { createWikiCore } from "../packages/wiki/src/sdk/core.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import type { WikiCore } from "../packages/wiki/src/sdk/core-types.js";
import { EMPTY_CATEGORY_ANSWER, isCategoryAssignmentCall } from "./fixtures/provider-calls.js";
import {
  draftFor,
  holdOnProvenanceViolations,
  PROVENANCE_CITED_SOURCE,
  seedConceptPage,
  seedSharedPage,
  useRequestStacks,
} from "./fixtures/request-stack.js";
import { assertTenantUnchanged, snapshotTenantRows } from "./fixtures/tenant-snapshot.js";

/** The one source the compile extracts into a reviewed page. */
const SOURCE = {
  title: "Candidate Env Topic",
  source: "https://candidate-env.test/topic",
  document: "# Candidate Env Topic\n\nSource content for the request Stack.\n",
};

/** The concept the stub extraction returns, and so the candidate's title. */
const CONCEPT = "Candidate Env Topic";

/** The slug `writeCandidate` derives from a concept of that title. */
const SLUG = "candidate-env-topic";

/** The page slug seeded into both tenants for the read case, under different titles. */
const SHARED_SLUG = "alpha";

/**
 * A page that links to one slug pending in each tenant, and to nothing else.
 *
 * The frontmatter is complete on purpose: the two diagnostics asserted in T9.a name
 * `[[alpha-target]]` and `[[beta-target]]`, so every other rule must stay quiet or its
 * findings would have to be filtered out by rule id rather than by the link they are
 * about.
 */
const LINKER_BODY = [
  "---",
  "title: Linker",
  "summary: Links to both queues.",
  "sources: []",
  "---",
  "",
  "This page links to [[alpha-target]] and also to [[beta-target]].",
  "",
  "Enough body text to keep the empty-page rule quiet, so neither finding below is",
  "an artefact of an otherwise empty page.",
].join("\n");

/**
 * The title the SDK facade reports for one page, or `undefined` when it reports none.
 *
 * A helper because the question every SDK assertion here asks is WHICH tenant answered,
 * and the three possible answers — the request's title, the ambient one, and nothing at
 * all — have to stay distinguishable.
 *
 * @param core - A facade bound to a root and, or not, an environment.
 * @param slug - The page to read.
 * @returns Its title, or `undefined` when the facade found no page.
 */
async function sdkTitle(core: WikiCore, slug: string): Promise<string | undefined> {
  const page = (await core.getPage({ pageDirectory: "concepts", slug })) as {
    title: string;
  } | null;
  return page?.title;
}

/** Stub the provider boundary only: extraction and the generated page body. */
function stubProvider(): void {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (...args: unknown[]) =>
      isCategoryAssignmentCall(args)
        ? EMPTY_CATEGORY_ANSWER
        : JSON.stringify({ concepts: [{ concept: CONCEPT, summary: "S.", is_new: true }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body. ^[topic.md]\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("the review candidate follows the request's Stack", () => {
  const stacks = useRequestStacks({
    request: "request-candidate-env",
    ambient: "ambient-candidate-env",
    root: "request-candidate-env-",
  });

  /** The ambient tenant's rows as they stand now, for the snapshot comparisons below. */
  const ambientSnapshot = (): Promise<Record<string, readonly string[]>> =>
    snapshotTenantRows(stacks.ambient.harness, stacks.ambientStackId);

  it("T2.a stages the candidate in the request's Stack and leaves the ambient Stack byte-identical", async () => {
    // A policy hold is the lever, not the removed compile option: Stack A holds pages
    // whose citations are broken, and the stub body cites a document this project does
    // not have. The page therefore reaches the SAME candidate seam its policy always
    // reached, and `options.review` is gone from the call entirely.
    await holdOnProvenanceViolations(stacks.request.harness, stacks.requestStackId);
    stubProvider();
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    await seedConceptPage(stacks.ambient.harness, stacks.ambientStackId, SHARED_SLUG, "Ambient Only");
    const before = await ambientSnapshot();
    // Not a comparison of empties: the helper has to SEE the ambient tenant's rows, or
    // "unchanged" below would be satisfied by a snapshot that captured nothing at all.
    expect(before["wiki.pages"]).toHaveLength(1);

    const report = await compileAndReport(stacks.root, {
      embeddings: false, env: stacks.env,
    });
    expect(report).toMatchObject({ errors: [] });

    // The half that bites: one tenant's candidate must never land in another's rows.
    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
    expect((await listCandidates(stacks.root, {}, stacks.env)).map((candidate) => candidate.slug))
      .toEqual([SLUG]);
  });

  it("T2.b stores a real candidate in the request's Stack instead of nowhere", async () => {
    await holdOnProvenanceViolations(stacks.request.harness, stacks.requestStackId);
    stubProvider();
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);

    const report = await compileAndReport(stacks.root, { embeddings: false, env: stacks.env });
    expect(report).toMatchObject({ errors: [] });

    const staged = await listCandidates(stacks.root, {}, stacks.env);
    expect(staged).toHaveLength(1);
    const [candidate] = staged;
    // Content, not a count: an empty candidate or one staged under a placeholder id
    // would pass a presence check and fail the reader that asked for this slug.
    expect(candidate).toMatchObject({ title: CONCEPT, slug: SLUG });
    expect(candidate.id.startsWith(`${SLUG}-`)).toBe(true);
    expect(candidate.body).toContain(CONCEPT);
    // And the ambient tenant holds no candidate at all, so the write is not duplicated.
    expect(await listCandidates(stacks.root, {}, stacks.ambientEnv)).toEqual([]);
  });

  it("T2.c reads through the request's Stack, not the ambient one", async () => {
    await seedSharedPage(stacks, SHARED_SLUG, "Alpha At Request", "Alpha At Ambient");
    const before = await ambientSnapshot();
    const wiki = createWikiCore({ root: stacks.root, env: stacks.env });

    const page = (await wiki.getPage({ pageDirectory: "concepts", slug: SHARED_SLUG })) as {
      title: string;
    } | null;

    // Both directions: the ambient title proves the read was displaced, and the request
    // title proves a read that returned nothing would not have passed either.
    expect(page?.title).not.toBe("Alpha At Ambient");
    expect(page?.title).toBe("Alpha At Request");
    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T3.a reads one candidate through the Stack the env names, not the one holding it", async () => {
    // SEEDED IN B ONLY, then read with env naming A. Both directions are asserted:
    // the row IS readable when B is named, so the `null` below is a statement about
    // the environment rather than about a candidate nobody ever stored.
    const ambientOnly = await writeCandidate(
      stacks.root, stacks.ambientEnv, draftFor("Ambient Only", "ambient-only"),
    );
    const before = await ambientSnapshot();
    expect(await readCandidate(stacks.root, stacks.ambientEnv, ambientOnly.id)).not.toBeNull();
    expect(await readCandidate(stacks.root, stacks.env, ambientOnly.id)).toBeNull();

    // POSITIVE CONTROL: A's own candidate IS returned when A is named, and B cannot
    // see it either — so neither an always-ambient read nor an always-empty read passes.
    const requestOnly = await writeCandidate(
      stacks.root, stacks.env, draftFor("Request Only", "request-only"),
    );
    expect((await readCandidate(stacks.root, stacks.env, requestOnly.id))?.slug).toBe("request-only");
    expect(await readCandidate(stacks.root, stacks.ambientEnv, requestOnly.id)).toBeNull();

    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T3.b pages the queue of the Stack the env names, not the ambient one", async () => {
    const ambientOnly = await writeCandidate(
      stacks.root, stacks.ambientEnv, draftFor("Ambient Queue", "ambient-queue"),
    );
    expect(ambientOnly.slug).toBe("ambient-queue");
    const before = await ambientSnapshot();

    // The ambient page proves the row is reachable at all; the request page must not
    // contain it and must report A's own (empty) depth.
    expect((await listCandidatePage(stacks.root, stacks.ambientEnv, 10)).candidates.map((entry) => entry.slug))
      .toEqual(["ambient-queue"]);
    expect((await listCandidatePage(stacks.root, stacks.env, 10)).candidates.map((entry) => entry.slug))
      .toEqual([]);
    expect((await listCandidatePage(stacks.root, stacks.env, 10)).total).toBe(0);

    // POSITIVE CONTROL: A's own candidate is served, and B's queue is still its own.
    await writeCandidate(stacks.root, stacks.env, draftFor("Request Queue", "request-queue"));
    expect((await listCandidatePage(stacks.root, stacks.env, 10)).candidates.map((entry) => entry.slug))
      .toEqual(["request-queue"]);
    expect((await listCandidatePage(stacks.root, stacks.ambientEnv, 10)).candidates.map((entry) => entry.slug))
      .toEqual(["ambient-queue"]);

    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T9.a lints against the request's pending queue, not the ambient Stack's", async () => {
    // ONE page, in the request's Stack only, linking to one slug pending in each
    // tenant. The queues are DISJOINT, so the diagnostic each link receives names the
    // queue the linter actually read — nothing here depends on a count.
    await createPageWriteSink(stacks.request.harness.db, stacks.requestStackId)({
      directory: "concepts", slug: "linker", body: LINKER_BODY,
    });
    await writeCandidate(stacks.root, stacks.env, draftFor("Alpha Target", "alpha-target"));
    await writeCandidate(stacks.root, stacks.ambientEnv, draftFor("Beta Target", "beta-target"));
    const before = await ambientSnapshot();

    const summary = await lint(stacks.root, stacks.env);
    const rulesFor = (target: string): string[] =>
      summary.results
        .filter((result) => result.message.includes(`[[${target}]]`))
        .map((result) => result.rule);

    // The half that bites: `beta-target` is pending in the AMBIENT Stack alone, and a
    // lint that resolved its queue from `process.env` reports it as awaiting review —
    // erasing a genuinely broken link from the error count.
    expect(rulesFor("beta-target")).toEqual(["broken-wikilink"]);
    // POSITIVE CONTROL: a candidate in the REQUEST's own queue demotes its link to
    // information, so a linter that read no queue at all would fail here too.
    expect(rulesFor("alpha-target")).toEqual(["pending-target"]);

    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T10.a the live write clears the request Stack's candidate and leaves the ambient Stack byte-identical", async () => {
    stubProvider();
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    const cited = PROVENANCE_CITED_SOURCE;
    await writeFile(path.join(stacks.root, "sources", cited.filename), cited.text, "utf8");
    // The policy that makes the live-write branch a real gate rather than a default: the
    // page must survive a hold-on-provenance policy to be written instead of staged.
    await holdOnProvenanceViolations(stacks.request.harness, stacks.requestStackId);

    // The candidate the live write must clear, in the REQUEST's Stack. Its slug is the one
    // the generated page is published under, which is the only slug the delete names.
    const stale = await writeCandidate(stacks.root, stacks.env, draftFor("Stale Candidate", SLUG));
    // The SAME slug staged in the AMBIENT Stack, so a delete displaced onto B is observable
    // as a REMOVAL there and not as "nothing happened at B either".
    await writeCandidate(stacks.root, stacks.ambientEnv, draftFor("Ambient Twin", SLUG));
    await seedConceptPage(stacks.ambient.harness, stacks.ambientStackId, SHARED_SLUG, "Ambient Only");
    const before = await ambientSnapshot();
    // Not a comparison of empties, for the reason T2.a gives — and the candidate row has to
    // be visible too, or the unchanged-tenant claim below would miss a displaced delete.
    expect(before["wiki.pages"]).toHaveLength(1);
    expect(before["wiki.review_candidates"]).toHaveLength(1);

    const report = await compileAndReport(stacks.root, {
      embeddings: false, env: stacks.env,
    });
    expect(report).toMatchObject({ errors: [] });
    // The fixture's own precondition: nothing was staged, so the page took the LIVE-WRITE
    // branch and `deleteCandidateBySlug` above really ran. A page held by the policy would
    // make every assertion below vacuous.
    expect(report.candidates ?? []).toEqual([]);

    // (i) The request's Stack no longer holds the candidate the live write replaced, and
    // holds the page it published in its place.
    expect(await readCandidate(stacks.root, stacks.env, stale.id)).toBeNull();
    expect(await listCandidates(stacks.root, {}, stacks.env)).toEqual([]);
    expect(await sdkTitle(createWikiCore({ root: stacks.root, env: stacks.env }), SLUG)).toBe(CONCEPT);

    // (ii) The ambient Stack is byte-identical: neither its twin candidate nor its page
    // moved, which is the half a displaced delete cannot satisfy.
    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T5.a omitting env targets the ambient Stack, while env names the request Stack", async () => {
    // The SAME slug in both tenants under DIFFERENT titles, so the contract's two halves are
    // both observable in one place: which title comes back identifies the tenant that
    // answered, and neither an always-ambient nor an always-empty read passes both.
    await seedSharedPage(stacks, SHARED_SLUG, "Alpha At Request", "Alpha At Ambient");
    const before = await ambientSnapshot();
    expect(before["wiki.pages"]).toHaveLength(1);

    // HALF ONE — `CreateWikiOptions.env` omitted is a DELIBERATE contract, not an accident
    // of inheritance: the SDK targets the AMBIENT Stack. Asserted by identity, so a fallback
    // that became "no stack at all" answers `undefined` and one that became "A" answers the
    // request's title; both fail here.
    expect(await sdkTitle(createWikiCore({ root: stacks.root }), SHARED_SLUG)).toBe("Alpha At Ambient");
    // HALF TWO — the contrast, in the same test: naming A answers from A.
    expect(await sdkTitle(createWikiCore({ root: stacks.root, env: stacks.env }), SHARED_SLUG))
      .toBe("Alpha At Request");

    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });

  it("T9.b reads a candidate by slug through the Stack the env names", async () => {
    const ambientOnly = await writeCandidate(
      stacks.root, stacks.ambientEnv, draftFor("Ambient Only", "ambient-only"),
    );
    const requestOnly = await writeCandidate(
      stacks.root, stacks.env, draftFor("Request Only", "request-only"),
    );
    const before = await ambientSnapshot();

    // Two-sided, for the reason T3.a gives: the ambient row IS readable when B is
    // named, so the `null` below is a statement about the environment rather than
    // about a candidate nobody ever stored.
    expect((await readCandidateBySlug(stacks.root, stacks.ambientEnv, "ambient-only"))?.id)
      .toBe(ambientOnly.id);
    expect(await readCandidateBySlug(stacks.root, stacks.env, "ambient-only")).toBeNull();
    // POSITIVE CONTROL: A's own row is returned when A is named, and B cannot see it.
    expect((await readCandidateBySlug(stacks.root, stacks.env, "request-only"))?.id)
      .toBe(requestOnly.id);
    expect(await readCandidateBySlug(stacks.root, stacks.ambientEnv, "request-only")).toBeNull();

    assertTenantUnchanged(before, await ambientSnapshot(), "Stack B (ambient)");
  });
});
