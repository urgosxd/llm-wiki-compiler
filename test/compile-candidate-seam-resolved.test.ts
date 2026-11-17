/**
 * @file test/compile-candidate-seam-resolved.test.ts
 * @description T5 — a compile that RESOLVED its Stack from the database must clear the
 * duplicate candidate in THAT Stack's row queue, not in `.llmwiki/candidates`.
 *
 * ## The defect this pins
 *
 * The compile publishes the resolved id into the environment it hands downstream (T9), but
 * the page-generation boundary re-derives the environment from the REQUEST instead:
 * `review-pipeline.ts` computes `options.env ?? process.env`, which knows nothing about a
 * Stack the database resolved, and hands that raw env to `deleteCandidateBySlug`. The
 * candidate seam (`dimensions/wiki/candidate-source.ts`) decides row-vs-file from
 * `(env[AKS_STACK_ID] ?? "").trim()`, so an empty id there takes the FILE branch: the
 * duplicate-candidate search walks a `.llmwiki/candidates` directory that a row-backed run
 * never wrote, and the Stack's own `wiki.review_candidates` row survives the live write it
 * was superseded by.
 *
 * `compiler/index.ts` collects the pending-candidate source states the same way: through
 * `listCandidates(root)`, which takes only a root and therefore reads the AMBIENT
 * environment. Same reader, same path, same wrong answer.
 *
 * ## What is asserted, and why THESE observations
 *
 * WHERE THE ROW LANDED, never a message. The Stack's queue is read through the STORE
 * (`listStoredCandidates`), not through the seam under test: asking `withCandidateSource`
 * whether the candidate is still pending would let a broken seam answer for itself. The
 * second observation is that no `.llmwiki/candidates` file exists, so a run cannot pass by
 * moving the same record to the other backend.
 *
 * ## The file-mode pin
 *
 * File mode must keep working with a NAME: with no database configured the SAME compile
 * clears the SAME duplicate out of `.llmwiki/candidates`, and no candidate row appears in
 * any Stack. A FILE authority publishes nothing into the environment, so this case is also
 * the pin that the publication is conditional.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";
import { describe, expect, it } from "vitest";

import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import {
  listStoredCandidates,
  saveStoredCandidate,
} from "../packages/wiki/src/dimensions/wiki/candidate-store.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { SOURCES_DIR } from "../packages/wiki/src/utils/constants.js";
import { seedPendingCandidate, snapshotCandidateQueue } from "./fixtures/candidate-queue.js";
import { extractionAnswer, stubCompileProvider } from "./fixtures/compile-provider.js";
import { usePerCaseFileMode, withFileMode } from "./fixtures/file-mode.js";
import { useResolvedStackSuite } from "./fixtures/resolved-stack-suite.js";
import type { SuiteHandle } from "./fixtures/resolved-stack-suite.js";

// This file has BOTH modes — a row-backed case and a file-backed pin — so the mode is
// declared per case rather than for the file.
usePerCaseFileMode();

/** The one source the compile extracts into a page. */
const SOURCE = {
  title: "Candidate Seam Topic",
  source: "https://candidate-seam.test/topic",
  document: "# Candidate Seam Topic\n\nSource content for the candidate seam.\n",
};

/** The slug the compile derives from the concept, and the only slug the delete names. */
const SLUG = "candidate-seam-topic";

/** The identity the planted duplicate is stored under, in either backend. */
const DUPLICATE_ID = `${SLUG}-row`;

/**
 * The scenario, from the fixture the resolved-Stack suites share: a per-run database, an
 * environment that NAMES NO STACK, and this file's offline provider.
 */
const { skipped, runEnv, suiteHandle, tempRoot, stackId } = await useResolvedStackSuite({
  context: "test/compile-candidate-seam-resolved.test.ts",
  beforeEach: () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "offline-key";
  },
});

/** Install the offline provider and return a throwaway project root. */
async function prepareRun(prefix: string): Promise<string> {
  stubCompileProvider({ extraction: () => extractionAnswer(["Candidate Seam Topic"]), body: () => "Body.\n" });
  return await tempRoot(prefix);
}

/**
 * Plant the duplicate the live write supersedes, in ONE Stack's row queue.
 *
 * Seeded through the store rather than a production writer, because the writer that used
 * to stage candidates is retired; the store is what the seam under test reads, and reading
 * the row back afterwards is the same store, so the two observations cannot disagree.
 *
 * @param db - Handle the row is written through.
 * @param stackId - The Stack that owns the duplicate.
 */
async function plantRowDuplicate(db: DatabaseHandle, stackId: string): Promise<void> {
  await saveSourceDocument(db, stackId, SOURCE);
  await saveStoredCandidate(db, stackId, {
    id: DUPLICATE_ID, title: "Stale Candidate", slug: SLUG, summary: "s",
    sources: ["ref.md"], body: `# Stale Candidate\n\nbody\n`,
    generatedAt: "2026-01-01T00:00:00.000Z", reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  });
}

/** The row case's scenario, with the duplicate the live write supersedes already planted. */
interface RowScenario {
  readonly root: string;
  readonly run: NodeJS.ProcessEnv;
  readonly handle: SuiteHandle;
  readonly stackId: string;
}

/**
 * Prepare the database-configured scenario: a Stack the run resolved without naming it, one
 * source to compile, and one pending duplicate of the page that compile will render.
 *
 * The two preconditions the case then asserts — the row is present, the file queue is empty
 * — are NOT proved here, because a helper that asserted would hide which backend supplied
 * the answer the case is about.
 *
 * @returns The root, the run's env, the open handle, and the resolved Stack.
 */
async function rowScenarioWithDuplicate(): Promise<RowScenario> {
  const root = await prepareRun("candidate-seam-rows-");
  const run = runEnv();
  const handle: SuiteHandle = suiteHandle();
  await plantRowDuplicate(handle.db, stackId);
  return { root, run, handle, stackId };
}

describe.skipIf(skipped !== "")("a compile whose Stack the run names", () => {
  it("clears the duplicate in the Stack's row queue and writes no candidate file", async () => {
    const { root, run, handle, stackId } = await rowScenarioWithDuplicate();
    try {
      // Not a comparison of empties: the row is there to be cleared, and the file queue a
      // file-branch run would search holds nothing at all.
      expect((await listStoredCandidates(handle.db, stackId)).map((entry) => entry.id))
        .toEqual([DUPLICATE_ID]);
      expect(await snapshotCandidateQueue(root)).toEqual({});

      expect(await compileAndReport(root, { embeddings: false, env: run })).toMatchObject({ errors: [] });

      expect(await listStoredCandidates(handle.db, stackId)).toEqual([]);
      expect(await snapshotCandidateQueue(root)).toEqual({});
    } finally {
      await handle.close();
    }
  });
});

describe.skipIf(skipped !== "")("a compile with no database configured", () => {
  it("keeps clearing the duplicate from the FILE queue and adds no candidate row", async () => {
    const root = await prepareRun("candidate-seam-files-");
    // The row snapshot is read from OUTSIDE the file-mode window: the run under test must
    // see no database, and the assertion must still be able to look at one.
    const handle: SuiteHandle = suiteHandle();
    try {
      await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
      await writeFile(
        path.join(root, SOURCES_DIR, "topic.md"),
        `---\ntitle: ${SOURCE.title}\n---\n\n${SOURCE.document}`,
        "utf-8",
      );
      const planted = await seedPendingCandidate(root, {
        title: "Stale Candidate", slug: SLUG, summary: "s", sources: ["ref.md"], body: "# Stale\n",
      });
      expect(await snapshotCandidateQueue(root)).toHaveProperty([`${planted}.json`]);
      // The rows this Stack already holds, so the claim below is "the file-mode run added
      // none" rather than a comparison against a queue a row-backed run may have filled.
      const rowsBefore = await listStoredCandidates(handle.db, stackId);

      await withFileMode(async () => {
        expect(await compileAndReport(root, { embeddings: false })).toMatchObject({ errors: [] });
      });

      // File mode written by name: the file queue is the one that answered, and no
      // candidate row appeared in any Stack.
      expect(await snapshotCandidateQueue(root)).toEqual({});
      expect(await listStoredCandidates(handle.db, stackId)).toEqual(rowsBefore);
    } finally {
      await handle.close();
    }
  });
});
