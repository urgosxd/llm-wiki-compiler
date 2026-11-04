/**
 * @file test/cli/stack-option-validates-before-any-query.test.ts
 * @description A `--stack` value this run cannot honour is refused BEFORE the command
 * touches the database or the project — no query, no fallback, no partial work.
 *
 * ## The defect this pins
 *
 * `stack-option.test.ts` already pins that a bad `--stack` exits non-zero and names
 * the value it could not honour. That leaves the ordering unproven: a refusal printed
 * AFTER the database was already asked (or after a source file was already written)
 * satisfies those assertions just as well, while having already spent the connection
 * and left the project half-ingested. Fail-closed means closed before anything
 * observable happened, and only a probe that makes the database unusable can tell the
 * two orderings apart.
 *
 * ## Why the malformed case poisons the connection string
 *
 * A shape check that reached Postgres would surface as a connection error, because the
 * whole point of the dead DSN is that any query fails. So "the message names the value
 * and not a connection problem" is the observable proof that the validation happened
 * first. The same DSN would make the refusal *look* successful if the check ran second
 * and the driver error were swallowed into the same exit-1 path, which is why the case
 * also asserts the stderr does NOT read like a driver failure.
 *
 * ## Why the refusal must not announce the default Stack
 *
 * The announcement is the default selection speaking (`src/cli/stack-option.ts`), and a
 * typed value that is refused must never have reached it: printing the line on a
 * refusal would tell the caller a default Stack is being used, in a run that used
 * nothing at all.
 *
 * ## Why the malformed case needs no database, and the uuid case does
 *
 * The uuid-shaped-but-unknown case is a real database question — it must connect and
 * find no row — so it is guarded by a harness reachability probe like every other
 * Postgres-backed CLI case. The malformed case answers before any connection exists, so
 * it runs unconditionally; skipping it for lack of a database would hide the one case
 * that proves the ordering.
 */

import { afterAll, describe, expect, it } from "vitest";
import { stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { expectCLIFailure, runCLI } from "../fixtures/run-cli.js";
import { managedTempRoots } from "../fixtures/managed-temp-roots.js";
import { wikiReachable } from "../fixtures/stack-harness.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

/** A value that is not a uuid, kept obvious so a failure reads as itself. */
const MALFORMED_STACK = "not-a-uuid";

/**
 * A DSN on a port nothing listens on: ANY query fails loudly.
 *
 * That is the instrument, not an accident. If the shape check reached the database the
 * run would report a connection failure instead of a refusal, which is exactly the
 * ordering this file exists to rule out.
 */
const UNREACHABLE_DSN = "postgresql://nobody:nobody@127.0.0.1:1/absent";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A document whose ingest must never start when the named Stack is refused.";

/** The source both cases ask the CLI to ingest. */
const SOURCE_FILE = "refused.md";

/** Directory an accepted ingest would create; a refusal leaves it absent. */
const SOURCES_DIR = "sources";

const projects = managedTempRoots();
const reachable = await wikiReachable("cli-stack-validation-order");

afterAll(projects.cleanup);

/**
 * A temp project root holding the source both cases name on the command line.
 *
 * @returns The absolute path of the new root.
 */
async function projectRoot(): Promise<string> {
  const root = await projects.create("cli-stack-validation");
  await writeFile(path.join(root, SOURCE_FILE), BODY, "utf-8");
  return root;
}

/**
 * Whether a path exists, without asserting anything about why it might not.
 *
 * @param target - Absolute path to test.
 * @returns True when the path exists.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("--stack is refused before any query is attempted", () => {
  it("rejects a malformed value with no connection attempt and no default fallback", async () => {
    const root = await projectRoot();

    const result = await runCLI(["ingest", SOURCE_FILE, "--stack", MALFORMED_STACK], root, {
      AKS_DATABASE_URL: UNREACHABLE_DSN,
      AKS_STACK_ID: "",
    });

    expectCLIFailure(result);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(MALFORMED_STACK);
    expect(result.stderr).toContain("Stack");
    expect(result.stderr).not.toContain("Using the default Stack");
    expect(result.stderr.toLowerCase()).not.toMatch(/connect|econnrefused|could not be checked/);
    expect(await exists(path.join(root, SOURCES_DIR))).toBe(false);
  });
});

describe.skipIf(!reachable)("--stack naming no existing Stack", () => {
  it("is refused, naming it, with empty stdout and no source created", async () => {
    const missing = randomUUID();
    const root = await projectRoot();

    const result = await runCLI(["ingest", SOURCE_FILE, "--stack", missing], root, {
      AKS_DATABASE_URL: testDatabaseUrl(),
      AKS_STACK_ID: "",
    });

    expectCLIFailure(result);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toContain("Stack");
    expect(result.stderr).not.toContain("Using the default Stack");
    expect(await exists(path.join(root, SOURCES_DIR))).toBe(false);
  });
});
