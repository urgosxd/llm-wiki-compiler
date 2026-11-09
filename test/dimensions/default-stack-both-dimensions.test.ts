/**
 * @file test/dimensions/default-stack-both-dimensions.test.ts
 * @description A checkout that configured NO Stack still writes both dimensions into
 * ONE Stack: the id is resolved once and the same value is handed to each.
 *
 * ## The gap this file closes
 *
 * The single-resolution guarantee lives in the write path —
 * `services/ingest/service.ts` resolves the Stack once and hands the identical value
 * to `ingestDimensions` and to `resolveDimensions` — and it is the property that stops
 * a job row and a document landing in DIFFERENT Stacks. Nothing asserted it:
 *
 *   - `test/services/ingest/default-stack-ingest.test.ts` covers the default Stack for
 *     `wiki` only; no `kg` dimension is ever built.
 *   - `test/dimensions/stack-selection.test.ts` passes an EXPLICIT Stack id and asserts
 *     only the dimension-name array, so it would stay green if the two dimensions were
 *     built with two different ids.
 *
 * So the scenario a reader would take for granted — nothing configured, both dimensions
 * enabled — was untested at exactly the point where the ids must agree.
 *
 * ## Why the ids are observed by spying on the factories
 *
 * The `Dimension` port exposes its identity as `name` and nothing else: the Stack a
 * dimension writes to is captured at construction (`options.stackId`) and never
 * republished, because a caller-visible tenant is a tenant a caller can pass wrongly.
 * There is therefore no public field to read the binding back from. The observation
 * that is still honest is the one at the seam where the answer is DECIDED: the two
 * factories `activation.ts` calls, wrapped so each records the id its dimension was
 * BUILT with and then delegates to the real implementation. That is the value the
 * dimension will use for every `stack_id`, not an internal call count.
 *
 * ## Why the real database is used, and what it leaves behind
 *
 * Step 1 of the scenario is the command's own resolution, so the default Stack has to
 * be genuinely materialized — `ensureDefaultStack` is a real write, and stubbing it
 * would mean asserting on a stub. The `default` domain is a single global row
 * (`stacks.domain` is unique), so there is no per-suite slice to own: like
 * `default-stack-ingest.test.ts`, this case asserts through real rows and leaves that
 * one row in place rather than deleting a row another suite may be using.
 *
 * Never operator data: every handle here comes from `testDatabaseUrl()`.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { DIMENSIONS_ENV_VAR } from "../../src/dimensions/activation.js";
import { resolveDimensions } from "../../src/dimensions/index.js";
import { DEFAULT_STACK_DOMAIN } from "../../src/dimensions/stack-selection.js";
import type { KgDimensionOptions } from "../../src/dimensions/kg/index.js";
import type { WikiStoreDimensionOptions } from "../../src/dimensions/wiki/database.js";
import type { Database } from "@repo/kg";
import { resolveStackForCommand } from "../../src/services/stacks/resolve-stack.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

/**
 * The Stack id each factory was called with, in call order.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports and would
 * otherwise close over an uninitialized binding.
 */
const builtWith = vi.hoisted(() => ({ wiki: [] as string[], kg: [] as string[] }));

vi.mock("../../src/dimensions/wiki/database.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/dimensions/wiki/database.js")>();
  return {
    ...actual,
    createWikiStoreDimension: (options: WikiStoreDimensionOptions) => {
      builtWith.wiki.push(options.stackId);
      return actual.createWikiStoreDimension(options);
    },
  };
});

vi.mock("../../src/dimensions/kg/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/dimensions/kg/index.js")>();
  return {
    ...actual,
    createKgDimension: (options: KgDimensionOptions) => {
      builtWith.kg.push(options.stackId);
      return actual.createKgDimension(options);
    },
  };
});

const harness = await createKgPostgresHarness("dimensions-default-stack");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/**
 * The environment a bare checkout has: a reachable database and the switch, and NO
 * Stack id — `AKS_STACK_ID` is deliberately absent rather than blank, so the case
 * covers "not configured" and not only "configured to nothing".
 */
function bareCheckoutEnv(): NodeJS.ProcessEnv {
  return {
    AKS_DATABASE_URL: testDatabaseUrl(),
    [DIMENSIONS_ENV_VAR]: "wiki,kg",
  };
}

/**
 * The id of the row owning the default domain, read back independently of the
 * resolver so the assertion does not trust the value it is checking.
 *
 * @param handle - Handle to read through.
 * @returns The default Stack's id, or undefined when no row carries the domain.
 */
async function defaultStackRowId(handle: Database): Promise<string | undefined> {
  const rows = await handle.execute<{ id: string }>(
    sql`select id from stacks where domain = ${DEFAULT_STACK_DOMAIN}`,
  );
  return rows[0]?.id;
}

describe.skipIf(!reachable)("both dimensions on a checkout with no Stack configured", () => {
  it("hands wiki and kg the same resolved default Stack id", async () => {
    const env = bareCheckoutEnv();
    // The scenario itself, asserted rather than assumed: neither `--stack` (which the
    // CLI forwards as an environment value) nor `AKS_STACK_ID` is set.
    expect(env.AKS_STACK_ID).toBeUndefined();

    // 1. The command's Stack, resolved the way the CLI resolves it.
    const stackId = await resolveStackForCommand(db, env);
    expect(stackId).toBe(await defaultStackRowId(db));

    // 2. The dimensions, built the way the write path builds them: the SAME resolved
    //    id is supplied, which is the property under test.
    const dimensions = resolveDimensions({
      // No dimension reads `root` at construction; it is the post-commit projection
      // target, and nothing is committed here.
      root: "/tmp/project",
      db,
      env,
      stackId,
    });
    expect(dimensions.map((dimension) => dimension.name)).toEqual(["wiki", "kg"]);

    // 3. The id each dimension was BUILT with. A mismatch between these two is a job
    //    row and a document landing in different Stacks.
    const wikiStackId = builtWith.wiki.at(-1);
    const kgStackId = builtWith.kg.at(-1);

    expect(wikiStackId).toBe(stackId);
    expect(kgStackId).toBe(wikiStackId);
  }, 60_000);
});
