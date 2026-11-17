/**
 * @file test/dimensions/default-stack-both-dimensions.test.ts
 * @description A checkout that names ONE Stack still writes both dimensions into that
 * one Stack: the id is resolved once and the same value is handed to each.
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
 * Step 1 of the scenario is the command's own resolution, so the case runs it against
 * a real handle rather than a stub. It used to be the site of a defect: the scenario
 * was "no Stack configured", and step 1 materialized a default Stack. That Stack is
 * gone (S1 of `odd/tasks/stack-authority-per-request.md` — nothing is created
 * implicitly), so the case now NAMES the Stack it owns, exactly as an operator would
 * after `POST /stacks`. The property under test is unchanged and is why the file
 * survives the deletion: whichever Stack a run works on, both dimensions must be
 * built with that SAME id.
 *
 * Never operator data: every handle here comes from `testDatabaseUrl()`, and the
 * Stack is the harness's own, removed by its cleanup.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

import { AKS_STACK_ID_ENV_VAR, DIMENSIONS_ENV_VAR } from "../../packages/wiki/src/dimensions/activation.js";
import { resolveDimensions } from "../../packages/wiki/src/dimensions/index.js";
import type { KgDimensionOptions } from "../../packages/wiki/src/dimensions/kg/index.js";
import type { WikiStoreDimensionOptions } from "../../packages/wiki/src/dimensions/wiki/database.js";
import { resolveStackForCommand } from "../../packages/wiki/src/services/stacks/resolve-stack.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

/**
 * The Stack id each factory was called with, in call order.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above the imports and would
 * otherwise close over an uninitialized binding.
 */
const builtWith = vi.hoisted(() => ({ wiki: [] as string[], kg: [] as string[] }));

vi.mock("../../packages/wiki/src/dimensions/wiki/database.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../packages/wiki/src/dimensions/wiki/database.js")>();
  return {
    ...actual,
    createWikiStoreDimension: (options: WikiStoreDimensionOptions) => {
      builtWith.wiki.push(options.stackId);
      return actual.createWikiStoreDimension(options);
    },
  };
});

vi.mock("../../packages/wiki/src/dimensions/kg/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/wiki/src/dimensions/kg/index.js")>();
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
 * The environment a deployment has once it has created its one Stack: a reachable
 * database, the switch, and the Stack's id — the id an operator would copy out of
 * the `POST /stacks` response.
 */
function namedStackEnv(): NodeJS.ProcessEnv {
  return {
    AKS_DATABASE_URL: testDatabaseUrl(),
    [DIMENSIONS_ENV_VAR]: "wiki,kg",
    [AKS_STACK_ID_ENV_VAR]: harness.stackId,
  };
}

describe.skipIf(!reachable)("both dimensions on a deployment that named one Stack", () => {
  it("hands wiki and kg the same resolved Stack id", async () => {
    const env = namedStackEnv();
    // The scenario itself, asserted rather than assumed: the Stack is NAMED, and
    // nothing resolves it from a default that does not exist any more.
    expect(env[AKS_STACK_ID_ENV_VAR]).toBe(harness.stackId);

    // 1. The command's Stack, resolved the way the CLI resolves it.
    const stackId = await resolveStackForCommand(db, env);
    expect(stackId).toBe(harness.stackId);

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
