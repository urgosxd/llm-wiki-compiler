/**
 * @file Public-default compatibility: an unrelated malformed candidate is
 * retained and skipped, not promoted into a global compile prerequisite.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { CandidateRecordMalformedError } from "../packages/wiki/src/compiler/candidate-read.js";
import { selectCandidateEntriesForMutation } from "../packages/wiki/src/compiler/candidate-selection.js";
import { listCandidates, writeCandidate } from "../packages/wiki/src/compiler/candidates.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const project = useCompileProject({ dirSuffix: "candidate-preflight" });

/**
 * Stub both LLM phases and stand up one unrelated malformed candidate record.
 *
 * The candidate is the SUBJECT of the cases below and never of the compile run itself: it
 * is written to the queue, left unparseable, and its survival is asserted afterwards.
 *
 * @returns Absolute path of the malformed candidate file.
 */
async function stubCompileWithMalformedCandidate(): Promise<string> {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(JSON.stringify({ concepts: [{
    concept: "Example", summary: "An example.", is_new: true, confidence: 0.9,
    provenance_state: "extracted", contradicted_by: [],
  }] }));
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("An example body.\n");
  await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
  const malformed = path.join(project.dir, ".llmwiki", "candidates", "broken.json");
  await writeFile(malformed, "{");
  return malformed;
}

/** Hold every generated page, so the run stages a candidate instead of writing the page. */
async function holdEveryPage(): Promise<void> {
  const document = JSON.stringify({ version: 1, review: { hold: ["all"] } });
  await writeFile(path.join(project.dir, ".llmwiki", "config.json"), document);
}

/**
 * Assert the run succeeded and left the malformed candidate exactly as it found it.
 *
 * Shared by the two branch cases below because it is the property BOTH must hold: an
 * unrelated unparseable record is skipped, never rewritten and never fatal.
 *
 * @param result - The compile result the run reported.
 * @param malformed - Absolute path of the candidate the run had to skip.
 */
async function expectCleanRun(
  result: Awaited<ReturnType<typeof compileAndReport>>,
  malformed: string,
): Promise<void> {
  expect(result.errors).toEqual([]);
  expect(await readFile(malformed, "utf8")).toBe("{");
}

describe("public-default candidate discovery", () => {
  it("does not let an unrelated oversized leaf block a normal candidate", async () => {
    await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
    const large = "x".repeat(5 * 1024 * 1024);
    const file = path.join(project.dir, ".llmwiki", "candidates", "large.json");
    await writeFile(file, large);
    await expect(writeCandidate(project.dir, process.env, {
      title: "Small", slug: "small", summary: "", sources: [], body: "Small body",
    })).resolves.toMatchObject({ slug: "small" });
    expect(await readFile(file, "utf8")).toBe(large);
  });

  it("compiles and writes the page live despite an unrelated malformed candidate", async () => {
    const malformed = await stubCompileWithMalformedCandidate();
    const result = await compileAndReport(project.dir);

    await expectCleanRun(result, malformed);
    expect(await readFile(path.join(project.dir, "wiki", "concepts", "example.md"), "utf8"))
      .toContain("An example body.");
  });

  it("compiles and stages the page under a policy hold despite an unrelated malformed candidate", async () => {
    const malformed = await stubCompileWithMalformedCandidate();
    await holdEveryPage();

    const result = await compileAndReport(project.dir);
    await expectCleanRun(result, malformed);
    expect((await listCandidates(project.dir)).map((candidate) => candidate.slug)).toEqual(["example"]);
  });

  it("still refuses malformed authority when a strict operation explicitly selects it", async () => {
    await mkdir(path.join(project.dir, ".llmwiki", "candidates"));
    await writeFile(path.join(project.dir, ".llmwiki", "candidates", "broken.json"), "{");
    await expect(selectCandidateEntriesForMutation(project.dir, () => true))
      .rejects.toBeInstanceOf(CandidateRecordMalformedError);
  });
});
