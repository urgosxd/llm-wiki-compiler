/**
 * @file test/dimensions/candidates-wired.test.ts
 * @description The candidate store answers from rows when a Stack is configured.
 *
 * ## The property this proves
 *
 * These tests do not check that a row can be written — `candidate-store.test.ts`
 * already covers the table. They check the WIRING: that a Stack-backed run reaches
 * the table at all, and that it leaves `.llmwiki/candidates` untouched. A migration
 * that writes rows while still writing files is the failure mode this project has hit
 * three times, and every one of them looked green in a store test.
 *
 * ## Why "no directory" is the assertion
 *
 * The file backend creates the directory on the way to writing a leaf. Asserting the
 * directory is absent therefore proves the file path was never entered, which is
 * stronger than asserting a particular file is missing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteCandidate, listCandidates, readCandidate, writeCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";
import { createProbeStack, type ProbeStack } from "./harness-lifecycle.js";

let probe: ProbeStack;
let root: string;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  probe = await createProbeStack("cand-wired");
  root = await mkdtemp(path.join(tmpdir(), "cand-wired-"));
  saved = { ...process.env };
  Object.assign(process.env, probe.env());
});

afterEach(async () => {
  process.env = saved;
  await probe.harness.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** The draft every case stages; the id and timestamp are assigned by the writer. */
function draft(title: string) {
  return {
    title,
    slug: title.toLowerCase(),
    summary: `${title} summary`,
    sources: ["sources/a.md"],
    body: `---\ntitle: ${title}\n---\n\nbody\n`,
  };
}

/** True when `.llmwiki/candidates` exists under the project root. */
async function candidateDirExists(): Promise<boolean> {
  return await access(path.join(root, CANDIDATES_DIR)).then(() => true, () => false);
}

describe("candidates wired to rows", () => {
  it("writes to rows and creates no candidates directory", async () => {
    const written = await writeCandidate(root, draft("Alpha"));

    expect(written.id).toBeTruthy();
    expect(await candidateDirExists()).toBe(false);
    expect((await listCandidates(root)).map((c) => c.id)).toEqual([written.id]);
  });

  it("reads back what it wrote, optionals included", async () => {
    const written = await writeCandidate(root, {
      ...draft("Beta"),
      promptModifiers: "digest-1",
      confidence: 0.5,
    });

    // `targetDirectory` is the one field that does not round-trip identically: the
    // column is NOT NULL DEFAULT 'concepts', so an absent value reads back as the
    // default. That is correct rather than lossy -- every consumer tests
    // `=== "queries" ? ... : "concepts"`, so absent and 'concepts' already mean the
    // same thing. Asserted explicitly so a real loss cannot hide behind the default.
    const stored = await readCandidate(root, written.id);
    expect(stored).toEqual({ ...written, targetDirectory: "concepts" });
    expect(stored?.promptModifiers).toBe("digest-1");
    expect(stored?.confidence).toBe(0.5);
  });

  it("re-proposing the same target UPDATES the row instead of adding one", async () => {
    // The file path reached this by searching the directory for a matching target
    // key. A row already holds that key, so the id is reused and the queue stays one.
    const first = await writeCandidate(root, draft("Gamma"));
    const second = await writeCandidate(root, draft("Gamma"));

    expect(second.id).toBe(first.id);
    expect(await listCandidates(root)).toHaveLength(1);
  });

  it("deletes from rows, and reports the honest answer", async () => {
    const written = await writeCandidate(root, draft("Delta"));

    expect(await deleteCandidate(root, written.id)).toBe(true);
    // Already gone: the caller's signal that the queue entry was consumed.
    expect(await deleteCandidate(root, written.id)).toBe(false);
    expect(await listCandidates(root)).toEqual([]);
  });

  it("never writes a validated answer under an existing id", async () => {
    // An answer must not overwrite the candidate that produced it, which is the one
    // rule that survives the move from files unchanged.
    //
    // The answer shape is dictated by the manifest validator: exclusive `queries`
    // destination, forced review, and empty sources. Spelling it out here rather
    // than loosening the validator keeps the rule where it belongs.
    const answer = {
      title: "Epsilon",
      slug: "epsilon",
      summary: "an answer",
      sources: [] as string[],
      body: "---\ntitle: Epsilon\n---\n\nanswer\n",
      reviewMode: "forced" as const,
      targetDirectory: "queries" as const,
      candidateKind: { name: "validated-answer" as const, version: 1 as const },
      // bodyDigest must be 64 hex characters: the manifest schema refuses anything
      // else, so a short placeholder would test the validator rather than the wiring.
      citationManifest: { version: 1 as const, bodyDigest: "a".repeat(64), citations: [] },
    };
    const first = await writeCandidate(root, answer);
    const second = await writeCandidate(root, answer);

    // A fresh id every time, so the queue holds two rather than the second replacing
    // the first.
    expect(second.id).not.toBe(first.id);
    expect(await listCandidates(root)).toHaveLength(2);
  });
});

describe("rejection on a Stack-backed project", () => {
  it("rejects a candidate without touching a candidate directory", async () => {
    // `review reject` archived by moving the queue FILE. A row has no file to move,
    // so the unmigrated path failed outright -- the candidate stayed pending and the
    // command reported "could not be archived safely".
    const written = await writeCandidate(root, draft("Zeta"));

    const { archiveRejectedCandidate } = await import("../../src/compiler/candidate-rejection.js");
    expect(await archiveRejectedCandidate(root, written.id)).toBe(true);
    expect(await candidateDirExists()).toBe(false);
    expect(await listCandidates(root)).toEqual([]);
  });
});

describe("other candidate entry points", () => {
  it("writeFreshCandidate publishes to rows without a candidate directory", async () => {
    // Typed staging supersede and validated answers call this directly, bypassing
    // writeCandidate. It was still allocating through the filesystem allocator.
    const { writeFreshCandidate } = await import("../../src/compiler/candidates.js");
    const fresh = await writeFreshCandidate(root, draft("Eta"));

    expect(fresh.id).toBeTruthy();
    expect(await candidateDirExists()).toBe(false);
    expect(await listCandidates(root)).toHaveLength(1);
  });

  it("deleteCandidateBySlug removes every row for one concepts slug", async () => {
    const { deleteCandidateBySlug } = await import("../../src/compiler/candidates.js");
    await writeCandidate(root, draft("Theta"));

    expect(await deleteCandidateBySlug(root, "theta")).toBe(true);
    expect(await listCandidates(root)).toEqual([]);
    // Nothing left to match: the honest answer, same as the file path's false.
    expect(await deleteCandidateBySlug(root, "theta")).toBe(false);
  });
});

describe("profile update gates on the Stack queue", () => {
  it("sees a pending candidate on a Stack-backed project", async () => {
    // The gate inspected `.llmwiki/candidates` with confinedEntries, which answers
    // "absent" on a Stack-backed project because the directory does not exist -- so a
    // template update could proceed with review candidates still unresolved.
    await writeCandidate(root, draft("Iota"));

    const { auditCandidateStore } = await import("../../src/profile/templates/history-audit.js");
    const reasons = await auditCandidateStore(root);
    expect(reasons.some((reason) => /pending review candidates/.test(reason))).toBe(true);
  });
});
