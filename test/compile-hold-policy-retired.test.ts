/**
 * @file The `review.hold` path is retired: a hold config no longer stages anything.
 *
 * The policy used to route a held page into `.llmwiki/candidates/` instead of `wiki/`.
 * No surface promotes a candidate, so a hold can never be honoured; the same config now
 * writes the page live and the queue stays empty. The compile result also stops
 * promising the review split and the candidate ids that the stager used to produce.
 *
 * The last case is the PRESERVE half of the ruling: candidate records written BEFORE
 * the retirement are data that stops being produced, never data that is destroyed, so
 * the store must still list and read a record planted on disk.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { listCandidates, readCandidate } from "../packages/wiki/src/compiler/candidates.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { CANDIDATES_DIR, CONCEPTS_DIR } from "../packages/wiki/src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const project = useCompileProject({ dirSuffix: "hold-retired" });

/** Stub both LLM phases so the run produces exactly one deterministic page. */
function stubOneLowConfidencePage(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(JSON.stringify({
    concepts: [{
      concept: "Example", summary: "An example.", is_new: true, confidence: 0.1,
      provenance_state: "extracted", contradicted_by: [],
    }],
  }));
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("An example body.\n");
}

/** Configure the policy that used to hold EVERY generated page. */
async function holdEveryPage(): Promise<void> {
  await writeFile(
    path.join(project.dir, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold: ["all"] } }),
    "utf-8",
  );
}

/** The pending queue's record filenames, or an empty list when nothing was staged. */
async function stagedRecordNames(): Promise<string[]> {
  const dir = path.join(project.dir, CANDIDATES_DIR);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith(".json"));
}

describe("a review.hold policy no longer stages a page", () => {
  it("writes the page live and leaves the candidate queue empty", async () => {
    stubOneLowConfidencePage();
    await holdEveryPage();

    const result = await compileAndReport(project.dir);

    expect(result.errors).toEqual([]);
    expect(await readFile(path.join(project.dir, CONCEPTS_DIR, "example.md"), "utf8"))
      .toContain("An example body.");
    expect(await stagedRecordNames()).toEqual([]);
    expect(await listCandidates(project.dir)).toEqual([]);
  });

  it("promises no review split and no candidate ids on the compile result", async () => {
    stubOneLowConfidencePage();

    const result = await compileAndReport(project.dir);

    // @ts-expect-error the review split is retired: with no stager every arm is permanently empty.
    expect(result.review).toBeUndefined();
    // @ts-expect-error candidate ids are retired with the stager that produced them.
    expect(result.candidates).toBeUndefined();
  });
});

describe("a candidate record planted before the retirement stays readable", () => {
  it("lists and reads the stored record with its review reasons intact", async () => {
    const dir = path.join(project.dir, CANDIDATES_DIR);
    await mkdir(dir, { recursive: true });
    const record = {
      id: "legacy-topic-0000000a",
      title: "Legacy Topic",
      slug: "legacy-topic",
      summary: "Planted before the hold path was retired.",
      sources: ["sample.md"],
      body: "---\ntitle: Legacy Topic\n---\n\nLegacy body.\n",
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "policy",
      heldReasons: [{ code: "manual-review-requested" }],
    };
    await writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8");

    const listed = await listCandidates(project.dir);
    expect(listed.map((candidate) => candidate.slug)).toEqual(["legacy-topic"]);
    expect(listed[0]?.heldReasons).toEqual([{ code: "manual-review-requested" }]);
    expect((await readCandidate(project.dir, process.env, record.id))?.body)
      .toContain("Legacy body.");
  });
});
