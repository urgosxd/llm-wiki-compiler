/**
 * @file test/status/sources-count-matches-listing.test.ts
 * @description `status.sources` answers the same question `listSources()` does: how
 * many sources this corpus has. Not how many keys the compile state happens to hold.
 *
 * ## The defect
 *
 * `collectStatus` derived `sources` from `Object.keys(state.sources)` — the COMPILE
 * STATE — and a compile state only gains a key when a compile records one. So a
 * corpus that had been ingested and not yet compiled reported `sources: 0` beside a
 * one-item `listSources()`, at exactly the moment a caller is most likely to look.
 * Measured on a fresh Stack through the `wiki_status` seam:
 *
 *   status    -> {"sources":0, ..., "stateStatus":"missing"}
 *   listSources -> {"sources":[{"id":"note.md", ...}]}
 *   wiki.source_documents -> 1 row
 *
 * After a compile the two agreed again, which is why the count looked healthy in
 * every suite that compiled before reading it.
 *
 * ## What is pinned
 *
 * The INVARIANT — `status.sources === listSources().sources.length` — captured in one
 * test at the pre-compile moment, not the literal `1`. A literal would accept a "fix"
 * that special-cased the empty state, and would keep passing while the counter and the
 * listing drifted apart again for any other reason.
 *
 * The Stack, the environment and their teardown come from the shared fixtures
 * (`useStackEnv` → `test/fixtures/kg-postgres.ts`); the corpus is written by the real
 * `ingestTextSource`, so the row store and the projected `sources/` file are the ones
 * a caller actually gets.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectStatus, type WikiStatus } from "../../packages/wiki/src/status/collect.js";
import { ingestTextSource } from "../../packages/wiki/src/commands/ingest.js";
import { listSources } from "../../packages/wiki/src/sources/store.js";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { withSourceDocuments } from "../../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { useStackEnv } from "../fixtures/stack-env.js";

describe("status.sources follows the source listing", () => {
  useStackEnv("status-sources-count");

  /** Read the status the way the `wiki_status` MCP tool does — corpus seam and `env`. */
  function statusFor(root: string): Promise<WikiStatus> {
    return withSourceDocuments(process.env, (sourceDocuments) =>
      collectStatus(root, { sourceDocuments, env: process.env }),
    );
  }

  it("reports the sources listSources summarises, before the first compile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "status-sources-listing-"));
    try {
      await ingestTextSource(root, { title: "Note", text: "alpha" });
      const status = await statusFor(root);
      const { sources } = await listSources(root);

      // Nothing has compiled, so the compile state records no source at all. The
      // corpus is nonetheless there, which is what makes the invariant bite.
      expect(status.stateStatus).toBe("missing");
      expect(sources.length).toBeGreaterThan(0);
      expect(status.sources).toBe(sources.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("still reports the compiled corpus' own size once its sources have compiled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "status-sources-compiled-"));
    try {
      await ingestTextSource(root, { title: "Alpha", text: "alpha" });
      await ingestTextSource(root, { title: "Beta", text: "beta" });
      await compileKeylessly(root);

      const status = await statusFor(root);
      const { sources } = await listSources(root);

      expect(status.stateStatus).toBe("ok");
      expect(sources.length).toBe(2);
      expect(status.sources).toBe(sources.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Compile under the shipped keyless provider, restoring the ambient selection after. */
async function compileKeylessly(root: string): Promise<void> {
  const saved = process.env.LLMWIKI_PROVIDER;
  process.env.LLMWIKI_PROVIDER = "offline";
  try {
    await compileAndReport(root, { env: process.env });
  } finally {
    if (saved === undefined) delete process.env.LLMWIKI_PROVIDER;
    else process.env.LLMWIKI_PROVIDER = saved;
  }
}
