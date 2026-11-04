/**
 * @file test/dimensions/kg-shared-credentials-env-order.test.ts
 * @description The KG credential bridge must see the PROJECT `.env`, not only the
 * shell environment.
 *
 * `packages/llmwiki-kg/ts/src/config.ts` snapshots `process.env` at module init
 * (and `db.ts` reads `config.DATABASE_URL` at module init too), while `src/cli.ts`
 * called `loadCliEnvironment()` AFTER its imports had already been evaluated.
 * A user who configures the shared embedding credential in `.env` — the normal
 * way — therefore hit the fail-closed message, even though exporting the same
 * variables in the shell worked.
 *
 * The embedding endpoint points at a CLOSED port on purpose: this test asserts
 * the credential gate only. Reaching an HTTP attempt at that endpoint proves the
 * bridge resolved the `.env` values; it does not prove a provider round trip.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../fixtures/run-cli.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

const exec = promisify(execFile);

/** The S4 message a user who configured `.env` must never see. */
const NO_KEY_MESSAGE = "EMBEDDING_PROVIDER=openai but no API key is configured.";

/** Closed port, so the run can only reach a connection failure. */
const CLOSED_ENDPOINT = "http://127.0.0.1:9/v1";

/** Minimal project `.env`: the shared-credential configuration, nothing else. */
const PROJECT_ENV = [
  "LLMWIKI_DIMENSIONS=wiki,kg",
  "LLMWIKI_PROVIDER=openai",
  "LLMWIKI_EMBEDDING_PROVIDER=openai",
  `OPENAI_EMBEDDINGS_BASE_URL=${CLOSED_ENDPOINT}`,
  "OPENAI_EMBEDDINGS_API_KEY=test-key-not-real",
  "EXTRACTION_PROVIDER=gateway",
  `AKS_DATABASE_URL=${testDatabaseUrl()}`,
  "",
].join("\n");

/** Scratch project root, created per test and removed in `afterAll`. */
const scratchRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    scratchRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Write a project whose only credential source is its `.env`. */
async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-env-order-"));
  scratchRoots.push(root);
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, ".env"), PROJECT_ENV, "utf-8");
  await writeFile(
    path.join(root, "sources", "note.md"),
    "# Note\n\nAda Lovelace worked with Charles Babbage on the Analytical Engine.\n",
    "utf-8",
  );
  return root;
}

/** Run the built CLI with nothing but PATH and HOME inherited from the shell. */
async function ingestWithShellEnvOnly(cwd: string): Promise<string> {
  const env = { PATH: process.env["PATH"], HOME: process.env["HOME"] };
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [CLI, "ingest", "sources/note.md"],
      { cwd, env, timeout: 60_000 },
    );
    return stdout + stderr;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return (failure.stdout ?? "") + (failure.stderr ?? "");
  }
}

describe("kg dimension credentials from the project .env", () => {
  it("passes the credential gate on .env values alone", async () => {
    const output = await ingestWithShellEnvOnly(await makeProject());
    expect(output).not.toContain(NO_KEY_MESSAGE);
    expect(output).toContain(CLOSED_ENDPOINT);
  });
});
