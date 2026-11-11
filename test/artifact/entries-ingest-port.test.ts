/**
 * @file test/artifact/entries-ingest-port.test.ts
 * @description A REAL ingest through the BUILT root entry (`dist/index.js`), with the
 * dimensions port supplied through the public `CreateWikiOptions.dimensionsPort`.
 *
 * ## Why this file exists
 *
 * `test/sdk/ingest-dimensions-port.test.ts` proves the port is called against the wiki
 * SOURCE with a fake that refuses after recording. That is the fast deterministic
 * layer, and it says nothing about the artefact a consumer installs. This file is the
 * slow, artifact-tier half of spec S9: it loads the built entry by its literal `dist/`
 * specifier, supplies a recording port through the public option, and then asserts two
 * observables that must both hold for the port to be real rather than decorative:
 *
 * 1. `resolve` was INVOKED, once, with the request the ingest actually resolved — the
 *    ingest ceiling, the same `root`, the same `env`, a defined `db` and the Stack.
 * 2. The ingest LANDED: the page is readable back through the same public surface
 *    (`listPages`) for that Stack. A call count is a proxy; a row is the claim.
 *
 * Unlike the fast layer, this port does NOT throw. It records the request and then
 * returns the real dimensions, because the assertion is that the write completes
 * through the injected port — the failure mode being disproved is "accepted and never
 * invoked", not "invoked and refused".
 *
 * ## Why `vi.importActual` and not a bare `await import()`
 *
 * The specifier must stay a STRING LITERAL: the house dimension-boundary rule reports a
 * runtime specifier it cannot read, so a computed path is not an option. A plain
 * `await import("../../dist/index.js")` would also need a `@ts-ignore`, because
 * `typecheck:tests` runs in a job that installs without building and the module
 * genuinely does not exist there — a suppressed error in a file whose whole job is to
 * be believable. `vi.importActual<T>(path)` takes a runtime string, so the loader is
 * given the literal artefact path while the type argument names the façade SOURCE this
 * entry is built from. No suppression, no cast, and the call is type-checked against
 * the published option shape.
 *
 * ## The DB-backed tier skips LOUDLY, never silently
 *
 * This is a database-backed suite, so it uses the repository's one mechanism for a
 * missing database (`test/fixtures/probe-stack-suite.ts`): without Docker or
 * `LLMWIKI_TEST_DATABASE_URL` the file FAILS, and only
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` turns it into a skip whose reason is printed and
 * whose title is annotated (`— SKIPPED: no database, reason below`). `test:pack` stays
 * DB-free; this tier is where the database belongs.
 *
 * ## S11 — THE LIMIT OF ANY IN-PROCESS ARTEFACT PROOF, WRITTEN DOWN
 *
 * This section used to say the opposite of the current build. It is kept, corrected,
 * because the LIMIT it names outlived the fact that produced it: `dist/index.js` is
 * 992,819 bytes now and CARRIES the engine (`resolveDimensions`, `LLMWIKI_DIMENSIONS`,
 * `sdk/core.ts` and the ingest service are all inside it), because
 * `odd/tasks/collapse-core-package.md` deleted `@atomicstrata/llmwiki-core` and inlined
 * its chunk. So the facade-era caveat — "the engine you exercise is not the engine you
 * ship" — no longer applies to WHAT the bundle contains.
 *
 * It still applies to WHICH module the test loads. In-process, `vitest.config.ts` aliases
 * `llm-wiki-compiler` back to `packages/wiki/src/index.ts` and the artefact path this
 * file imports is loaded through that same runner, so the engine this file exercises is
 * the SOURCE tree, not the emitted chunk graph. This file therefore proves the BUILT
 * ENTRY exports what it claims and threads the public option into the composition seam —
 * not that the shipped chunk evaluates. The file that covers the chunk is
 * `test/sdk/packaging.test.ts`: it packs the tarball, installs it in a clean project and
 * runs a real ingest through the installed package. What NO test covers today is an
 * ingest executed against that packed chunk with a database in one process: that needs a
 * network install and a database together, and it was not run for this change.
 *
 * ## Precondition
 *
 * The build must have run (`corepack pnpm run build`); the suite's global setup does it.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDimensionsDatabase, resolveDimensions } from "../../packages/wiki/src/dimensions/activation.js";
import type { CreateWikiOptions, DimensionsRequest } from "../../packages/wiki/src/sdk/types.js";
import { createProbeSuite } from "../fixtures/probe-stack-suite.js";

/** The ingest ceiling the service states to any port: every shipped dimension. */
const INGEST_CEILING = ["wiki", "kg"];

/** Title of the ingested source, used to find the row it produced. */
const TITLE = "Packed Ingest Through the Published Port";

/** Enough body text to clear the minimum source length the ingest enforces. */
const BODY = "Body long enough to clear the minimum source length the ingest enforces.";

/**
 * Assert the request the ingest stated to the port, member by member.
 *
 * Every member is one the ingest had already resolved, so a passing assertion says the
 * injected port answered the SAME question the internal resolution would have.
 *
 * @param request - The one request the recording port received, if it was called.
 * @param root - Root the ingest was constructed with.
 * @param env - Environment the caller supplied, which must be forwarded unchanged.
 * @param stackId - Stack the probe owns, which the ingest must have resolved.
 */
function assertResolvedRequest(
  request: DimensionsRequest | undefined,
  root: string,
  env: NodeJS.ProcessEnv,
  stackId: string,
): void {
  expect(request?.only).toEqual(INGEST_CEILING);
  expect(request?.root).toBe(root);
  expect(request?.env).toBe(env);
  expect(typeof request?.db).toBe("object");
  expect(request?.stackId).toBe(stackId);
}

/** This suite's probe Stack, its loud no-database decision and its teardown. */
const suite = await createProbeSuite({
  label: "artifact-port",
  databaseContext: "test/artifact/entries-ingest-port.test.ts",
  title: "the built root entry ingests through a supplied dimensions port",
});

suite.runSuite(suite.suiteTitle, () => {
  let root = "";
  let savedEnv: NodeJS.ProcessEnv = process.env;

  beforeEach(async () => {
    savedEnv = process.env;
    root = await mkdtemp(path.join(tmpdir(), "artifact-port-"));
  });

  afterEach(async () => {
    await suite.teardown(root, savedEnv);
  });

  it("invokes the supplied port and lands the ingest from the built entry", async () => {
    const probe = suite.probeStack();
    const env = probe.env();
    const received: DimensionsRequest[] = [];
    const dimensionsDb = createDimensionsDatabase(env);
    try {
      const port: NonNullable<CreateWikiOptions["dimensionsPort"]> = {
        resolve: (request) => {
          received.push(request);
          return resolveDimensions({ root, db: dimensionsDb.db, env, stackId: probe.harness.stackId });
        },
      };
      const published = await vi.importActual<typeof import("../../packages/wiki/src/index.js")>("../../dist/index.js");
      const wiki = published.createWiki({ root, env, dimensionsPort: port });
      // The write that must go THROUGH the injected port. `WikiCore` states every
      // method's result as `unknown` on purpose, so the result is matched, never cast.
      await expect(wiki.ingestText({ title: TITLE, text: BODY })).resolves.toMatchObject({
        writeStatus: "created",
      });

      expect(received).toHaveLength(1);
      assertResolvedRequest(received[0], root, env, probe.harness.stackId);

      // LANDED, read back through the SAME public surface, for THIS Stack's rows.
      await expect(wiki.listPages()).resolves.toMatchObject({
        pages: expect.arrayContaining([expect.objectContaining({ title: TITLE })]),
      });
    } finally {
      await dimensionsDb.close();
    }
  }, 60_000);
});
