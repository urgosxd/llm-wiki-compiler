/**
 * @file test/lint-honours-request-env.test.ts
 * @description A lint run must use the Stack it is HANDED, not the one the process
 * happens to be bound to.
 *
 * WHY THIS EXISTS
 *
 * The MCP `lint_wiki` tool takes a `stackId` argument and resolves a per-request
 * environment with `withRequestEnv`, which builds `{...process.env, AKS_STACK_ID}`
 * and never assigns into `process.env` — so two concurrent requests cannot see each
 * other's tenant.
 *
 * The linter resolved its corpus from the ambient `process.env` regardless. That
 * made the argument decorative: on a process bound to Stack A, a request for Stack B
 * was linted against A, and nothing said so. This is the same defect the compile
 * side had (see `0162da5`) and it is worse here, because lint is the surface a user
 * asks "is my wiki healthy" about.
 *
 * The test drives the real entry point with a per-request env and asserts the corpus
 * came from THAT env's Stack.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import * as seam from "../src/dimensions/wiki/page-source-seam.js";
import * as freshness from "../src/freshness/index.js";
import * as profile from "../src/profile/load.js";
import { lint, lintByTier } from "../src/linter/index.js";
import type { RawWikiPage } from "../src/wiki/collect.js";
import { stackProjectRoot } from "./fixtures/lint-row-corpus.js";

let dir: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** The Stack the request names. A real UUID: a synthetic id fails at the driver. */
const REQUESTED_STACK = "22222222-2222-4222-8222-222222222222";

/** A third Stack, so "no corpus" is not confused with "the ambient one". */
const OTHER_STACK = "33333333-3333-4333-8333-333333333333";

/** The Stack this "process" is bound to, distinct from the one the request names. */
const AMBIENT_STACK = "11111111-1111-4111-8111-111111111111";

/** A page with an empty body, so any corpus that is read produces a finding. */
function emptyBodyPage(slug: string): RawWikiPage {
  return {
    slug,
    pageDirectory: "concepts",
    filePath: `/virtual/wiki/concepts/${slug}.md`,
    title: slug,
    frontmatter: { title: slug, summary: "s" },
    body: "",
    parseStatus: {
      hasFrontmatterBlock: true,
      malformedFrontmatter: false,
      hasTitle: true,
      orphaned: false,
    },
  };
}

/**
 * Stub the page source so it answers ONLY for the Stack named here.
 *
 * A request carrying any other Stack sees no corpus at all — which is exactly the
 * observable difference between "used the env it was given" and "used the ambient one".
 *
 * @param honouredStackId - The Stack whose corpus this seam will serve.
 */
function serveOnlyStack(honouredStackId: string): void {
  vi.spyOn(seam, "withRawPageSource").mockImplementation(async (_root, env, fn) => {
    const stackId = env.AKS_STACK_ID ?? "";
    return await fn(
      stackId === honouredStackId
        ? { collect: async () => [emptyBodyPage("only-page")] }
        : undefined,
    );
  });
  // The freshness snapshot opens the same Stack independently; stub it to answer
  // "no rows" so the test exercises the CORPUS resolver and never reaches Postgres
  // with a synthetic stack id.
  vi.spyOn(freshness, "buildProjectFreshnessSnapshot").mockResolvedValue({
    stateStatus: "missing",
    sources: {},
  });
  vi.spyOn(seam, "withSourceDocuments").mockImplementation(
    async (_env, fn) => await fn(undefined),
  );
  // The profile lint family counts review candidates in Postgres. This test is about
  // the PAGE corpus resolver, so the family is emptied rather than reached: a generic
  // project has no profile, and stubbing says that without opening a connection.
  vi.spyOn(profile, "loadProfile").mockResolvedValue({
    loadedFrom: null,
    profile: undefined,
    digest: "",
  } as unknown as Awaited<ReturnType<typeof profile.loadProfile>>);
}

describe("lint honours the env it is handed", () => {
  it("reads the corpus of the request's Stack, not the ambient one", async () => {
    dir = await stackProjectRoot("lint-env");
    vi.stubEnv("AKS_STACK_ID", AMBIENT_STACK);
    serveOnlyStack(REQUESTED_STACK);

    const summary = await lint(dir, {
      ...process.env,
      AKS_STACK_ID: REQUESTED_STACK,
    });

    // The corpus exists only for the requested Stack, so any finding proves the
    // request env reached the resolver.
    expect(summary.errors + summary.warnings).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it("reads nothing when the handed Stack has no corpus, even though the ambient one does", async () => {
    dir = await stackProjectRoot("lint-env-negative");
    vi.stubEnv("AKS_STACK_ID", AMBIENT_STACK);
    // Only the AMBIENT stack has pages. A linter that follows the request env must
    // therefore see none of them.
    serveOnlyStack(AMBIENT_STACK);

    const report = await lintByTier(dir, {
      ...process.env,
      AKS_STACK_ID: OTHER_STACK,
    });

    expect(report.deterministic).toEqual([]);
    vi.unstubAllEnvs();
  });
});
