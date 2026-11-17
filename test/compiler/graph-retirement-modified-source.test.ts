/**
 * @file test/compiler/graph-retirement-modified-source.test.ts
 * @description `S5` of `odd/tasks/source-compile-state-tombstone.md`: a source that
 * is merely MODIFIED must be recompiled, never retired.
 *
 * ## Why this pin exists beside the retirement cases
 *
 * The compile record of a source now OUTLIVES the source's `wiki.source_documents`
 * row — that is what makes a deletion observable at all (a tombstone, `S3`). The
 * failure mode this pin rules out is the obvious one that durability invites: a
 * tombstone that makes a source look GONE when it merely CHANGED. A compile that
 * retired an edited source would delete the graph's live rows for a document the
 * wiki still serves, which is worse than the bug the tombstone fixes.
 *
 * ## What is asserted, and why these are OUTCOMES
 *
 * The stage is a Stack that compiled one source and then saw its content change, so
 * the next run classifies it `changed` — the row-corpus answer for "the recorded
 * hash is not the document's hash" (`classifyHashedDocument`,
 * `packages/wiki/src/compiler/hasher.ts`). The run is then measured on three
 * outcomes, never on a message:
 *
 *   - `result.deleted` is `0` — the edited source was NOT treated as a deletion;
 *   - `result.compiled` is `1` and `result.skipped` is `0` — it was RECOMPILED, which
 *     is the only field of `CompileResult` that reports an update (`compiled` is
 *     `buckets.toCompile.length`, the same count a new source lands in);
 *   - the retirement port recorded NOTHING — no `forget` was asked for that identity,
 *     which is what would delete the graph rows of a source that still exists.
 *
 * ## Why the run is row-backed, and why that is the interesting half
 *
 * The environment names a database and no Stack, so `resolveStackAuthority` answers
 * `{ kind: "stack" }` at the default domain and every state seam reads ROWS. That is
 * the backend the tombstone lives in, so a stage written to `.llmwiki/state.json`
 * would prove nothing here. The source is compiled with the real writer
 * (`saveSourceDocument`) and its compile record with the real state writer
 * (`writeWikiStateToRows`), then the document is edited through the same writer, so
 * the second state is exactly what an ingest leaves.
 *
 * Only the LLM boundary is stubbed: change detection, the extraction cache, the page
 * write sink and the compile state stay production code.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { resolveStackForCommand } from "../../packages/wiki/src/services/stacks/resolve-stack.js";
import {
  hashSourceContent,
  saveSourceDocument,
  stableSourceContent,
} from "../../packages/wiki/src/dimensions/wiki/source-documents-store.js";
import { writeWikiStateToRows } from "../../packages/wiki/src/dimensions/wiki/wiki-state-source.js";
import type { CompileResult } from "../../packages/wiki/src/utils/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { stubCompileProvider } from "../fixtures/compile-provider.js";
import { recordingPort } from "./retirement-port-project.js";

/** Identity of the source that is edited, not deleted, between the two states. */
const MODIFIED_IDENTITY = "https://example.test/modified-source";

/** The body the source had when the recorded compile happened. */
const COMPILED_CONTENT = "# Modified Topic\n\nThe body this source had when it was compiled.\n";

/** The body the source has now: same identity, different bytes. */
const EDITED_CONTENT = "# Modified Topic\n\nThe body this source has now, after the edit.\n";

/** Graph enabled, no Stack named: rows everywhere, default Stack provisioned. */
const MODIFIED_ENV: NodeJS.ProcessEnv = {
  AKS_DATABASE_URL: DATABASE_URL,
  LLMWIKI_DIMENSIONS: "kg",
};

const harness = await createKgPostgresHarness("graph-retirement-modified-source");

afterAll(() => harness.cleanup());

/**
 * Stub only the LLM boundary: extraction and the generated page body.
 *
 * The two answers are supplied to the shared compile-provider fixture instead of a
 * local pair of `mockResolvedValue` calls, so this case states WHAT the model says
 * and not HOW the stub is installed. Everything the assertions read — change
 * detection, the compile state, the page write sink, the retirement port — stays
 * production code.
 */
function stubModifiedProvider(): void {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-key");
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  stubCompileProvider({
    extraction: () =>
      JSON.stringify({ concepts: [{ concept: "Modified Topic", summary: "M.", is_new: true }] }),
    body: () => "Body content for the topic. ^[modified.md]",
  });
}

/**
 * Stage one Stack that compiled {@link COMPILED_CONTENT} and now holds the edit.
 *
 * Both writes go through the production writers, in the order the real code puts
 * them: the document first (ingest), then the compile record that refers to it. The
 * hash recorded is the hash of the content that was COMPILED, so the edited document
 * is a `changed` source and not a `new` one — which is the only classification that
 * can tell a tombstone from a recompile.
 *
 * @param stackId - Stack to stage.
 */
async function stageCompiledThenEditedSource(stackId: string): Promise<void> {
  const document = { title: "Modified Topic", source: MODIFIED_IDENTITY };
  await saveSourceDocument(harness.db, stackId, { ...document, document: COMPILED_CONTENT });
  await writeWikiStateToRows(harness.db, stackId, {
    version: 2,
    indexHash: "",
    sources: {
      [MODIFIED_IDENTITY]: {
        hash: hashSourceContent(stableSourceContent(COMPILED_CONTENT)),
        concepts: [],
        compiledAt: "2026-01-01T00:00:00.000Z",
        source: MODIFIED_IDENTITY,
      },
    },
  });
  const edit = await saveSourceDocument(harness.db, stackId, {
    ...document, document: EDITED_CONTENT,
  });
  // Non-vacuous staging: the edit really replaced a stored body, so the hash the run
  // compares against cannot be the one it computes.
  expect(edit.writeStatus).toBe("updated");
}

/** One run's outcome: the compile's report and the identities it retired. */
interface ModifiedRun {
  readonly result: CompileResult;
  readonly retired: string[];
}

/**
 * Compile the staged edit through the real path, with the recording port.
 *
 * The project root lives in a fresh directory outside the repository and is removed
 * before this returns, so the case leaves nothing behind but the Stack's own rows.
 *
 * @returns The compile's result and the identities the graph was asked to forget.
 */
async function runModifiedSourceCompile(): Promise<ModifiedRun> {
  const dir = await mkdtemp(path.join(tmpdir(), "retirement-modified-"));
  const retired: string[] = [];
  try {
    await stageCompiledThenEditedSource(await resolveStackForCommand(harness.db, MODIFIED_ENV));
    stubModifiedProvider();
    captureProcessIo();
    const result = await compileAndReport(dir, {
      env: MODIFIED_ENV,
      embeddings: false,
      dimensionsPort: recordingPort(retired),
    });
    return { result, retired };
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("a modified source through compile", () => {
  it("is recompiled, not retired, while its compile record outlives the edit", async () => {
    const { result, retired } = await runModifiedSourceCompile();

    // The edited source is NOT a deletion: nothing to retire, nothing forgotten —
    // which is what would delete the graph rows of a source the wiki still serves.
    expect(result.deleted).toBe(0);
    expect(retired).toEqual([]);
    // And it really was RECOMPILED rather than skipped as unchanged.
    expect(result.compiled).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  }, 120_000);
});
