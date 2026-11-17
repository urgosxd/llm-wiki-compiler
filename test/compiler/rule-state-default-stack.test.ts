/**
 * @file test/compiler/rule-state-default-stack.test.ts
 * @description Rule extraction's cursor advances on the Stack the run NAMES, and the
 * read half finds the same row.
 *
 * ## Why the cursor and not the compile output
 *
 * The rule cursor is the one place where a wrong Stack is silent: the read half and
 * the write half each used to resolve their own Stack id, so a run could read one
 * Stack's cursor and advance another's, which reads as "every source is new" on the
 * next pass. Both halves now resolve through the same call, and this case proves
 * that: the write and the read must land on the same row.
 *
 * The case used to name NO Stack and lean on a default one being materialized. That
 * Stack is deleted by decision (S1 of `odd/tasks/stack-authority-per-request.md` — no
 * Stack is created implicitly), so the environment now names the Stack the harness
 * owns, which is the same thing an operator does after `POST /stacks`. The property
 * under test is untouched; only the way the case obtains its Stack changed.
 *
 * ## Why the environment is passed in
 *
 * `readRuleState` and `updateRuleSourceState` take the environment they resolve with,
 * so the case hands them this one -- a connection string and a Stack id -- rather
 * than mutating `process.env` for every other suite in this worker.
 *
 * ## Teardown
 *
 * The cursor key is randomised per run and the cursor rows for this Stack are removed
 * at the end: a leftover key would make the next run's read return state it never
 * wrote.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { readRuleState, updateRuleSourceState } from "../../packages/wiki/src/compiler/rule-state.js";

const harness = await createKgPostgresHarness("rule-state-default");
const { db, reachable } = harness;

/**
 * The environment this case runs with: a connection and the Stack it owns.
 *
 * The Stack id is a value the operator copies out of `POST /stacks`; it used to be
 * absent, and the default Stack was materialized instead. See the header.
 */
const NAMED_ENV: NodeJS.ProcessEnv = {
  AKS_DATABASE_URL: DATABASE_URL,
  AKS_STACK_ID: harness.stackId,
};

afterAll(() => harness.cleanup());

describe.skipIf(!reachable)("rule cursor for the Stack the run names", () => {
  it("advances that Stack's cursor and reads it back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rule-state-default-"));
    const source = `sources/bare-${randomUUID()}.md`;
    try {
      await updateRuleSourceState(root, source, {
        hash: "h1",
        concepts: [],
        compiledAt: "2026-02-01T10:00:00.000Z",
      }, NAMED_ENV);

      const state = await readRuleState(root, NAMED_ENV);
      expect(state.sources[source]?.hash).toBe("h1");
    } finally {
      await rm(root, { recursive: true, force: true });
      await db.execute(sql`
        delete from wiki.rule_extractor_state
        where stack_id = ${harness.stackId}
      `);
    }
  }, 60_000);
});
