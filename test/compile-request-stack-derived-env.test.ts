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
 * ## Why every Stack id is a fresh `randomUUID()`
 *
 * The container behind the test database is long-lived, so a row or an advisory lock
 * leaked by an earlier probe outlives the run that leaked it; a shared id would let
 * that leak masquerade as this file's subject.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileAndReport, compileRecompiling } from "../src/compiler/index.js";
import { withDerivedSource } from "../src/dimensions/wiki/derived-artifact-source.js";
import { createPageWriteSink } from "../src/dimensions/wiki/page-write-sink.js";
import { saveSourceDocument } from "../src/dimensions/wiki/source-documents-store.js";
import { regenerateIndices } from "../src/dimensions/wiki/page-source-seam.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { lockRegistry } from "../src/utils/lock-postgres.js";
import { scratchProjectRoot } from "./fixtures/host-scratch.js";
import { perRunDatabase } from "./fixtures/per-run-database.js";
import { provisionStack, type ProvisionedStack } from "./fixtures/stack-harness.js";

/** This process's own database; provisioning fails loudly rather than skipping. */
const DSN = (await perRunDatabase()).url;

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
  let request: ProvisionedStack;
  let ambient: ProvisionedStack;
  let root = "";
  let requestStackId = "";
  let ambientStackId = "";
  let env: NodeJS.ProcessEnv;
  let ambientEnv: NodeJS.ProcessEnv;
  const savedEnv = { stackId: process.env.AKS_STACK_ID, dsn: process.env.AKS_DATABASE_URL };

  beforeEach(async () => {
    request = await provisionStack("request-derived-env");
    ambient = await provisionStack("ambient-derived-env");
    root = await scratchProjectRoot("request-derived-env-");
    requestStackId = request.harness.stackId;
    // The AMBIENT Stack is a different, REAL Stack on purpose: a missing one would fail
    // loudly on the foreign key instead of performing the cross-tenant write measured here.
    ambientStackId = ambient.harness.stackId;
    expect(ambientStackId).not.toBe(requestStackId);
    env = { AKS_STACK_ID: requestStackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
    ambientEnv = { AKS_STACK_ID: ambientStackId, AKS_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
    process.env.AKS_STACK_ID = ambientStackId;
    process.env.AKS_DATABASE_URL = DSN;
  });

  afterEach(async () => {
    // A leaked entry is a live reserved connection holding a session-level lock.
    for (const held of lockRegistry.values()) void held.release().catch(() => {});
    lockRegistry.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const [name, value] of [
      ["AKS_STACK_ID", savedEnv.stackId],
      ["AKS_DATABASE_URL", savedEnv.dsn],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await request.release();
    await ambient.release();
    await rm(root, { recursive: true, force: true });
  });

  it("stores both artifacts in the request's Stack and leaves the ambient Stack untouched", async () => {
    stubProvider();
    await saveSourceDocument(request.harness.db, requestStackId, SOURCE);
    const ambientBefore = await derivedSet(ambientEnv);

    expect(await compileAndReport(root, { embeddings: false, env })).toMatchObject({ errors: [] });

    // The half that bites: one tenant's render must never land in another's rows.
    expect(await derivedSet(ambientEnv)).toEqual(ambientBefore);
    const stored = await derivedSet(env);
    expect(stored.index).toContain("Knowledge Wiki");
    expect(stored.moc).toContain("Map of Content");
  });

  it("stores the index alone in the request's Stack for the skipMoc caller", async () => {
    await createPageWriteSink(request.harness.db, requestStackId)({
      directory: "concepts", slug: "alpha", body: ALPHA,
    });
    const ambientBefore = await derivedSet(ambientEnv);

    await regenerateIndices(root, env, { skipMoc: true });

    expect(await derivedSet(ambientEnv)).toEqual(ambientBefore);
    const stored = await derivedSet(env);
    expect(stored.index).toContain("Alpha");
    expect(stored.moc).toBeUndefined();
  });

  it("still stores both artifacts in the ambient Stack for a caller that passes no environment", async () => {
    stubProvider();
    await saveSourceDocument(ambient.harness.db, ambientStackId, SOURCE);

    expect(await compileAndReport(root, { embeddings: false })).toMatchObject({ errors: [] });

    const stored = await derivedSet(ambientEnv);
    expect(stored.index).toContain("Knowledge Wiki");
    expect(stored.moc).toContain("Map of Content");
    // The request's Stack was named by nobody, so it keeps no derived row.
    expect(await derivedSet(env)).toEqual({ index: undefined, moc: undefined });
  });

  it("leaves both Stacks' derived sets unchanged when the run is refused", async () => {
    stubProvider();
    await saveSourceDocument(request.harness.db, requestStackId, SOURCE);
    expect(await compileAndReport(root, { embeddings: false, env })).toMatchObject({ errors: [] });
    // Both tenants hold a REAL render, so "unchanged" is not a comparison of empties.
    await saveSourceDocument(ambient.harness.db, ambientStackId, SOURCE);
    expect(await compileAndReport(root, { embeddings: false })).toMatchObject({ errors: [] });
    const requestBefore = await derivedSet(env);
    const ambientBefore = await derivedSet(ambientEnv);
    expect(requestBefore.index).toBeDefined();
    expect(ambientBefore.index).toBeDefined();

    expect((await compileRecompiling(root, [UNKNOWN_PAGE])).errors).toEqual([UNKNOWN_PAGE_REFUSAL]);

    expect(await derivedSet(env)).toEqual(requestBefore);
    expect(await derivedSet(ambientEnv)).toEqual(ambientBefore);
  });
});
