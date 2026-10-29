/**
 * `compile.detail` carries real cardinalities that a ratio cannot express.
 *
 * WHY THIS EXISTS
 *
 * The embeddings stage embeds pages AND separately the chunks those pages split
 * into — one measured run turned 93 pages into 442 chunks. A single
 * `{completed,total}` pair cannot carry both, and merging them would be a
 * fabricated number. So the bar keeps pages and the chunk/request counts ride
 * alongside as text, under a contract with two invariants that are easy to break
 * and invisible when broken:
 *
 *   1. ABSENT is not ZERO. A missing field must never read as "zero chunks",
 *      because that is the same class of lie as an invented `progress`.
 *   2. Detail is never folded into `progress`. Different units; a consumer that
 *      added them would imply the bar counts chunks.
 */
import { describe, expect, it } from "vitest";
import { createJobRegistry } from "../src/services/ingest/jobs/registry.js";
import { queuedIngestState, queuedCompileState } from "../src/services/ingest/jobs/types.js";
import { reportCompileStage } from "../src/services/ingest/jobs/compile-observer.js";

const NOW = new Date("2026-10-29T00:00:00.000Z");

/** A registry holding one fresh job, plus its id. */
function seeded() {
  const registry = createJobRegistry();
  const job = registry.create("https://example.test/a.md", NOW);
  return { registry, id: job.id };
}

describe("compile.detail", () => {
  it("publishes chunk and request counts without touching progress", () => {
    const { registry, id } = seeded();
    registry.patchCompile(id, { progress: { completed: 3, total: 8 } }, NOW);
    registry.patchCompile(id, { detail: { chunks: 42, requests: 2 } }, NOW);

    const compile = registry.get(id)?.compile;
    expect(compile?.detail).toEqual({ chunks: 42, requests: 2 });
    // The ratio keeps describing PAGES: 3 of 8, not 3 of 50.
    expect(compile?.progress).toEqual({ completed: 3, total: 8 });
  });

  it("omits a zero count rather than publishing it as zero", () => {
    const { registry, id } = seeded();
    // Production's sink builds this object; the omission rule lives there and is
    // pinned end-to-end in the compile pipeline. Here the contract is that a
    // detail WITHOUT a field stays without it across a patch.
    registry.patchCompile(id, { detail: { requests: 1 } }, NOW);
    expect(registry.get(id)?.compile.detail).toEqual({ requests: 1 });
    expect("chunks" in (registry.get(id)?.compile.detail ?? {})).toBe(false);
  });

  it("removes detail when the stage advances, so it never inherits", () => {
    const { registry, id } = seeded();
    registry.patchCompile(id, { detail: { chunks: 42, requests: 2 } }, NOW);
    const beforeAdvance = registry.get(id)?.compile;
    expect(beforeAdvance?.detail).toEqual({ chunks: 42, requests: 2 });

    reportCompileStage(
      { stage: () => undefined, progress: () => undefined, detail: (d) =>
        registry.patchCompile(id, { detail: d ?? undefined }, NOW) },
      "compile.finalize",
    );

    const compile = registry.get(id)?.compile;
    // Genuinely absent, not an empty object and not undefined-but-present.
    expect(compile?.detail).toBeUndefined();
    expect("detail" in (compile ?? {})).toBe(false);
  });

  it("starts with no detail at all", () => {
    const { registry, id } = seeded();
    expect(registry.get(id)?.compile).toEqual(queuedCompileState());
    expect(registry.get(id)?.ingest).toEqual(queuedIngestState());
  });

  it("survives a status transition so the count is readable when the run ends", () => {
    const { registry, id } = seeded();
    registry.patchCompile(id, { stage: "embeddings", detail: { chunks: 61, requests: 19 } }, NOW);
    // Settling clears `progress` but says nothing about `detail`. Testing the VALUE
    // instead of the key's presence deleted the cardinality on every settle, so it
    // vanished exactly when an operator wants to read it.
    registry.patchCompile(id, { status: "succeeded", progress: null, endedAt: NOW.toISOString() }, NOW);

    const compile = registry.get(id)?.compile;
    expect(compile?.status).toBe("succeeded");
    expect(compile?.progress).toBeNull();
    expect(compile?.detail).toEqual({ chunks: 61, requests: 19 });
  });
});
