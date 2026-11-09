/**
 * @file test/cli/default-stack-single-row.test.ts
 * @description Repeated bare ingests reuse ONE default-Stack row and never update it.
 *
 * ## The defect this pins
 *
 * The default Stack is only useful if it is the SAME Stack every time. Two failure
 * modes produce a working-looking command and a broken tenant:
 *
 * - a second run inserts a second row (a bare `insert`, so `domain = 'default'` would
 *   have to stop being unique — or the duplicate arrives under another domain);
 * - a second run "refreshes" the existing row (`on conflict ... do update`), which
 *   silently renames or re-domains a Stack an operator already owns.
 *
 * Both leave every earlier assertion green: the run exits 0 and a `domain = 'default'`
 * row exists. Only the row's identity and its `updated_at` across two runs separate
 * reuse from re-creation and from an update.
 *
 * ## Why the assertions span three snapshots, not one
 *
 * `before` → after the first ingest → after the second. The first-vs-second comparison
 * proves reuse within this case; the `before` comparison proves that a row another
 * suite already created is not touched at all, which is the case an update would
 * damage. When no default row existed beforehand that arm is vacuous and is skipped
 * rather than asserted, because creating it is the documented first-use behaviour.
 *
 * ## Why the shared row is never deleted
 *
 * `stacks.domain` is unique, so the default Stack is one global row committed by
 * whichever suite reached it first. Deleting it would pull the Stack out from under a
 * concurrently running suite; `default-stack-ingest.test.ts` records the same decision
 * and the harness cleanup deletes only the Stack this file owns.
 *
 * ## Why the CLI and not the resolver
 *
 * `test/services/stacks/default-stack.test.ts` already pins `ensureDefaultStack` in
 * isolation. What was never witnessed is that the COMMAND reaches it twice and that the
 * committed row survives both runs — the write path opens its own connection, so a
 * transaction-level test cannot observe what is durable.
 */

import { afterAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";

import { expectCLIExit, runCLI } from "../fixtures/run-cli.js";
import { managedTempRoots } from "../fixtures/managed-temp-roots.js";
import { provisionStack } from "../fixtures/stack-harness.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";
import {
  DEFAULT_STACK_DOMAIN,
  DEFAULT_STACK_NAME,
} from "../../packages/wiki/src/dimensions/stack-selection.js";

/** The line a command prints when it resolved the default Stack. Verbatim. */
const DEFAULT_STACK_NOTICE = "Using the default Stack (no --stack or AKS_STACK_ID configured).";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A document ingested twice by a checkout that names no Stack at all.";

/** The source both runs ingest, so the second run repeats the first exactly. */
const SOURCE_FILE = "row.md";

const projects = managedTempRoots();
const { harness, release } = await provisionStack("cli-default-stack-row");
const { reachable } = harness;

afterAll(async () => {
  await release();
  await projects.cleanup();
});

/** The columns of a Stack row this file judges reuse by. */
interface DefaultRow {
  id: string;
  name: string;
  updated_at: Date | string;
}

/**
 * The rows carrying the default domain, ordered so a duplicate is visible.
 *
 * @returns Every `stacks` row whose domain is the default one.
 */
async function defaultRows(): Promise<DefaultRow[]> {
  return harness.db.execute<DefaultRow>(
    sql`select id, name, updated_at from stacks where domain = ${DEFAULT_STACK_DOMAIN} order by id`,
  );
}

describe.skipIf(!reachable)("the default Stack is one row, reused and never updated", () => {
  it("keeps exactly one default row with an unchanged updated_at across two bare ingests", async () => {
    const before = await defaultRows();

    const root = await projects.create("cli-default-stack-row");
    await writeFile(path.join(root, SOURCE_FILE), BODY, "utf-8");

    const bareEnv: NodeJS.ProcessEnv = { AKS_DATABASE_URL: testDatabaseUrl(), AKS_STACK_ID: "" };

    const first = await runCLI(["ingest", SOURCE_FILE], root, bareEnv);
    expectCLIExit(first, 0);
    expect(first.stderr).toContain(`${DEFAULT_STACK_NOTICE}\n`);
    const afterFirst = await defaultRows();

    const second = await runCLI(["ingest", SOURCE_FILE], root, bareEnv);
    expectCLIExit(second, 0);
    expect(second.stderr).toContain(`${DEFAULT_STACK_NOTICE}\n`);
    const afterSecond = await defaultRows();

    expect(afterFirst).toHaveLength(1);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].name).toBe(DEFAULT_STACK_NAME);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
    // No UPDATE: the row a second run finds is the row the first run left.
    expect(afterSecond[0].updated_at).toEqual(afterFirst[0].updated_at);

    if (before.length === 1) {
      expect(afterFirst[0].id).toBe(before[0].id);
      expect(afterSecond[0].updated_at).toEqual(before[0].updated_at);
    }
  }, 120_000);
});
