/**
 * @file test/sdk/ingest-request-env.test.ts
 * @description `CreateWikiOptions.env` decides the tenant the SDK ingest writes to.
 *
 * ## The condition this pins
 *
 * `createWikiCoreAtRoot` resolves the request environment ONCE (`sdk/core.ts:81`) and
 * its docstring promises that an embedder serving many Stacks passes it here "or every
 * write and read this core performs lands in the bound deployment's tenant instead of
 * the one the request named". The ingest methods did not forward it, so
 * `ingestSource`/`ingestTextSource` fell back to `process.env`: a host bound to Stack A
 * that answered a request for Stack B wrote B's pages into A's tenant. That is a
 * wrong-tenant write of stored data, not a wrong read, because it survives the call.
 *
 * ## Why both sides are asserted
 *
 * "The rows are in B" alone passes if the code writes to BOTH tenants. "The rows are
 * not in A" alone passes if it writes nowhere at all. Only the pair proves the write
 * was ROUTED to the Stack the request named.
 *
 * ## Why the process environment is bound to the OTHER Stack
 *
 * An ambient environment that already named B would make the case pass under the
 * defect, since the fallback would resolve to the same tenant by coincidence. The
 * bound Stack is therefore A, and B reaches the core only through the option.
 *
 * ## Why the rows are read through `listSourceDocuments`
 *
 * Both Stacks live in ONE database, so "which table holds the row" cannot answer which
 * TENANT it belongs to. The store seam takes the Stack id and filters on it, which is
 * the only observable that distinguishes the two.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import { listSourceDocuments } from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "Body long enough to clear the minimum source length the ingest enforces.";

/**
 * The facade declares its ingest results as `unknown`, so the saved filename — the one
 * observable that ties a call to the row it produced — is read from a checked shape.
 *
 * @param result - Value returned by `ingest` or `ingestText`.
 * @returns The filename the write reported.
 */
function savedFilename(result: unknown): string {
  return (result as { filename: string }).filename;
}

describe("SDK ingest honours CreateWikiOptions.env", () => {
  /** The Stack the PROCESS is bound to, as a single-tenant deployment would be. */
  let bound: ProbeStack;
  /** The Stack the request names, reachable only through `CreateWikiOptions.env`. */
  let requested: ProbeStack;
  let root: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    bound = await createProbeStack("sdk-env-bound");
    requested = await createProbeStack("sdk-env-requested");
    root = await mkdtemp(path.join(tmpdir(), "sdk-env-ingest-"));
    saved = { ...process.env };
  });

  afterEach(async () => {
    process.env = saved;
    await bound.harness.cleanup();
    await requested.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("writes ingest and ingestText rows to the Stack env names, not the bound one", async () => {
    const source = path.join(root, "note.md");
    await writeFile(source, BODY, "utf-8");
    Object.assign(process.env, bound.env());
    const wiki = createWiki({ root, env: requested.env() });

    const ingested = await wiki.ingest({ source });
    const inline = await wiki.ingestText({ title: "Inline Note", text: BODY });

    const filenames = [savedFilename(ingested), savedFilename(inline)].sort();
    const requestedRows = await listSourceDocuments(requested.harness.db, requested.harness.stackId);
    // Both sides: NOT in the bound Stack...
    expect(await listSourceDocuments(bound.harness.db, bound.harness.stackId)).toEqual([]);
    // ...and written to the one the option named.
    expect(requestedRows.map((row) => row.filename).sort()).toEqual(filenames);
  }, 60_000);

  // PRESERVE: the documented DEFAULT this change must not move — an embedder that
  // passes no `env` still addresses the Stack the process is bound to.
  it("keeps targeting the bound Stack when no env is passed", async () => {
    Object.assign(process.env, bound.env());

    const inline = await createWiki({ root }).ingestText({ title: "Bound Note", text: BODY });

    const boundRows = await listSourceDocuments(bound.harness.db, bound.harness.stackId);
    expect(boundRows.map((row) => row.filename)).toEqual([savedFilename(inline)]);
    expect(await listSourceDocuments(requested.harness.db, requested.harness.stackId)).toEqual([]);
  }, 60_000);
});
