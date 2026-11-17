/**
 * @file test/compile-pending-embeddings-resolved.test.ts
 * @description T2 — a compile that RESOLVED its Stack from the database must drain the
 * pending embedding marker of THAT Stack's rows, not `.llmwiki/pending-embeddings.json`.
 *
 * ## The defect this pins
 *
 * `utils/pending-embeddings.ts` decides row-vs-file from `markerStackId(env = process.env)`,
 * and every caller ONE LEVEL OUT omits the argument: `readMarkerFromRows(markerFile)` and the
 * three `writeMarkerToRows(...)` calls. The compile path reaches those through
 * `finalizeWiki` → `safelyUpdateEmbeddings` → `refreshEmbeddingsDrainingPending` →
 * `readPendingMarker`, so a run whose Stack came from the DATABASE (its `AKS_STACK_ID` absent,
 * which is the operator's case once the line leaves `.env`) drains and writes the FILE marker.
 * Every other seam on the compile path takes the row branch by now; this one did not.
 *
 * ## What is asserted, and why THESE observations
 *
 * WHERE THE RESULT LANDED, never a message. The Stack's marker is read through the STORE
 * (`readRefreshMarkers`), not through the marker helpers under test: asking the helper
 * whether the row is still queued would let a broken helper answer for itself. The second
 * observation is the absence of `.llmwiki/pending-embeddings.json`, so a run cannot pass by
 * writing the same record to both backends. The third is the id list the refresh core
 * received, which proves the marker was READ from the backend that was then written.
 *
 * The refresh core is stubbed to FAIL, so the run keeps a marker to observe: a successful
 * settle empties it, and both backends would then look like "nothing queued".
 *
 * ## The file-mode pin
 *
 * File mode must keep working with a NAME: with no database configured the same compile
 * records the changed page in `.llmwiki/pending-embeddings.json`, exactly as it does today.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";
import { describe, expect, it, vi } from "vitest";

import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import {
  readRefreshMarkers,
  replaceRefreshMarkers,
} from "../packages/wiki/src/dimensions/wiki/marker-store.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { resolveStackForCommand } from "../packages/wiki/src/services/stacks/resolve-stack.js";
import { PENDING_EMBEDDINGS_FILE, SOURCES_DIR } from "../packages/wiki/src/utils/constants.js";
import * as embeddings from "../packages/wiki/src/utils/embeddings.js";
import { extractionAnswer, stubCompileProvider } from "./fixtures/compile-provider.js";
import { usePerCaseFileMode, withFileMode } from "./fixtures/file-mode.js";
import { useResolvedStackSuite } from "./fixtures/resolved-stack-suite.js";
import type { SuiteHandle } from "./fixtures/resolved-stack-suite.js";

// This file has BOTH modes — a row-backed case and a file-backed pin — so the mode is
// declared per case rather than for the file.
usePerCaseFileMode();

/** The one source the compile extracts into a page. */
const SOURCE = {
  title: "Pending Marker Topic",
  source: "https://pending-marker.test/topic",
  document: "# Pending Marker Topic\n\nSource content for the pending marker.\n",
};

/** The slug the compile derives from the concept, and the page id it refreshes. */
const SLUG = "pending-marker-topic";

/** The qualified page id of the page this run writes. */
const CHANGED_ID = `concepts/${SLUG}`;

/** A page queued by an EARLIER run, so the drain has prior work to carry. */
const SEEDED_ID = "concepts/earlier-run";

/**
 * The scenario, from the fixture the resolved-Stack suites share: a per-run database, an
 * environment that NAMES NO STACK, and this file's offline provider.
 */
const { skipped, runEnv, suiteHandle, tempRoot } = await useResolvedStackSuite({
  context: "test/compile-pending-embeddings-resolved.test.ts",
  beforeEach: () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "offline-key";
  },
});

/** Install the offline provider and return a throwaway project root. */
async function prepareRun(prefix: string): Promise<string> {
  stubCompileProvider({ extraction: () => extractionAnswer([SOURCE.title]), body: () => "Body.\n" });
  return await tempRoot(prefix);
}

/**
 * Fail the refresh at its core, after the write-ahead marker has been recorded.
 *
 * The same seam `test/compile-pending-embeddings.test.ts` uses: a swallowed provider failure
 * is what leaves a marker standing, and a marker standing is what makes "which backend" a
 * question with an answer.
 *
 * @returns The spy, whose calls report the ids the drain read.
 */
function failRefreshCore() {
  return vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockRejectedValue(new Error("embedding provider unavailable"));
}

/** Where the file marker would live for this root. */
function markerFileIn(root: string): string {
  return path.join(root, PENDING_EMBEDDINGS_FILE);
}

/** The page ids of the FILE marker, or `[]` when the run wrote none. */
async function filePendingIds(root: string): Promise<string[]> {
  if (!existsSync(markerFileIn(root))) return [];
  const raw = await readFile(markerFileIn(root), "utf-8");
  return (JSON.parse(raw) as Array<{ pageId: string }>).map((entry) => entry.pageId);
}

/** One source document as a file-backed project stores it: front matter, then body. */
function asSourceDocument(): string {
  return `---\ntitle: ${SOURCE.title}\n---\n\n${SOURCE.document}`;
}

/** Plant the one source a file-backed run reads off disk instead of out of rows. */
async function plantSourceFile(root: string): Promise<void> {
  const file = path.join(root, SOURCES_DIR, "topic.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, asSourceDocument(), "utf-8");
}

/**
 * Prepare the database-configured scenario: a Stack the run resolved WITHOUT naming it, one
 * source to compile, and one page already queued in that Stack's rows.
 *
 * @param db - Handle the rows are written through.
 * @param stackId - The Stack that owns the marker.
 */
async function queueSeedRow(db: DatabaseHandle, stackId: string): Promise<void> {
  await saveSourceDocument(db, stackId, SOURCE);
  await replaceRefreshMarkers(db, stackId, "pending", [{ pageId: SEEDED_ID, attempts: 0 }]);
}

describe.skipIf(skipped !== "")("a compile that resolved its Stack from the database", () => {
  it("drains the Stack's row marker and writes no pending-embeddings file", async () => {
    const root = await prepareRun("pending-emb-rows-");
    const run = runEnv();
    const handle: SuiteHandle = suiteHandle();
    try {
      const stackId = await resolveStackForCommand(handle.db, run);
      await queueSeedRow(handle.db, stackId);
      const core = failRefreshCore();

      expect(await readRefreshMarkers(handle.db, stackId, "pending")).toEqual([
        { pageId: SEEDED_ID, attempts: 0 },
      ]);
      expect(existsSync(markerFileIn(root))).toBe(false);

      expect(await compileAndReport(root, { env: run })).toMatchObject({ errors: [] });

      // The drain READ this Stack's rows: the queued page reached the core.
      expect(core.mock.calls.flatMap((call) => call[1] as string[])).toContain(SEEDED_ID);
      // ...and it WROTE them back, which is where the failed attempt was recorded.
      expect(await readRefreshMarkers(handle.db, stackId, "pending")).toContainEqual(
        { pageId: SEEDED_ID, attempts: 1 },
      );
      expect(await filePendingIds(root)).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});

describe.skipIf(skipped !== "")("a compile with no database configured", () => {
  it("keeps recording the pending marker in the FILE", async () => {
    const root = await prepareRun("pending-emb-file-");
    await plantSourceFile(root);
    failRefreshCore();

    await withFileMode(async () => {
      expect(await compileAndReport(root)).toMatchObject({ errors: [] });
    });

    // File mode, written by name: the file marker is the one that answered.
    expect(await filePendingIds(root)).toContain(CHANGED_ID);
  });
});
