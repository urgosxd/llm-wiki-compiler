/**
 * @file test/stack-selection-shared.test.ts
 * @description In-process replacement for the `--stack <id>` cases in
 * `test/cli/stack-option.test.ts` and
 * `test/cli/stack-option-validates-before-any-query.test.ts` (spec S5, group 4).
 *
 * ## The behaviour that had to outlive the flag
 *
 * `applyStackOption` refused a value the run could not honour so a typo could
 * never write a caller's documents into whatever Stack the default selection
 * named. The rule was never the flag's: it is composed from three shared pieces,
 * all of which survive the CLI —
 *
 *   1. `stackIdProblem` (`@repo/foundation`) — shape, answered with no database.
 *   2. `selectStack` (`dimensions/stack-selection.ts`) — the ONE precedence
 *      function: flag, then `AKS_STACK_ID`, then the default domain.
 *   3. `stackExists` (`services/stacks/stack-store.ts`) — existence, asked only
 *      once the value can address a row at all.
 *
 * Porting them here rather than re-stating argv assertions is the point: the
 * viewer and the HTTP host accept a caller-named Stack through the same two
 * predicates, so a regression in either is now caught without a process.
 *
 * ## What is deliberately NOT ported
 *
 * Exit codes, empty stdout, the `Using the default Stack` announcement and the
 * refusal's `--stack value "…" is not a Stack id` prose are all produced by the
 * deleted argv handler, and the ordering proof those cases used (a poisoned DSN
 * surfacing as a refusal instead of a connection error) is a property of that
 * handler's call sequence. The message here is asserted only for the parts that
 * survive: the value's name and the word "Stack".
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { stackIdProblem } from "@repo/foundation";
import { selectStack } from "../packages/wiki/src/dimensions/stack-selection.js";
import { stackExists } from "../packages/wiki/src/services/stacks/stack-store.js";
import { createKgPostgresHarness } from "./fixtures/kg-postgres.js";

/** A value that is not a uuid, kept obvious so a failure reads as itself. */
const MALFORMED_STACK = "not-a-uuid";

/** A DSN on a port nothing listens on: any query would fail loudly. */
const UNREACHABLE_DSN = "postgresql://nobody:nobody@127.0.0.1:1/absent";

const harness = await createKgPostgresHarness("stack-selection-shared");
const { reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

describe("a value that cannot address a Stack is refused by shape", () => {
  it("names the refused value and calls it a Stack id, not a connection problem", () => {
    const problem = stackIdProblem(MALFORMED_STACK);
    expect(problem).toContain(MALFORMED_STACK);
    expect(problem).toContain("Stack");
    expect(problem?.toLowerCase()).not.toMatch(/connect|econnrefused/);
  });

  it("answers the same way with a database nothing could reach", () => {
    const saved = process.env.AKS_DATABASE_URL;
    process.env.AKS_DATABASE_URL = UNREACHABLE_DSN;
    try {
      // Shape is decided with no handle at all, which is the ordering the CLI cases
      // proved with a dead DSN: the refusal cannot be a driver error in disguise.
      expect(stackIdProblem(MALFORMED_STACK)).toContain(MALFORMED_STACK);
      expect(stackIdProblem("")).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.AKS_DATABASE_URL;
      else process.env.AKS_DATABASE_URL = saved;
    }
  });

  it("accepts a canonical uuid in any casing", () => {
    expect(stackIdProblem("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(stackIdProblem("B8B8E801-B423-4A32-AB0B-E1EA2D82EAD8")).toBeUndefined();
  });
});

describe("the flag outranks the environment", () => {
  it("selects the flag's Stack even when AKS_STACK_ID names another", () => {
    const flagged = randomUUID();
    const inherited = randomUUID();
    const selection = selectStack({ flag: flagged, env: { AKS_STACK_ID: inherited } });
    expect(selection).toEqual({ kind: "explicit", source: "flag", stackId: flagged });
  });

  it("selects AKS_STACK_ID when no flag was given", () => {
    const inherited = randomUUID();
    const selection = selectStack({ env: { AKS_STACK_ID: inherited } });
    expect(selection).toEqual({ kind: "explicit", source: "env", stackId: inherited });
  });
});

describe.skipIf(!reachable)("an id no Stack carries is unknown, not valid", () => {
  it("reports a well-formed id with no row as not existing, and one with a row as existing", async () => {
    expect(await stackExists(harness.db, randomUUID())).toBe(false);
    expect(await stackExists(harness.db, harness.stackId)).toBe(true);
  });
});
