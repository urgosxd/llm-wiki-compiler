/**
 * An ingest job must show movement while the compile runs, not just a stage name.
 *
 * WHY THIS EXISTS
 *
 * A real job sat at `{"completed": 0, "total": 1}` for all ten minutes of a run
 * that generated 92 pages. Two separate defects produced that:
 *
 *   1. The denominator was `extractions.length` — the number of SOURCE files —
 *      while the unit of work is one generated PAGE per merged concept. One dense
 *      document is one extraction and ninety-two pages, so the bar read "0 of 1"
 *      no matter how much work remained.
 *
 *   2. Nothing published intermediate counts. `reportCompileProgress` was called
 *      on entry and on exit only, so even a correct total would have jumped
 *      straight from 0 to N.
 *
 * These tests pin both halves: the total counts pages, and the counter advances as
 * pages settle. They drive the real compile pipeline with only the provider and
 * embeddings stubbed, so a fix that only edited the reporter would not pass.
 */
import { describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import type { JobProgress } from "../src/services/ingest/jobs/types.js";
import { mockReconciliationProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "ingest-progress",
  sourceFile: "dense.md",
  sourceContent: "# Dense\n\nA dense source naming several distinct subjects.",
});

/** Concepts one dense source yields — far more pages than the one source. */
const CONCEPT_COUNT = 6;

/**
 * Record every progress pair the compile publishes.
 *
 * @returns The live array of reported pairs, to inspect after the run.
 */
function recordingProgress(): JobProgress[] {
  return [];
}

/** Provider stub answering with CONCEPT_COUNT distinct concepts on one source. */
function denseProvider() {
  const provider = mockReconciliationProvider();
  provider.toolCall.mockImplementation(async () =>
    JSON.stringify({
      concepts: Array.from({ length: CONCEPT_COUNT }, (_, index) => ({
        concept: `Subject ${index + 1}`,
        summary: `Summary for subject ${index + 1}.`,
        is_new: true,
        confidence: 0.9,
      })),
    }),
  );
  provider.complete.mockResolvedValue("Supported content about the subject.");
  return provider;
}

describe("ingest job progress", () => {
  it("counts PAGES, not source files, and advances while pages settle", async () => {
    denseProvider();
    const seen = recordingProgress();

    await compileAndReport(ctx.dir, {
      jobObserver: {
        ingest: { stage: () => undefined },
        attempts: { attemptStarted: () => undefined, attemptSettled: () => undefined },
        compile: {
          stage: () => undefined,
          progress: (value) => {
            if (value !== null) seen.push(value);
          },
          detail: () => undefined,
        },
      },
    });

    // Extraction counts SOURCES (one here) and page generation counts PAGES
    // (CONCEPT_COUNT). Both are real denominators for their own stage; what must
    // never happen is generation reporting the source count.
    const totals = [...new Set(seen.map((entry) => entry.total))];
    expect(totals).toContain(CONCEPT_COUNT);

    // The counter moves through intermediate values: a run that only published
    // 0 and N would leave the UI looking frozen for the whole stage.
    const distinctCompleted = [...new Set(seen.map((entry) => entry.completed))].sort(
      (a, b) => a - b,
    );
    expect(distinctCompleted.length).toBeGreaterThan(2);
    expect(distinctCompleted[0]).toBe(0);
    expect(distinctCompleted.at(-1)).toBe(CONCEPT_COUNT);

    // Monotonic per total: progress must never go backwards.
    for (const total of totals) {
      const series = seen.filter((entry) => entry.total === total).map((e) => e.completed);
      expect(series).toEqual([...series].sort((a, b) => a - b));
    }

    await rm(path.join(ctx.dir, "sources", "dense.md"), { force: true });
    await writeFile(path.join(ctx.dir, "sources", "dense.md"), "# Dense\n\nA dense source naming several distinct subjects.", "utf-8");
  });
});
