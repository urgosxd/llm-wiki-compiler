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
 *
 * ## Why this file owns its database
 *
 * It reads like a pure unit suite and is not one: `lint` and `lintByTier` reach Postgres
 * through `packages/wiki/src/linter/cache.ts` — `createDimensionsDatabase(env)` at `:172`,
 * and at `:191` a call with NO argument, which means it reads `AKS_DATABASE_URL` straight
 * from `process.env`. Nothing here chose WHICH database carried those rows, so the suite
 * read the run's shared database or a developer's long-lived server. Measured: pointed at
 * an unreachable DSN it fails with `connect ECONNREFUSED`, so the connection is real and
 * its target was inherited rather than owned.
 *
 * So the redirect happens in THIS module's scope, before the lint run can read the value:
 * `perRunDatabase()` mints a throwaway database, builds the schema in it, and publishes its
 * URL into the environment. What this file PROVES is unchanged — the corpus must come from
 * the Stack the request NAMES — because the seams that decide the corpus are stubbed either
 * way; what changes is where the incidental rows land. `lint-honours-request-env-isolation.test.ts`
 * pins the rule from the outside.
 *
 * ## Why a failed provision never falls back to shared state
 *
 * Same rule as the other database-backed suites: FAIL when no database can be obtained, with
 * one documented exception — `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` turns that failure into a
 * skip that states its reason. Both paths go through `missingTestDatabase`, the one place
 * that words it, so this file cannot drift into a third behaviour.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import * as seam from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import * as freshness from "../packages/wiki/src/freshness/index.js";
import * as profile from "../packages/wiki/src/profile/load.js";
import { lint, lintByTier } from "../packages/wiki/src/linter/index.js";
import type { RawWikiPage } from "../packages/wiki/src/wiki/collect.js";
import { stackProjectRoot } from "./fixtures/lint-row-corpus.js";
import { ownSuiteDatabase } from "./fixtures/suite-database-ownership.js";

/** This file's path, so a "no database" failure points here and not at a fixture. */
const DATABASE_CONTEXT = "test/lint-honours-request-env.test.ts";

/**
 * Why the lint cases cannot run, or `""` when they can.
 *
 * Module scope, not a hook: the lint run reaches `createDimensionsDatabase()` inside a test
 * body, and `AKS_DATABASE_URL` has to already name this process's database when it does.
 */
const databaseSkipReason = await ownSuiteDatabase(DATABASE_CONTEXT);

/** The lint cases, skipped only for the one reason above. */
const itWithDatabase = it.skipIf(databaseSkipReason !== "");

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
  itWithDatabase("reads the corpus of the request's Stack, not the ambient one", async () => {
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

  itWithDatabase(
    "reads nothing when the handed Stack has no corpus, even though the ambient one does",
    async () => {
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
    },
  );
});
