/**
 * @file test/sdk/surface.test.ts
 * @description The `createWiki()` facade exposes exactly the wiki's methods, no more.
 *
 * ## What replaced what
 *
 * `staging.test.ts` exercised `createWiki().stageEntityPage` and `.promoteStagedPage`,
 * the EXPERIMENTAL staging loop. Those methods were part of the entity/profile staging
 * slice removed with the rest of the non-wiki subsystems, so the suite tested a facade
 * that no longer exists.
 *
 * The property worth keeping is not "staging works" but "the facade's surface is the
 * wiki's surface". That is what this file asserts: every method `WikiCore` declares is
 * present and callable, and the removed slices are ABSENT -- a reintroduced
 * `stageEntityPage` would be caught here rather than shipping a method with no
 * implementation behind it.
 *
 * Note that `stageEntityPage` still exists as a function in `src/trust/staging.ts`; the
 * wiki's import path uses it internally. What is gone is its exposure through this SDK.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";

/** The methods the facade must expose, mirrored from `WikiCore`. */
const REQUIRED = [
  "ingest", "ingestText", "compile", "search", "query", "getPage", "listPages",
  "listSources", "getSource", "status", "lint", "lintByTier",
  "getContextPack", "exportJson", "runEval", "exportOkf", "importOkf",
] as const;

/** Surfaces removed with the non-wiki subsystems; their return would be a regression. */
const REMOVED = [
  "stageEntityPage", "promoteStagedPage", "createRelation", "transitionLifecycle",
  "stagePreparation", "previewPreparation", "listPreparations",
  "writeArtifact", "verifyArtifact", "readVerifiedArtifactBody", "discoverArtifact",
] as const;

describe("createWiki facade surface", () => {
  it("no longer exposes deleteSource, the rm half-capability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-surface-del-"));
    try {
      const wiki = createWiki({ root }) as unknown as Record<string, unknown>;
      // `deleteSource` unlinked the raw source and left its derived pages, links
      // and state rows behind. With `rm` gone it would turn "no delete" into
      // "delete, but it corrupts", so it left with the capability.
      expect(wiki.deleteSource, "deleteSource was withdrawn with the rm capability").toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes every wiki method and none of the removed slices", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-surface-"));
    try {
      const wiki = createWiki({ root }) as unknown as Record<string, unknown>;

      for (const method of REQUIRED) {
        expect(typeof wiki[method], `expected ${method} to be callable`).toBe("function");
      }
      for (const method of REMOVED) {
        // Named separately so a reintroduction reads as what it is, not as a generic failure.
        expect(wiki[method], `${method} belongs to a removed subsystem`).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reads a source by id, the capability that survives the removal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-surface-get-"));
    try {
      await mkdir(path.join(root, "sources"), { recursive: true });
      await writeFile(path.join(root, "sources/note.md"), "---\ntitle: Note\n---\nsurviving body", "utf-8");

      const wiki = createWiki({ root });
      const source = (await wiki.getSource("note.md")) as { id: string; body?: string } | null;

      expect(source?.id).toBe("note.md");
      expect(source?.body).toContain("surviving body");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
