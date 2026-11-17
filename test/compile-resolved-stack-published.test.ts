/**
 * @file test/compile-resolved-stack-published.test.ts
 * @description T9 — a compile that RESOLVED its Stack from the database must publish
 * that id into the environment every downstream seam receives.
 *
 * ## The defect this pins
 *
 * `compiler/index.ts` (at the resolution boundary) derives ONE environment for the run
 * and resolves ONE Stack authority from it, and then hands the env — not the authority —
 * to everything below. The resolved id is never written back, so every seam whose
 * backend decision is `env[AKS_STACK_ID_ENV_VAR] === "" ? file : rows` sees an EMPTY id
 * in a database-resolved compile and serves the FILE backend while the pages, the state
 * and the candidates all go to rows:
 *
 *  - `utils/activity-log.ts` → `withJournalSource` journals the compile into `log.md`
 *    instead of the Stack's activity-log rows;
 *  - `compiler/indexgen.ts` / `compiler/obsidian.ts` → `withDerivedSource` writes
 *    `wiki/index.md` and `wiki/MOC.md` to disk instead of the Stack's derived rows —
 *    which is S15's split backend: the SCAN of those two functions is row-backed (it is
 *    handed the resolved authority separately) while their WRITE is file-backed;
 *  - `sources/selection.ts` → `loadSourceSelection(root, env)` reads the checkout's
 *    `config.json` instead of the Stack's config row.
 *
 * The entry points that already do this correctly — the MCP tool path through
 * `mcp/tenant-db.ts`, the host API through `buildIngestEnv`, the ingest job — all
 * publish the resolved id into the env they hand downstream. This suite measures the
 * compile boundary against that same mechanism.
 *
 * ## The discriminating property, and why not just "a Stack is configured"
 *
 * The environment CONFIGURES the database and NAMES NO STACK: `AKS_DATABASE_URL` is
 * set and `AKS_STACK_ID` is absent. That is the only shape in which the two answers
 * differ — a named id is published trivially, and a database-less environment is the
 * named `file` authority, which must publish nothing at all. The Stack is therefore
 * never named by this file: it is provisioned by the resolver the code under test
 * calls, exactly as a first-time deployment provisions it.
 *
 * ## What is asserted, and why THESE observations
 *
 * WHERE THE RESULT LANDED, never a message: the Stack's activity-log rows gained the
 * compile entry, the Stack's derived rows gained both renders, and the three files that
 * the file backend would have written are ABSENT from disk. Each of the three pairs is
 * one seam, so the run cannot pass by publishing into one place and not the others.
 *
 * The rows are read through the STORES (`readJournalEntries`, `readDerivedArtifact`),
 * not through the seams under test: asking `withJournalSource` whether the journal is
 * in rows would let a broken seam answer for itself.
 *
 * ## The file-mode pin
 *
 * File mode must keep working, and with a NAME rather than by absence: the same compile
 * with no database configured writes `log.md`, `wiki/index.md` and `wiki/MOC.md`, and
 * adds no row to any Stack. A FILE authority publishes NOTHING into the env, so this
 * case is additionally the pin that the publication is conditional — an unconditional
 * `env[AKS_STACK_ID_ENV_VAR] = ""` would still pass it, which is why the row case also
 * proves the id is really there rather than merely not empty.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";
import { describe, expect, it } from "vitest";

import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { readJournalEntries } from "../packages/wiki/src/dimensions/wiki/activity-log-store.js";
import { readDerivedArtifact } from "../packages/wiki/src/dimensions/wiki/derived-artifact-store.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { INDEX_FILE, LOG_FILE, MOC_FILE, SOURCES_DIR } from "../packages/wiki/src/utils/constants.js";
import { extractionAnswer, stubCompileProvider } from "./fixtures/compile-provider.js";
import { usePerCaseFileMode, withFileMode } from "./fixtures/file-mode.js";
import { useResolvedStackSuite } from "./fixtures/resolved-stack-suite.js";
import type { SuiteHandle } from "./fixtures/resolved-stack-suite.js";

// This file has BOTH modes — a row-backed case and a file-backed pin — so the mode is
// declared per case. Without this the file-wide hook would strip the database from the
// row case as well.
usePerCaseFileMode();

/** The one source the compile extracts into a page. */
const SOURCE = {
  title: "Published Stack Topic",
  source: "https://published-stack.test/topic",
  document: "# Published Stack Topic\n\nSource content for the published Stack boundary.\n",
};

/** The page body the stub provider renders for that source. */
const PAGE_BODY = "Body. ^[topic.md]\n";

/**
 * The scenario, from the fixture both lock-and-publish suites share: a per-run database,
 * an environment that NAMES NO STACK, and this file's offline provider.
 *
 * The database is left published into the environment: the row case reads the DSN from
 * it, and the file-mode case reads its rows back from an explicit handle, so neither case
 * has to hold a captured URL.
 */
const { skipped, runEnv, suiteHandle, tempRoot, stackId } = await useResolvedStackSuite({
  context: "test/compile-resolved-stack-published.test.ts",
  beforeEach: () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "offline-key";
  },
});

/**
 * The three files the FILE backend writes for this boundary, as the ones present.
 *
 * A list rather than three booleans so one assertion names every stray write at once:
 * a run that published for the journal and not for the artifacts is a run that still
 * has a split backend, and the failure has to say so instead of leaving it implied.
 *
 * @param root - Project root the compile ran in.
 * @returns The repository-relative paths that exist under it, in a stable order.
 */
function filesWritten(root: string): string[] {
  return [LOG_FILE, INDEX_FILE, MOC_FILE].filter((file) => existsSync(path.join(root, file)));
}

/** Every row one Stack holds in the two tables this boundary writes. */
interface StackRows {
  readonly journal: string[];
  readonly derived: { readonly index: string | undefined; readonly moc: string | undefined };
}

/**
 * The journal operations and both derived renders one Stack holds.
 *
 * @param db - Handle to read through.
 * @param stackId - The Stack to read.
 * @returns Its journal operation tags and its two renders.
 */
async function stackRows(db: DatabaseHandle, stackId: string): Promise<StackRows> {
  return {
    journal: (await readJournalEntries(db, stackId)).map((entry) => entry.operation),
    derived: {
      index: await readDerivedArtifact(db, stackId, "index"),
      moc: await readDerivedArtifact(db, stackId, "moc"),
    },
  };
}

/**
 * Assert this run served the ROW backend at every seam that decides row-vs-file.
 *
 * One assertion per seam, so a run that published for the journal but not for the
 * derived artifacts — S15's split backend, still — cannot pass. The files come first:
 * the defect's visible trace is what the file backend wrote to the checkout.
 *
 * @param root - Project root the compile ran in.
 * @param db - Handle to read the Stack's rows through.
 * @param stackId - The Stack the run resolved.
 */
async function expectRowBackend(root: string, db: DatabaseHandle, stackId: string): Promise<void> {
  // No file of the file backend was written: `log.md` (the activity-log seam), and
  // `wiki/index.md` / `wiki/MOC.md` (the derived-artifact seam, which is S15's split:
  // the scan was row-backed already and the write follows it only now).
  expect(filesWritten(root)).toEqual([]);
  const rows = await stackRows(db, stackId);
  expect(rows.journal).toEqual(["compile"]);
  expect(rows.derived.index).toBeDefined();
  expect(rows.derived.moc).toBeDefined();
}

/**
 * Compile one source into the Stack the database resolver answers, naming no Stack.
 *
 * The precondition is asserted HERE, not in the case: these rows start empty and the
 * file backend is what a run that never publishes the resolved id fills instead, so
 * "the rows gained the run" is a real difference and not a comparison of empties.
 *
 * @returns The project root, the open handle to read the rows through, and the Stack.
 */
async function compileIntoResolvedStack(): Promise<{
  readonly root: string;
  readonly handle: SuiteHandle;
  readonly stackId: string;
}> {
  stubCompileProvider({ extraction: () => extractionAnswer(["Published Stack Topic"]), body: () => PAGE_BODY });
  const root = await tempRoot("stack-published-rows-");
  const run = runEnv();
  const handle = suiteHandle();
  // The Stack this suite created and names, not one the resolver would have provisioned.
  await saveSourceDocument(handle.db, stackId, SOURCE);
  expect(await stackRows(handle.db, stackId)).toEqual(
    { journal: [], derived: { index: undefined, moc: undefined } },
  );
  expect(await compileAndReport(root, { embeddings: false, env: run })).toMatchObject({ errors: [] });
  return { root, handle, stackId };
}

describe.skipIf(skipped !== "")("a compile whose Stack the run names", () => {
  it("publishes the resolved id to the journal and the derived artifacts, and writes neither file", async () => {
    const { root, handle, stackId } = await compileIntoResolvedStack();
    try {
      await expectRowBackend(root, handle.db, stackId);
    } finally {
      await handle.close();
    }
  });

  it("keeps the FILE backend byte-identical when no database is configured", async () => {
    stubCompileProvider({ extraction: () => extractionAnswer(["Published Stack Topic"]), body: () => PAGE_BODY });
    const root = await tempRoot("stack-published-files-");
    // Read the row snapshot from OUTSIDE the file-mode window: the run under test must
    // see no database, and the assertion must still be able to look at one.
    const handle = suiteHandle();
    try {
      const before = await stackRows(handle.db, stackId);

      await withFileMode(async () => {
        await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
        await writeFile(
          path.join(root, SOURCES_DIR, "topic.md"),
          "---\ntitle: Published Stack Topic\n---\n\n" + SOURCE.document,
          "utf-8",
        );

        expect(await compileAndReport(root, { embeddings: false })).toMatchObject({ errors: [] });
      });

      // File mode written by name: the journal and both renders are FILES.
      expect(filesWritten(root)).toEqual([LOG_FILE, INDEX_FILE, MOC_FILE]);
      // ...and no row appeared in any Stack, so the publication is conditional.
      expect(await stackRows(handle.db, stackId)).toEqual(before);
    } finally {
      await handle.close();
    }
  });
});
