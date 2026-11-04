/**
 * @file test/cli/stack-option.test.ts
 * @description `--stack <id>` names the Stack a command works on, and a name it
 * cannot honour fails closed instead of quietly becoming the default Stack.
 *
 * ## The defect this pins
 *
 * A multi-Stack deployment could only be addressed through `AKS_STACK_ID`, so asking
 * one command for one Stack meant exporting a variable and hoping nothing else read
 * it. The flag is the caller-level override; these cases pin that it is the value the
 * run actually uses, and that a name which is not a Stack is a refusal — never a
 * silent fallback, which would write a caller's documents into a tenant they did not
 * name.
 *
 * ## Why the cases spawn the compiled CLI
 *
 * The option is the SEAM under test: Commander has to accept it, the action has to
 * validate it before any work runs, and the environment handed downstream has to
 * carry it. Only a real invocation exercises all three. `test/global-setup.ts` builds
 * `dist/` once for the suite.
 *
 * ## Which Stack a run used, observed where it is durable
 *
 * The flag-wins case asserts through `wiki.source_documents` rather than through
 * output: the Stack a document was WRITTEN to is the only statement that cannot be
 * produced by echoing the flag back. Both Stacks belong to this file's harnesses, so
 * nothing here touches operator data.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { expectCLIExit, expectCLIFailure, runCLI } from "../fixtures/run-cli.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";
import { listSourceDocuments } from "../../src/dimensions/wiki/source-documents-store.js";

/** A value that is not a uuid, kept obvious so a failure reads as itself. */
const MALFORMED_STACK = "not-a-uuid";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "A document ingested through a command that was told which Stack to use.";

/** The source this suite ingests, named after the case that reads it back. */
const SOURCE_FILE = "flag-wins.md";

const roots: string[] = [];
const flagStack = await createKgPostgresHarness("cli-stack-flag");
const envStack = await createKgPostgresHarness("cli-stack-env");
const { reachable } = flagStack;

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all([flagStack.cleanup(), envStack.cleanup()]);
});

/**
 * A temp project root, removed when the file finishes.
 *
 * @returns The absolute path of the new root.
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cli-stack-option-"));
  roots.push(root);
  return root;
}

/**
 * The environment a Stack-scoped run starts from: a database and NO Stack id.
 *
 * The empty string matters. `dotenv-test.conf` deliberately omits `AKS_STACK_ID`, but
 * an operator's own shell may still carry one, and an inherited value would decide
 * these cases from outside the test.
 *
 * @returns Environment overrides for {@link runCLI}.
 */
function stacklessEnv(): NodeJS.ProcessEnv {
  return { AKS_DATABASE_URL: testDatabaseUrl(), AKS_STACK_ID: "" };
}

/**
 * The source filenames stored under one Stack.
 *
 * @param stackId - The Stack to read, and the one whose handle is used.
 * @param db - Handle of the harness owning that Stack.
 * @returns The filenames `wiki.source_documents` holds for it.
 */
async function storedFilenames(
  db: (typeof flagStack)["db"],
  stackId: string,
): Promise<string[]> {
  const documents = await listSourceDocuments(db, stackId);
  return documents.map((document) => document.filename);
}

describe.skipIf(!reachable)("--stack fail-closed validation", () => {
  it("refuses a malformed --stack value, naming it, instead of using the default", async () => {
    const result = await runCLI(["compile", "--stack", MALFORMED_STACK], await tempRoot(), stacklessEnv());

    expectCLIFailure(result);
    expect(result.stderr).toContain(MALFORMED_STACK);
    expect(result.stderr).toContain("Stack");
    expect(result.stdout).not.toContain("Using the default Stack");
  });

  it("refuses a well-formed --stack id that is not an existing Stack, naming it", async () => {
    const missing = randomUUID();
    const result = await runCLI(["compile", "--stack", missing], await tempRoot(), stacklessEnv());

    expectCLIFailure(result);
    expect(result.stderr).toContain(missing);
    expect(result.stderr).toContain("Stack");
  });
});

describe.skipIf(!reachable)("--stack precedence over AKS_STACK_ID", () => {
  it("writes to the --stack Stack even when AKS_STACK_ID names another one", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, SOURCE_FILE), BODY, "utf-8");

    const result = await runCLI(["ingest", SOURCE_FILE, "--stack", flagStack.stackId], root, {
      ...stacklessEnv(),
      AKS_STACK_ID: envStack.stackId,
    });

    expectCLIExit(result, 0);
    expect(await storedFilenames(flagStack.db, flagStack.stackId)).toContain(SOURCE_FILE);
    expect(await storedFilenames(envStack.db, envStack.stackId)).not.toContain(SOURCE_FILE);
  });
});
