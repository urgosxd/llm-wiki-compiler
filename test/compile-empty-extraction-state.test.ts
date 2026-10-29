/**
 * A source whose re-extraction returns ZERO concepts already in the wiki must not
 * be recorded as a FAILED extraction.
 *
 * WHY THIS EXISTS
 *
 * Extraction sends the existing concept titles to the model as dedup context
 * (`buildExtractionPrompt`'s index section). On a second compile the model
 * correctly answers `{"concepts": []}` — a valid, deliberate empty array, not a
 * malformed response. `freezeFailedExtractions` treated every empty result as a
 * failure, so it wrote `hash: ""` into source state. An empty hash never matches
 * the source's real digest, so every later compile re-extracted the whole
 * document again — paying full model latency forever — and reported
 * "no concepts — will retry" on a source that was already fully compiled.
 *
 * The distinction this pins: an empty-but-valid extraction is settled work; only
 * an unparseable extraction stays frozen for retry.
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { readState } from "../src/utils/state.js";
import { mockReconciliationProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "empty-extraction-state",
  sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha evidence about a durable subject.",
});

/** Answer extraction with one concept on the first pass, then a valid empty list. */
function mockDeduplicatedProvider() {
  const provider = mockReconciliationProvider();
  let call = 0;
  provider.toolCall.mockImplementation(async () => {
    call += 1;
    const concepts = call === 1
      ? [{ concept: "Durable Subject", summary: "The subject persists.", is_new: true, confidence: 0.9 }]
      : [];
    return JSON.stringify({ concepts });
  });
  provider.complete.mockResolvedValue("Supported content about the durable subject.");
  return provider;
}

describe("empty re-extraction is settled, not failed", () => {
  it("keeps the real content hash when the model returns no NEW concepts", async () => {
    const provider = mockDeduplicatedProvider();

    await compileAndReport(ctx.dir);
    const firstHash = (await readState(ctx.dir)).sources["alpha.md"]?.hash ?? "";
    expect(firstHash).not.toBe("");

    await writeFile(path.join(ctx.dir, "sources/alpha.md"), "# Alpha\n\nAlpha evidence about a durable subject, revised.");
    await compileAndReport(ctx.dir);

    const secondHash = (await readState(ctx.dir)).sources["alpha.md"]?.hash ?? "";
    expect(secondHash).not.toBe("");
    expect(secondHash).not.toBe(firstHash);
    expect(provider.toolCall).toHaveBeenCalledTimes(2);
  });
});
