/**
 * @file test/cli/default-stack-notice.test.ts
 * @description A Stack-scoped command that resolved the DEFAULT Stack says so, on
 * stderr, without changing one byte of stdout.
 *
 * ## The defect this pins
 *
 * The default Stack is a real Stack a bare checkout now writes to, and writing there
 * silently is how a caller ends up with documents in a tenant they never named. The
 * notice names the situation on stderr — never on stdout, because `--json` callers
 * parse stdout and an advisory line ahead of the envelope breaks every one of them
 * (`test/quickstart-json-stdout.test.ts` is the standing witness for that rule).
 *
 * ## Why stdout is compared BYTES between two runs
 *
 * The claim is not "stdout looks fine", it is "stdout is identical whether or not a
 * Stack was announced". Two invocations of the same command in the same project, one
 * bare and one with `AKS_STACK_ID`, differ only in which Stack the rows land in — so
 * any stdout difference is the announcement leaking into the machine-readable channel.
 *
 * ## Why the bare case leaves the default Stack row behind
 *
 * `stacks.domain` is unique, so the default Stack is one global row, and the ingest
 * commits it through its own connection. Deleting a row another suite may be writing
 * to is the more damaging trade; `default-stack-ingest.test.ts` records the same
 * decision.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expectCLIExit, runCLI, type CLIResult } from "../fixtures/run-cli.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

/** The line a command prints when it resolved the default Stack. Verbatim. */
const DEFAULT_STACK_NOTICE = "Using the default Stack (no --stack or AKS_STACK_ID configured).";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A document ingested by a command that named no Stack at all.";

/** The source both runs ingest, so their stdout refers to the same path. */
const SOURCE_FILE = "notice.md";

const roots: string[] = [];
const configuredStack = await createKgPostgresHarness("cli-stack-notice");
const { reachable } = configuredStack;

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await configuredStack.cleanup();
});

/**
 * A temp project root holding the source both runs ingest.
 *
 * @returns The absolute path of the new root.
 */
async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cli-stack-notice-"));
  roots.push(root);
  await writeFile(path.join(root, SOURCE_FILE), BODY, "utf-8");
  return root;
}

/**
 * Ingest the shared source once, under the given environment.
 *
 * @param root - Project root to run in.
 * @param stackId - Stack to name in `AKS_STACK_ID`, or the empty string for none.
 * @returns The CLI result, unasserted.
 */
async function ingestIn(root: string, stackId: string): Promise<CLIResult> {
  return runCLI(["ingest", SOURCE_FILE], root, {
    AKS_DATABASE_URL: testDatabaseUrl(),
    AKS_STACK_ID: stackId,
  });
}

/** How many times the notice occurs in a string. */
function countNotices(text: string): number {
  return text.split(DEFAULT_STACK_NOTICE).length - 1;
}

describe.skipIf(!reachable)("default Stack announcement", () => {
  it("prints the line once on stderr when nothing configured a Stack", async () => {
    const result = await ingestIn(await projectRoot(), "");

    expectCLIExit(result, 0);
    expect(result.stderr).toContain(`${DEFAULT_STACK_NOTICE}\n`);
    expect(countNotices(result.stderr)).toBe(1);
    expect(result.stdout).not.toContain("Using the default Stack");
  });

  it("leaves stdout byte-identical to a run that configured a Stack", async () => {
    const root = await projectRoot();

    const bare = await ingestIn(root, "");
    const configured = await ingestIn(root, configuredStack.stackId);

    expectCLIExit(bare, 0);
    expectCLIExit(configured, 0);
    expect(bare.stdout).toBe(configured.stdout);
  });

  it("stays silent when AKS_STACK_ID configured the Stack", async () => {
    const result = await ingestIn(await projectRoot(), configuredStack.stackId);

    expectCLIExit(result, 0);
    expect(result.stderr).not.toContain(DEFAULT_STACK_NOTICE);
  });
});
