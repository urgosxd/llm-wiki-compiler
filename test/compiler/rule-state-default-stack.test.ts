/**
 * @file test/compiler/rule-state-default-stack.test.ts
 * @description Rule extraction's cursor advances on the default Stack when the
 * checkout configured no Stack.
 *
 * ## Why the cursor and not the compile output
 *
 * The rule cursor is the one place where a wrong Stack is silent: the read half and
 * the write half each used to resolve their own Stack id, so a run could read one
 * Stack's cursor and advance another's, which reads as "every source is new" on the
 * next pass. Both halves now resolve through the same call, and this case proves the
 * unconfigured half of that: with no `AKS_STACK_ID` at all, the write and the read
 * must land on the same row.
 *
 * ## Why the environment is passed in
 *
 * `readRuleState` and `updateRuleSourceState` take the environment they resolve with,
 * so the case hands them a bare one -- a connection string and no Stack id -- rather
 * than mutating `process.env` for every other suite in this worker.
 *
 * ## Teardown
 *
 * The default Stack is a single global row (`stacks.domain` is unique), so the cursor
 * key is randomised per run and the cursor row for that Stack is removed at the end:
 * a leftover key would make the next run's read return state it never wrote.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";

import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { DEFAULT_STACK_DOMAIN } from "../../src/dimensions/stack-selection.js";
import { readRuleState, updateRuleSourceState } from "../../src/compiler/rule-state.js";

/** The environment a bare checkout has: a connection, and no Stack id. */
const BARE_ENV: NodeJS.ProcessEnv = { AKS_DATABASE_URL: DATABASE_URL };

const harness = await createKgPostgresHarness("rule-state-default");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

describe.skipIf(!reachable)("rule cursor with no Stack configured", () => {
  it("advances the default Stack's cursor and reads it back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rule-state-default-"));
    const source = `sources/bare-${randomUUID()}.md`;
    try {
      await updateRuleSourceState(root, source, {
        hash: "h1",
        concepts: [],
        compiledAt: "2026-02-01T10:00:00.000Z",
      }, BARE_ENV);

      const state = await readRuleState(root, BARE_ENV);
      expect(state.sources[source]?.hash).toBe("h1");
    } finally {
      await rm(root, { recursive: true, force: true });
      await db.execute(sql`
        delete from wiki.rule_extractor_state
        where stack_id = (select id from stacks where domain = ${DEFAULT_STACK_DOMAIN})
      `);
    }
  }, 60_000);
});
