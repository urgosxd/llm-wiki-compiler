/**
 * @file test/compile-request-stack-derived-env.test.ts
 * @description T3/T6/T7 — the derived artifacts belong to the Stack the REQUEST names.
 *
 * ## The defect this pins
 *
 * `generateIndex` and `generateMOC` each ended in `withDerivedSource(process.env, …)`,
 * so a per-request run — ONE process serving MANY Stacks, a different `options.env` per
 * request — rendered its `index.md` / `MOC.md` rows into the AMBIENT Stack while its
 * pages, state and journal went to the request's Stack. With no ambient Stack that
 * failed loudly on `derived_artifact_stack_id_fkey`; with one it was a silent
 * cross-tenant WRITE, one tenant's navigation rendered into another tenant's data.
 *
 * ## Why the ambient half is the assertion that bites
 *
 * "The request's Stack received the artifact" is true of a run that ALSO wrote the
 * ambient Stack, and that is the bug. So each case first proves the ambient Stack's
 * derived set is byte-identical to its pre-run snapshot: nothing written to a tenant
 * that was not asked. The request-side assertion is the second half, not the subject.
 *
 * ## The four cases, and the spec each covers
 *
 * 1. S4 — request env names Stack A, ambient `process.env` names a different Stack B:
 *    A holds both artifacts and B's snapshot is unchanged.
 * 2. S4 (index-only) — the `skipMoc` caller (`query-save`) still stores its index in
 *    the request's Stack and writes no MOC anywhere.
 * 3. S5 — the omitted-env caller (the CLI) keeps writing to the ambient Stack, which
 *    is the previous behaviour this fix must not change.
 * 4. S6 — a REFUSED run (`compileRecompiling` with a page no stored page matches, the
 *    same refusal seam `test/compile-rejected-input-unchanged.test.ts` uses) leaves
 *    both Stacks' derived sets exactly as they were.
 *
 * The Stack pair, the ambient environment binding, the restore and the fresh-id-per-test
 * rule all live in `test/fixtures/request-stack.ts`, which the three request-stack
 * suites share — the rationale for each is documented there.
 */

import { describe, expect, it, vi } from "vitest";
import { compileAndReport, compileRecompiling } from "../packages/wiki/src/compiler/index.js";
import { withDerivedSource } from "../packages/wiki/src/dimensions/wiki/derived-artifact-source.js";
import { createPageWriteSink } from "../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { saveSourceDocument } from "../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { regenerateIndices } from "../packages/wiki/src/dimensions/wiki/page-source-seam.js";
import { AnthropicProvider } from "../packages/wiki/src/providers/anthropic.js";
import { useRequestStacks } from "./fixtures/request-stack.js";

/** The one source the compile extracts into a page. */
const SOURCE = {
  title: "Derived Env Topic",
  source: "https://derived-env.test/topic",
  document: "# Derived Env Topic\n\nSource content for the request Stack.\n",
};

/** A page body the row-backed index and MOC can enumerate. */
const ALPHA = "---\ntitle: Alpha\ntags:\n  - search\n---\n\nbody\n";

/** The refusal `planRecompile` produces for a page no stored page matches. */
const UNKNOWN_PAGE = "concepts/missing";
const UNKNOWN_PAGE_REFUSAL = `Cannot recompile: no page named "${UNKNOWN_PAGE}" exists in this wiki.`;

/** Both derived artifacts as stored for one environment, `undefined` when absent. */
async function derivedSet(env: NodeJS.ProcessEnv): Promise<Record<string, string | undefined>> {
  return withDerivedSource(env, async (source) => {
    if (source === undefined) return {};
    return { index: await source.read("index"), moc: await source.read("moc") };
  });
}

/** Stub the provider boundary only: extraction and the generated page body. */
function stubProvider(): void {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [{ concept: "Derived Env Topic", summary: "S.", is_new: true }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Body. ^[topic.md]\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("the derived artifacts follow the request's Stack", () => {
  const stacks = useRequestStacks({
    request: "request-derived-env",
    ambient: "ambient-derived-env",
    root: "request-derived-env-",
  });

  /**
   * Give the AMBIENT Stack a real render, the run an omitted-env caller reproduces.
   *
   * Shared because two cases below need that render as a PRECONDITION rather than as
   * their subject: without it "the ambient set is unchanged" would be a comparison of
   * empties. The assertions it performs are the same ones both cases made inline.
   */
  const compileIntoAmbient = async (): Promise<void> => {
    await saveSourceDocument(stacks.ambient.harness.db, stacks.ambientStackId, SOURCE);
    expect(await compileAndReport(stacks.root, { embeddings: false })).toMatchObject({ errors: [] });
  };

  it("stores both artifacts in the request's Stack and leaves the ambient Stack untouched", async () => {
    stubProvider();
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    const ambientBefore = await derivedSet(stacks.ambientEnv);

    expect(await compileAndReport(stacks.root, { embeddings: false, env: stacks.env }))
      .toMatchObject({ errors: [] });

    // The half that bites: one tenant's render must never land in another's rows.
    expect(await derivedSet(stacks.ambientEnv)).toEqual(ambientBefore);
    const stored = await derivedSet(stacks.env);
    expect(stored.index).toContain("Knowledge Wiki");
    expect(stored.moc).toContain("Map of Content");
  });

  it("stores the index alone in the request's Stack for the skipMoc caller", async () => {
    await createPageWriteSink(stacks.request.harness.db, stacks.requestStackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });
    const ambientBefore = await derivedSet(stacks.ambientEnv);

    await regenerateIndices(stacks.root, stacks.env, { skipMoc: true });

    expect(await derivedSet(stacks.ambientEnv)).toEqual(ambientBefore);
    const stored = await derivedSet(stacks.env);
    expect(stored.index).toContain("Alpha");
    expect(stored.moc).toBeUndefined();
  });

  it("still stores both artifacts in the ambient Stack for a caller that passes no environment", async () => {
    stubProvider();
    await compileIntoAmbient();

    const stored = await derivedSet(stacks.ambientEnv);
    expect(stored.index).toContain("Knowledge Wiki");
    expect(stored.moc).toContain("Map of Content");
    // The request's Stack was named by nobody, so it keeps no derived row.
    expect(await derivedSet(stacks.env)).toEqual({ index: undefined, moc: undefined });
  });

  it("leaves both Stacks' derived sets unchanged when the run is refused", async () => {
    stubProvider();
    await saveSourceDocument(stacks.request.harness.db, stacks.requestStackId, SOURCE);
    expect(await compileAndReport(stacks.root, { embeddings: false, env: stacks.env }))
      .toMatchObject({ errors: [] });
    // Both tenants hold a REAL render, so "unchanged" is not a comparison of empties.
    await compileIntoAmbient();
    const requestBefore = await derivedSet(stacks.env);
    const ambientBefore = await derivedSet(stacks.ambientEnv);
    expect(requestBefore.index).toBeDefined();
    expect(ambientBefore.index).toBeDefined();

    expect((await compileRecompiling(stacks.root, [UNKNOWN_PAGE])).errors).toEqual([UNKNOWN_PAGE_REFUSAL]);

    expect(await derivedSet(stacks.env)).toEqual(requestBefore);
    expect(await derivedSet(stacks.ambientEnv)).toEqual(ambientBefore);
  });
});
