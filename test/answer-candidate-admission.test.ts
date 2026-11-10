/**
 * Fail-closed versioned answer metadata, while retaining tolerant queue reads.
 * These witnesses exercise disk admission rather than only a schema helper.
 *
 * The records are PLANTED through the shared seed fixture and then corrupted in place,
 * which is the shape the admission rules actually guard: a record that reached the disk
 * by some other route. The case that asserted the writer refuses a bad draft before
 * writing went with `writeCandidate` — nothing produces a record any more.
 */
import { expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { readCandidate, listCandidates,
countCandidates, listCandidatePage, loadCandidateOrFail } from "../packages/wiki/src/compiler/candidates.js";
import { readCandidateSnapshot } from "../packages/wiki/src/compiler/candidate-read.js";
import { InvalidCandidateMetadataError } from "../packages/wiki/src/citations/answer-manifest.js";
import * as output from "../packages/wiki/src/utils/output.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { seedPendingCandidate } from "./fixtures/candidate-queue.js";
import type { ReviewCandidate } from "../packages/wiki/src/utils/types.js";
import { answerDraft, candidateFile, replaceCandidate } from "./fixtures/answer-candidate.js";

const root = useTempRoot();

/** Plant the canonical answer record and return it exactly as the fixture stored it. */
async function seedAnswer(): Promise<ReviewCandidate> {
  const draft = answerDraft();
  const id = await seedPendingCandidate(root.dir, draft);
  return {
    ...draft, id, generatedAt: "2026-01-01T00:00:00.000Z",
    heldReasons: [{ code: "manual-review-requested" }],
  } as ReviewCandidate;
}

it("round trips the exact kind and manifest through all consumed reads", async () => {
  const created = await seedAnswer();
  expect(await readCandidate(root.dir, process.env, created.id)).toEqual(created);
  expect((await readCandidateSnapshot(root.dir, created.id))?.candidate).toEqual(created);
  expect((await listCandidates(root.dir))[0]).toEqual(created);
  expect((await listCandidatePage(root.dir, process.env, 10)).candidates).toEqual([created]);
  expect(await readFile(candidateFile(root.dir, created.id), "utf8")).toBe(JSON.stringify(created, null, 2));
});

it("preserves legacy bytes and omission of both additive fields", async () => {
  const draft = { title: "Old", slug: "old", summary: "", sources: [], body: "Old body" };
  const id = await seedPendingCandidate(root.dir, draft);
  const expected = { ...draft, id, generatedAt: "2026-01-01T00:00:00.000Z",
    reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }] };
  expect(await readFile(candidateFile(root.dir, id), "utf8")).toBe(JSON.stringify(expected, null, 2));
  expect(await readCandidate(root.dir, process.env, id)).toEqual(expected);
});

it.each([
  ["unsupported kind version", { candidateKind: { name: "validated-answer", version: 2 } }],
  ["unknown kind", { candidateKind: { name: "other", version: 1 } }],
  ["extra kind fields", { candidateKind: { name: "validated-answer", version: 1, extra: true } }],
  ["required manifest absent", { citationManifest: undefined }],
  ["orphan manifest", { candidateKind: undefined }],
  ["null kind", { candidateKind: null }],
  ["invalid destination", { targetDirectory: "concepts" }],
  ["typed target", { targetEntityType: "papers" }],
  ["malformed typed target", { targetEntityType: null }],
  ["imported mode", { reviewMode: "imported" }],
  ["nonempty sources", { sources: ["source.md"] }],
  ["connector provenance", { connectorProvenance: null }],
  ["source states", { sourceStates: {} }],
  ["unsafe internal id", { id: "../outside" }],
  ["mismatched internal id", { id: "other" }],
])("skips %s with a named warning and retains original bytes", async (_name, changes) => {
  const created = await seedAnswer();
  const raw = await replaceCandidate(root.dir, created.id, { ...created, ...changes });
  const note = vi.spyOn(output, "note").mockImplementation(() => {});
  expect(await readCandidate(root.dir, process.env, created.id)).toBeNull();
  expect(await listCandidates(root.dir, { strictIo: true })).toEqual([]);
  expect(await countCandidates(root.dir)).toBe(0);
  const targeted = readCandidate(root.dir, process.env, created.id, { rejectInvalidMetadata: true });
  await expect(targeted).rejects.toBeInstanceOf(InvalidCandidateMetadataError);
  await expect(targeted).rejects.toMatchObject({ name: "InvalidCandidateMetadataError", candidateId: created.id });
  expect(await listCandidatePage(root.dir, process.env, 10)).toEqual({ candidates: [], total: 0 });
  expect(note).toHaveBeenCalledWith(expect.stringContaining(`InvalidCandidateMetadata: ${created.id}`));
  expect(await readFile(candidateFile(root.dir, created.id), "utf8")).toBe(raw);
});

it("targeted metadata diagnostics are invalid-candidate rather than not-found", async () => {
  const created = await seedAnswer();
  await replaceCandidate(root.dir, created.id, { ...created, citationManifest: undefined });
  const status = vi.spyOn(output, "status").mockImplementation(() => {});
  try {
    expect(await loadCandidateOrFail(root.dir, process.env, created.id)).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(status.mock.calls.flat().join(" ")).toContain("InvalidCandidateMetadata");
    expect(status.mock.calls.flat().join(" ")).not.toContain("not found");
  } finally { process.exitCode = 0; }
});
