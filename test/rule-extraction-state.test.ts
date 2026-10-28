/**
 * Tests for rule-extraction state + approval-preservation (the rule pipeline blockers).
 *
 * `rules extract` must (a) advance its OWN change-detection cursor in
 * `.llmwiki/rule-state.json` so an unchanged source is not re-extracted every
 * run, and (b) never overwrite a human's approve/reject decision. The LLM tool
 * call is stubbed via vi.spyOn so extraction is deterministic and offline.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { rm } from "fs/promises";
import path from "path";
import { extractRuleCandidates } from "../src/compiler/rule-extractor.js";
import {
  listRuleCandidates,
  setRuleCandidateStatus,
} from "../src/compiler/rule-candidates.js";
import { candidateFileId } from "../src/utils/candidate-store.js";
import { RULE_STATE_FILE } from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { withStackEnv } from "./fixtures/stack-env.js";
import {
  restoreProviderEnvAfterEach,
  seedRuleSource as seedSource,
  stubRuleExtraction,
} from "./fixtures/rule-extraction.js";

const NOW = "2026-05-31T00:00:00.000Z";

/** Out-of-bounds end line (past the 2-line source) to exercise span dropping. */
const OUT_OF_BOUNDS_END = 9999;

restoreProviderEnvAfterEach();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rule extraction state cursor", () => {
  const ctx = useTempRoot(["sources"]);

  it("does not re-process an unchanged source on a second run", () => withStackEnv("rule-state", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();
    const first = await extractRuleCandidates(ctx.dir, NOW);
    expect(first.processedSources).toEqual(["guide.md"]);

    const second = await extractRuleCandidates(ctx.dir, NOW);
    expect(second.processedSources).toEqual([]);
    expect(second.candidates).toHaveLength(0);
    // The cursor lives in rows now. A file here would mean the run silently fell
    // back to the backend this change removes.
    const { access } = await import("node:fs/promises");
    const onDisk = await access(path.join(ctx.dir, ".llmwiki", RULE_STATE_FILE))
      .then(() => true, () => false);
    expect(onDisk).toBe(false);
  }));
});

describe("approval preservation", () => {
  const ctx = useTempRoot(["sources"]);

  it("does not overwrite an approved candidate when the source is re-extracted", () => withStackEnv("rule-state", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction();
    const { candidates } = await extractRuleCandidates(ctx.dir, NOW);
    await setRuleCandidateStatus(ctx.dir, candidateFileId(candidates[0]!.id), "approved");

    // Force re-extraction by clearing the cursor. It is a ROW now, so this deletes
    // the row -- unlinking a file would be a no-op and the assertion would prove
    // nothing. The Stack is the one this test provisioned, so the clear is scoped.
    const { createDimensionsDatabase } = await import("../src/dimensions/activation.js");
    const { clearRuleExtractorState } = await import("../src/dimensions/wiki/marker-store.js");
    const stackId = process.env.AKS_STACK_ID!;
    const handle = createDimensionsDatabase();
    try {
      await clearRuleExtractorState(handle.db, stackId);
    } finally {
      await handle.close();
    }
    const rerun = await extractRuleCandidates(ctx.dir, NOW);

    const listed = await listRuleCandidates(ctx.dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("approved");
    expect(rerun.candidates).toHaveLength(0);
    expect(rerun.notes.some((n) => n.includes("approved"))).toBe(true);
  }));
});

describe("evidence span bounding + category sanitization", () => {
  const ctx = useTempRoot(["sources"]);

  it("drops an out-of-bounds evidence line and emits an import-valid id", () => withStackEnv("rule-state", async () => {
    await seedSource(ctx.dir);
    await stubRuleExtraction("Code Review", OUT_OF_BOUNDS_END);
    const { candidates } = await extractRuleCandidates(ctx.dir, NOW);
    const candidate = candidates[0]!;

    // category had a space -> underscored segment; id passes the rule importer's regex.
    expect(candidate.id).toMatch(/^rulecand\.code_review\.[a-z0-9-]+$/);
    // evidenceLineEnd was 9999 (past the 2-line source) -> dropped.
    const ref = candidate.evidence[0]!;
    expect(ref.kind).toBe("file");
    expect("lineEnd" in ref ? ref.lineEnd : undefined).toBeUndefined();
  }));
});
