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
 * ## Why these cases need a database, and why AKS_STACK_ID is deliberately absent
 *
 * Retirement is only reached with the graph enabled, and the graph's Stack has to
 * exist before anything can be keyed by it. With no Stack named, that is the
 * default-Stack provisioning query — so these cases run against the shared Postgres
 * harness, exactly as `graph-retirement-port-invocation.test.ts` does.
 *
 * `AKS_STACK_ID` is absent ON PURPOSE, and that absence is load-bearing:
 *
 *   - it is what keeps the compile's state, change detection and page seams
 *     FILE-backed (`wikiStateRowsBackend`, `sourceChangeDetection`,
 *     `sourceContentReading` and `resolvePageSeams` all gate on that one variable),
 *     so the seeded `.llmwiki/state.json` really is the state this run reads — with
 *     the variable set, the draft would read `source_compile_state` rows instead and
 *     the seed would be invisible;
 *   - it is what keeps the run's mutation lock off Postgres (`lock.ts`
 *     `databaseUrlFor` returns `undefined` for the file-backed path), so a database
 *     problem cannot masquerade as a retirement result.
 *
 * There is no `describe.skipIf` here. The harness in `test/fixtures/kg-postgres.ts`
 * throws loudly when no database can be obtained, which is the behaviour these cases
 * want: a skipped case proves nothing about a deletion.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import type { DimensionsPort } from "../../packages/wiki/src/sdk/core-types.js";
import type { Dimension, DimensionName } from "../../packages/wiki/src/dimensions/types.js";
import { STATE_FILE } from "../../packages/wiki/src/utils/constants.js";
import type {
  CompileOptions, CompileResult, SourceState, WikiState,
} from "../../packages/wiki/src/utils/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceProject } from "./retirement-port-project.js";

/** Identity the seed records for the missing source. */
const DELETED_SOURCE_IDENTITY = "https://example.test/deleted-source";

/** Identities the two-source seed records, in the order the state holds them. */
const TWO_DELETED_IDENTITIES = ["https://example.test/a", "https://example.test/b"] as const;

/** Graph enabled, no Stack named: file-backed seams, default Stack provisioned. */
const RETIREMENT_ENV: NodeJS.ProcessEnv = {
  AKS_DATABASE_URL: DATABASE_URL,
  LLMWIKI_DIMENSIONS: "kg",
};

const harness = await createKgPostgresHarness("graph-retirement-retires-source");

afterAll(() => harness.cleanup());

/**
 * One graph dimension that records every retirement and refuses every write phase.
 *
 * Retirement is the only thing this run may ask a dimension for, so a call into
 * `prepare`, `commit` or `discard` has to surface as a failure rather than pass
 * quietly as an unobserved no-op.
 *
 * @param name - Dimension name the retirement helper receives.
 * @param retired - Sink each retired source identity is pushed into, in call order.
 * @returns A dimension whose only reachable capability is `forget`.
 */
function recordingDimension(name: DimensionName, retired: string[]): Dimension {
  const neverCalledByRetirement = async (): Promise<never> => {
    throw new Error("compile retirement must never call a write phase");
  };
  return {
    name,
    prepare: neverCalledByRetirement,
    commit: neverCalledByRetirement,
    discard: neverCalledByRetirement,
    forget: async (source: string) => {
      retired.push(source);
    },
  };
}

/**
 * A port answering with one recording graph dimension.
 *
 * @param retired - Sink the retired identities are pushed into, in call order.
 * @returns A port typed against the published shape.
 */
function recordingPort(retired: string[]): DimensionsPort<Dimension> {
  return { resolve: () => [recordingDimension("kg", retired)] };
}

/**
 * Write a project whose recorded state holds exactly the entries `record` returns.
 *
 * The project SHAPE stays the shared seed's — a `sources/` directory the disk no
 * longer fills and a `state.json` naming files that are gone — so a case states only
 * the recorded entries it wants observed instead of duplicating the seed.
 *
 * @param root - Empty project root to populate.
 * @param record - Derives the entries to record, keyed by source file.
 */
async function seedRecordedSources(
  root: string,
  record: (sources: Record<string, SourceState>) => Record<string, SourceState>,
): Promise<void> {
  await seedDeletedSourceProject(root);
  const stateFile = path.join(root, STATE_FILE);
  const state = JSON.parse(await readFile(stateFile, "utf-8")) as WikiState;
  state.sources = record(state.sources);
  await writeFile(stateFile, JSON.stringify(state), "utf-8");
}

/**
 * Write a project whose one recorded source has NO `source` identity.
 *
 * Built by stripping the identity from the shared seed's state instead of duplicating
 * the seed, which is the shape `SourceState.source` genuinely has for state written
 * before v2 and for sources whose frontmatter carried none.
 *
 * @param root - Empty project root to populate.
 */
async function seedIdentitylessSourceProject(root: string): Promise<void> {
  await seedRecordedSources(root, (sources) => {
    for (const entry of Object.values(sources)) delete entry.source;
    return sources;
  });
}

/**
 * Write a project whose state records TWO deleted sources, each with its own identity.
 *
 * Two sources are what a single-source case cannot express: the sink is asserted as an
 * exact ordered array, which is the only shape that separates one retirement per
 * source from a doubled, a missed, or a misnamed one.
 *
 * @param root - Empty project root to populate.
 */
async function seedTwoDeletedSourcesProject(root: string): Promise<void> {
  await seedRecordedSources(root, (sources) => {
    const [template] = Object.values(sources);
    const [first, second] = TWO_DELETED_IDENTITIES;
    return {
      "a.md": { ...template, hash: `${template.hash}-a`, source: first },
      "b.md": { ...template, hash: `${template.hash}-b`, source: second },
    };
  });
}

/** One run's outcome: the compile's report and the identities it retired. */
interface RetirementRun {
  readonly result: CompileResult;
  readonly retired: string[];
}

/**
 * Compile a seeded deletion project through the real path with the recording port.
 *
 * The project root lives in a fresh directory outside the repository and is removed
 * before this returns, so each case observes its own run and leaves nothing behind.
 *
 * @param seed - Writes the project's recorded state.
 * @param overrides - Compile options the case adds (for example `review`).
 * @returns The compile's result and the identities the graph was asked to forget.
 */
async function runRetirementCompile(
  seed: (dir: string) => Promise<void>,
  overrides: Partial<CompileOptions> = {},
): Promise<RetirementRun> {
  const dir = await mkdtemp(path.join(tmpdir(), "retirement-retires-"));
  const retired: string[] = [];
  try {
    await seed(dir);
    captureProcessIo();
    const result = await compileAndReport(dir, {
      env: RETIREMENT_ENV,
      embeddings: false,
      dimensionsPort: recordingPort(retired),
      ...overrides,
    });
    return { result, retired };
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("graph retirement through compile", () => {
  it("retires a deleted source from the graph exactly once", async () => {
    const { result, retired } = await runRetirementCompile(seedDeletedSourceProject);

    // The deletion really was processed and the run succeeded, so what follows is
    // observed retirement rather than a run that never got that far.
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toBe(DELETED_SOURCE_IDENTITY);
  }, 60_000);

  it("retires nothing when the run is held back for review", async () => {
    const { result, retired } = await runRetirementCompile(
      seedDeletedSourceProject, { review: true },
    );

    // The deletion was processed by this same run — review mode reports it too
    // (measured: `result.deleted` is 1 here), so the case cannot pass by never
    // reaching the point where a moved-out retirement call would fire.
    expect(result).toMatchObject({ deleted: 1, errors: [] });
    // A held-back run leaves the graph alone: the wiki is still serving it.
    expect(retired).toEqual([]);
  }, 60_000);

  it("retires nothing for a deleted source with no recorded identity", async () => {
    const { result, retired } = await runRetirementCompile(seedIdentitylessSourceProject);

    // The deletion was processed and no identity exists to name to the graph, so
    // nothing is retired and nothing throws.
    expect(result.deleted).toBe(1);
    expect(retired).toEqual([]);
    expect(result.errors).toEqual([]);
  }, 60_000);

  it("retires each of two deleted sources once, under its own identity", async () => {
    const { result, retired } = await runRetirementCompile(seedTwoDeletedSourcesProject);

    // Both deletions really were processed and the run succeeded, so the exact array
    // below is observed retirement rather than a run that never got that far.
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
    // EXACT and ORDERED on purpose: a double retire, a missed source, and a source
    // retired under its neighbour's identity each fail this line.
    expect(retired).toEqual([...TWO_DELETED_IDENTITIES]);
  }, 60_000);
});
