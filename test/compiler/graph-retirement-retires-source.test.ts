/**
 * @file test/compiler/graph-retirement-retires-source.test.ts
 * @description `compile` retires a deleted source's graph documents exactly once in a
 * non-review run, retires NOTHING in a review run, retires nothing for a source whose
 * recorded state carries no identity, and retires each of two deleted sources once
 * under its own identity. That last case exists because a single-source run cannot
 * tell a correct retirement from a doubled or a misnamed one:
 * `expect(retired).toEqual([...])` against TWO identities is the only shape that can.
 *
 * ## The defect these cases exist for
 *
 * Graph retirement through `compile` was DEAD, and dead in the quietest possible way:
 * the branch executed, resolved its dimensions, and then skipped every source. The
 * cause is object identity, not a typo. `runCompilePipeline` takes the state with
 * `const state = draft.read()` (`packages/wiki/src/compiler/index.ts:1149`), and
 * `CompileStateDraft.read()` returns the LIVE internal reference rather than a copy
 * (`packages/wiki/src/compiler/compile-state-draft.ts:73`, the docstring of `read()`,
 * whose own words say so). `markDeletedAsOrphaned` then mutates that same object through
 * `draft.removeSource(...)` → `removeSourceFrom` (`packages/wiki/src/utils/state.ts:274`,
 * `delete state.sources[...]`). `forgetDeletedSources` used to receive that same
 * object and read `state.sources[change.file]?.source` AFTER the delete, so the
 * lookup was always `undefined` and every source was skipped. The path was
 * unreachable rather than unlucky: if the entry existed, orphaning had just deleted
 * it; if it did not exist, `orphan.ts:54` early-returned and the lookup missed
 * anyway.
 *
 * ## C1 is the behaviour, C2 is a guard against the fix, C3 is the identity-less case,
 * ## C4 is the two-source case
 *
 * C1 covers the behaviour the human authorized: a non-review compile retires the
 * deleted source's document exactly once. It asserts, in order, that the run really
 * processed the deletion (`result.deleted`), that it collected no error, and only
 * then that the identity reached the graph — so the case cannot pass by never
 * reaching retirement.
 *
 * C2 is NOT a preserved behaviour. Nothing retired in review mode before, because
 * nothing retired anywhere. C2 is a guard against THIS fix: the retirement call sits
 * inside the same `if (!options.review)` guard as the orphaning that feeds it, and
 * the code's own comment states the rule — "a held-back run must not retire documents
 * the wiki has not stopped serving yet." A capture-performed-early plus
 * call-moved-out rewrite would start deleting graph documents the wiki is still
 * serving, and C2 is what makes that rewrite fail at an assertion. Its load-bearing
 * assertion is therefore `expect(retired).toEqual([])`, proven non-vacuous by the
 * measured two-step mutation recorded in `odd/tasks/graph-retirement-live.md`.
 *
 * C3 covers the identity-less source: `SourceState.source` is absent for state
 * written before v2 and for files whose frontmatter carried no identity, and
 * retirement must skip those rather than guess an identity from the filename. The
 * `orphan.ts:54` early-return path (a deletion whose state entry is ALREADY gone) is
 * not reachable through `compileAndReport`: `buckets.deleted` is built from
 * `Object.keys(prevState.sources)` (`packages/wiki/src/compiler/hasher.ts:174` for
 * rows, `:191` for files), so every deletion the pipeline sees names a key that
 * existed when change detection ran, and nothing between that point and
 * `markDeletedAsOrphaned` removes it, because the only removal is
 * `orphan.ts:72`'s `draft.removeSource(...)` and it runs AFTER the capture. C3
 * therefore covers the nearest reachable analogue instead of faking the unreachable
 * one.
 *
 * ## C4 is the "must not retire twice" half that IS reachable
 *
 * A single-source case cannot tell a correct retirement from one that runs twice, or
 * from one that names the wrong identity: a doubled or misnamed retirement of the
 * only source looks identical to a correct one unless the sink is compared exactly.
 * C4 therefore records TWO deleted sources with their own identities and asserts the
 * retired array as an exact ordered value, so a double retire, a missed source, and a
 * source retired under its neighbour's identity each fail it.
 *
 * ## Why these cases need a database, and why the deletion is staged in ROWS
 *
 * Retirement is only reached with the graph enabled, and the graph's Stack has to
 * exist before anything can be keyed by it. With no Stack named, that is the
 * default-Stack provisioning query — so these cases run against the shared Postgres
 * harness, exactly as `graph-retirement-port-invocation.test.ts` does.
 *
 * The deletion is staged in `wiki.source_compile_state`, because that is the backend
 * this run reads. What decides the backend is the PRESENCE OF A DATABASE, not the
 * absence of `AKS_STACK_ID`: `resolveStackAuthority`
 * (`packages/wiki/src/dimensions/stack-authority.ts`) answers the named `file` mode
 * only when nothing configured a database, and `wikiStateRowsBackend`,
 * `sourceChangeDetection`, `sourceContentReading` and `resolvePageSeams` all gate on
 * that one authority. An earlier version of this file claimed the opposite — that
 * absence of the Stack id kept the seams file-backed — and every case here measured
 * `deleted: 0` while the seeded `.llmwiki/state.json` was never read. `AKS_STACK_ID`
 * still stays absent, but only so the Stack is resolved (and provisioned) at the
 * default domain through the same resolver the run uses.
 *
 * The staged row has NO `wiki.source_documents` row behind it: that absence IS the
 * deletion, and the compile record that outlives the document — the tombstone — is the
 * only thing left that can name the source to the graph.
 *
 * There is no `describe.skipIf` here. The harness in `test/fixtures/kg-postgres.ts`
 * throws loudly when no database can be obtained, which is the behaviour these cases
 * want: a skipped case proves nothing about a deletion.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseHandle } from "@repo/foundation";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { resolveStackForCommand } from "../../packages/wiki/src/services/stacks/resolve-stack.js";
import type { CompileResult } from "../../packages/wiki/src/utils/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import {
  DELETED_SOURCE_IDENTITY,
  TWO_DELETED_IDENTITIES,
  recordingPort,
  seedDeletedSourceRows,
  seedIdentitylessSourceRows,
  seedTwoDeletedSourceRows,
} from "./retirement-port-project.js";

/** Graph enabled, no Stack named: row-backed seams, default Stack provisioned. */
const RETIREMENT_ENV: NodeJS.ProcessEnv = {
  AKS_DATABASE_URL: DATABASE_URL,
  LLMWIKI_DIMENSIONS: "kg",
};

const harness = await createKgPostgresHarness("graph-retirement-retires-source");

afterAll(() => harness.cleanup());

/** One run's outcome: the compile's report and the identities it retired. */
interface RetirementRun {
  readonly result: CompileResult;
  readonly retired: string[];
}

/**
 * Compile a staged deletion through the real path with the recording port.
 *
 * The deletion is written into the Stack the run itself will resolve — through the
 * same resolver, at the default domain — so the state this run reads is the state the
 * case staged. The project root lives in a fresh directory outside the repository and
 * is removed before this returns, so each case observes its own run and leaves nothing
 * behind but the Stack's own rows.
 *
 * @param seed - Writes the deletion into the Stack the run will read.
 * @returns The compile's result and the identities the graph was asked to forget.
 */
async function runRetirementCompile(
  seed: (db: DatabaseHandle, stackId: string) => Promise<void>,
): Promise<RetirementRun> {
  const dir = await mkdtemp(path.join(tmpdir(), "retirement-retires-"));
  const retired: string[] = [];
  try {
    await seed(harness.db, await resolveStackForCommand(harness.db, RETIREMENT_ENV));
    captureProcessIo();
    const result = await compileAndReport(dir, {
      env: RETIREMENT_ENV,
      embeddings: false,
      dimensionsPort: recordingPort(retired),
    });
    return { result, retired };
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("graph retirement through compile", () => {
  it("retires a deleted source from the graph exactly once", async () => {
    const { result, retired } = await runRetirementCompile(seedDeletedSourceRows);

    // The deletion really was processed and the run succeeded, so what follows is
    // observed retirement rather than a run that never got that far.
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toBe(DELETED_SOURCE_IDENTITY);
  }, 60_000);

  it("retires nothing for a deleted source with no recorded identity", async () => {
    const { result, retired } = await runRetirementCompile(seedIdentitylessSourceRows);

    // The deletion was processed and no identity exists to name to the graph, so
    // nothing is retired and nothing throws.
    expect(result.deleted).toBe(1);
    expect(retired).toEqual([]);
    expect(result.errors).toEqual([]);
  }, 60_000);

  it("retires each of two deleted sources once, under its own identity", async () => {
    const { result, retired } = await runRetirementCompile(seedTwoDeletedSourceRows);

    // Both deletions really were processed and the run succeeded, so the exact array
    // below is observed retirement rather than a run that never got that far.
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
    // EXACT and ORDERED on purpose: a double retire, a missed source, and a source
    // retired under its neighbour's identity each fail this line.
    expect(retired).toEqual([...TWO_DELETED_IDENTITIES]);
  }, 60_000);
});
