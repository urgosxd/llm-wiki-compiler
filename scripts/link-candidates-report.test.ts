/**
 * @file Pin the two artifacts the measurement is judged by: the machine-readable
 * JSON and the hand-labellable markdown.
 *
 * WHY THESE ASSERTIONS LOOK AT PRESENCE, NOT LENGTH. A report whose every list is
 * empty satisfies any "renders without throwing" check, and an empty report is
 * exactly the failure this command must never produce silently. So each rule is
 * pinned on a fixture carrying a known pair at a known cosine: the 0.86 section has
 * to contain `concepts/foo#2 → concepts/bar`, the sample has to render a `- [ ]`
 * line for it, and a corpus whose coverage came back short has to say so in the
 * JSON rather than look like a corpus that simply had nothing.
 *
 * The determinism assertion is byte equality of two renders, because the whole
 * point of a seeded sample is that two people measuring the same corpus label the
 * SAME pairs -- and a timestamp or an unordered map anywhere in here would break
 * that without failing any single-value check.
 */

import { expect, it } from "vitest";

import {
  CANDIDATE_THRESHOLDS,
  DEFAULT_SAMPLE_SEED,
  DEFAULT_SAMPLE_SIZE,
  type RawCandidatePair,
} from "./link-candidates.ts";
import { redactSecrets, type CorpusMeasurement } from "./link-candidates-db.ts";
import { buildReport, renderReportJson, renderReportMarkdown } from "./link-candidates-report.ts";

/** Row counts a healthy run would see, reused by every fixture. */
const COUNTS = { pages: 28, pageEmbeddings: 28, chunkEmbeddings: 71 };

/**
 * Build a raw candidate pair, defaulting everything a test does not state.
 *
 * @param overrides - The fields this test cares about.
 * @returns A complete raw pair.
 */
function pair(overrides: Partial<RawCandidatePair> = {}): RawCandidatePair {
  return {
    corpus: "wiki-28",
    paragraphId: "concepts/foo#2",
    documentId: "concepts/foo",
    conceptId: "concepts/bar",
    conceptTitle: "Bar",
    conceptNames: ["Bar"],
    cosine: 0.9123,
    paragraphText: "The permission matrix is reviewed quarterly.",
    // A document-level mention is the signal this channel is looking for: the
    // paragraph does not name the concept, the page does.
    documentText: "Bar is described here once, in passing.",
    ...overrides,
  };
}

/**
 * Build a corpus measurement around the given pairs.
 *
 * @param pairs - The pairs this corpus yielded.
 * @param overrides - The fields this test cares about.
 * @returns A complete measurement.
 */
function measurement(
  pairs: readonly RawCandidatePair[],
  overrides: Partial<CorpusMeasurement> = {},
): CorpusMeasurement {
  return {
    spec: { stackId: "7f1b3b36-540a-4f8d-ae40-8f2ede8ef92c", label: "wiki-28" },
    skipped: false,
    skipReason: null,
    counts: COUNTS,
    rankingCalls: 28,
    coverageComplete: true,
    shortfallConcepts: 0,
    readOnly: { before: COUNTS, after: COUNTS, identical: true },
    pairs: [...pairs],
    ...overrides,
  };
}

/** Five pairs that all land in the 0.86 stratum, so the sample has to be cut. */
const HIGH_STRATUM_PAIRS: readonly RawCandidatePair[] = [
  pair(),
  pair({ paragraphId: "concepts/foo#3", conceptId: "concepts/baz", conceptTitle: "Baz", conceptNames: ["Baz"], cosine: 0.9 }),
  pair({ paragraphId: "concepts/foo#4", conceptId: "concepts/qux", conceptTitle: "Qux", conceptNames: ["Qux"], cosine: 0.88 }),
  pair({ paragraphId: "concepts/foo#5", conceptId: "concepts/quux", conceptTitle: "Quux", conceptNames: ["Quux"], cosine: 0.87 }),
  pair({ paragraphId: "concepts/foo#6", conceptId: "concepts/corge", conceptTitle: "Corge", conceptNames: ["Corge"], cosine: 0.865 }),
];

it("renders exactly one section per threshold, and every threshold the core declares", () => {
  const markdown = renderReportMarkdown(
    buildReport([measurement(HIGH_STRATUM_PAIRS)], {
      thresholds: CANDIDATE_THRESHOLDS,
      sampleSize: 2,
      seed: DEFAULT_SAMPLE_SEED,
    }),
  );

  for (const threshold of ["0.86", "0.80", "0.75"]) {
    expect(markdown.match(new RegExp(`^### threshold ${threshold} .*$`, "gmu"))).toHaveLength(1);
  }
  expect(markdown.match(/^### threshold /gmu)).toHaveLength(CANDIDATE_THRESHOLDS.length);
});

it("renders a sampled pair as the exact hand-labellable line the labeler fills in", () => {
  const markdown = renderReportMarkdown(
    buildReport([measurement([pair()])], {
      thresholds: CANDIDATE_THRESHOLDS,
      sampleSize: 1,
      seed: DEFAULT_SAMPLE_SEED,
    }),
  );

  expect(markdown).toContain("- [ ] 1. cos=0.9123 paragraph=concepts/foo#2 concept=concepts/bar documentMention=yes verdict=[ ]");
  expect(markdown).toContain('      excerpt: "The permission matrix is reviewed quarterly."');
});

it("bounds the sample by the requested size, and never exceeds the stratum", () => {
  const report = buildReport([measurement(HIGH_STRATUM_PAIRS)], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 2,
    seed: DEFAULT_SAMPLE_SEED,
  });

  expect(report.corpora[0]?.thresholds[0]?.incrementalCount).toBe(5);
  expect(report.corpora[0]?.thresholds[0]?.sample).toHaveLength(2);
  expect(renderReportMarkdown(report).match(/^- \[ \] \d+\. /gmu)).toHaveLength(2 * CANDIDATE_THRESHOLDS.length);
});

it("states that a stratum is empty instead of printing an empty table", () => {
  const covered = pair({ paragraphText: "The Bar permission matrix is reviewed quarterly." });
  const markdown = renderReportMarkdown(
    buildReport([measurement([covered])], {
      thresholds: CANDIDATE_THRESHOLDS,
      sampleSize: DEFAULT_SAMPLE_SIZE,
      seed: DEFAULT_SAMPLE_SEED,
    }),
  );

  expect(markdown).toContain("_No incremental pairs at this threshold");
  // One candidate DID reach the thresholds here, so the lexical claim is the true one.
  expect(markdown).toContain("every candidate in the slice is already produced by a lexical channel");
  expect(markdown).not.toContain("No pair reached this threshold");
  expect(markdown).not.toContain("| cosine | paragraph | concept |");
});

it("says no pair reached a threshold that held no candidates, and never blames lexical match", () => {
  const markdown = renderReportMarkdown(
    buildReport([measurement([])], {
      thresholds: CANDIDATE_THRESHOLDS,
      sampleSize: DEFAULT_SAMPLE_SIZE,
      seed: DEFAULT_SAMPLE_SEED,
    }),
  );

  // The heading is asserted too: a claim check alone would pass on an empty document.
  expect(markdown).toContain("### threshold 0.86 — 0 candidates, 0 excluded by lexical match, 0 incremental");
  for (const threshold of ["0.86", "0.80", "0.75"]) {
    expect(markdown).toContain(
      `_No pair reached this threshold: nothing in the slice scored cosine ≥ ${threshold}._`,
    );
  }
  // Zero candidates means nothing scored high enough; lexical exclusion did not empty it.
  expect(markdown).not.toContain("already produced by a lexical channel");
});

it("renders the same report byte for byte twice, so two readers label the same sample", () => {
  const report = buildReport([measurement(HIGH_STRATUM_PAIRS)], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 2,
    seed: DEFAULT_SAMPLE_SEED,
  });

  expect(renderReportMarkdown(report)).toBe(renderReportMarkdown(report));
  expect(renderReportJson(report)).toBe(renderReportJson(report));
});

it("carries the per-threshold counts and every S6 field into the incremental list", () => {
  const report = buildReport([measurement(HIGH_STRATUM_PAIRS)], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 1,
    seed: DEFAULT_SAMPLE_SEED,
  });
  const top = report.corpora[0]?.thresholds[0];

  expect(top).toMatchObject({ threshold: 0.86, candidateCount: 5, excludedByLexicalCount: 0, incrementalCount: 5 });
  expect(top?.incremental[0]).toMatchObject({
    corpus: "wiki-28",
    paragraphId: "concepts/foo#2",
    conceptId: "concepts/bar",
    cosine: 0.9123,
    documentMention: true,
    excerpt: "The permission matrix is reviewed quarterly.",
  });
});

it("records a short-coverage corpus as incomplete rather than as a corpus with no candidates", () => {
  const json = JSON.parse(
    renderReportJson(
      buildReport([measurement([pair()], { coverageComplete: false, shortfallConcepts: 3 })], {
        thresholds: CANDIDATE_THRESHOLDS,
        sampleSize: 1,
        seed: DEFAULT_SAMPLE_SEED,
      }),
    ),
  ) as { corpora: { coverageComplete: boolean; shortfallConcepts: number }[] };

  expect(json.corpora[0]?.coverageComplete).toBe(false);
  expect(json.corpora[0]?.shortfallConcepts).toBe(3);
});

it("keeps a skipped corpus in the JSON with its reason, and says so in the markdown", () => {
  const skipped = measurement([], {
    skipped: true,
    skipReason: "no page embeddings stored for this stack",
    counts: null,
    rankingCalls: 0,
    coverageComplete: false,
    readOnly: null,
  });

  expect(JSON.parse(renderReportJson(buildReport([skipped], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 1,
    seed: DEFAULT_SAMPLE_SEED,
  }))).corpora[0]).toMatchObject({
    label: "wiki-28",
    skipped: true,
    skipReason: "no page embeddings stored for this stack",
  });
  expect(renderReportMarkdown(buildReport([skipped], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 1,
    seed: DEFAULT_SAMPLE_SEED,
  }))).toContain("_Skipped: no page embeddings stored for this stack_");
});

it("leaves an empty verdict slot in both artifacts and never carries a DSN", () => {
  const withDsn = pair({
    paragraphId: "concepts/foo#7",
    conceptId: "concepts/dsn",
    conceptTitle: "Dsn",
    conceptNames: ["Dsn"],
    cosine: 0.79,
    paragraphText: "Replication reads postgresql://svc:leak-me@db.internal:5432/aks on boot.",
  });
  const report = buildReport([measurement([pair(), withDsn])], {
    thresholds: CANDIDATE_THRESHOLDS,
    sampleSize: 2,
    seed: DEFAULT_SAMPLE_SEED,
  });
  const json = renderReportJson(report);

  expect(JSON.parse(json).corpora[0].thresholds[0].sample[0].verdict).toBe("");
  expect(json).not.toContain("leak-me");
  expect(json).not.toContain("postgresql://svc");
  expect(renderReportMarkdown(report)).not.toContain("leak-me");
  expect(redactSecrets(json)).toBe(json);
});
