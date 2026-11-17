/**
 * @file test/compiler/graph-retirement-port-invocation.test.ts
 * @description A port supplied through the compile path is CALLED, with the request
 * the run resolved.
 *
 * ## Why "accepted" is not the claim
 *
 * `CompileOptions.dimensionsPort` is optional, so a compile that destructured it and
 * never forwarded it would compile, typecheck and pass every existing suite while
 * resolving the graph retirement from the ambient path instead. The only observable
 * that separates "forwarded" from "decorative" is a recording fake asked what request
 * it received — the same proof the ingest seam already carries.
 *
 * The fake returns one dimension rather than an empty set, and the request is asserted
 * member by member, so the case shows the run asking its caller's port for the graph
 * alone, with the root, environment and Stack it resolved.
 *
 * ## What this case does NOT claim, and why
 *
 * It does not claim that the returned dimension's `forget` is called. Measured while
 * writing it: `markDeletedAsOrphaned` runs first and removes the deleted source's entry
 * from the LIVE state draft, and `forgetDeletedSources` then read
 * `state.sources[change.file]?.source` from that same object, found nothing and skipped
 * the source. Graph retirement therefore retired nothing through `compile`, with or
 * without a supplied port. That gap has since been fixed — the identities are captured
 * before orphaning — and the retirement itself is pinned by
 * `test/compiler/graph-retirement-retires-source.test.ts`. This case keeps its
 * original, narrower subject so the seam and the behaviour stay separately reviewable:
 * what IS proven here is that the run composes or accepts a port and calls it with the
 * request it resolved.
 *
 * ## Why the first case needs a database
 *
 * Retirement is only reached with the graph enabled, and with the graph enabled the
 * Stack pre-check provisions the default Stack when the environment names none. That
 * provisioning is a real query, so the case runs against the shared harness database,
 * and the default Stack row it leaves behind is the same one other suites leave. Every
 * other seam stays file-backed because no Stack id is configured.
 *
 * ## The second case is the FILE mode, and it needs no database at all
 *
 * With `kg` enabled and NOTHING configured a database, the wiki is legitimately
 * file-backed: its state is `.llmwiki/state.json`, where a removed source IS visible.
 * The graph dimension, in contrast, cannot exist — a graph document is keyed by a
 * Stack, and no Stack exists without a database. So the port must not be asked at all,
 * and it must not cost a connection: the pre-check that would have provisioned the
 * default Stack is what made a database-less compile refuse with
 * `DefaultStackProvisionError` before this case existed. That is why it is asserted as
 * NOT called, with the deletion still observed — the assertion pair is what separates
 * "the graph work was deliberately skipped" from "the run never reached retirement".
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import type { DimensionsPort, DimensionsRequest } from "../../packages/wiki/src/sdk/core-types.js";
import type { Dimension, DimensionName } from "../../packages/wiki/src/dimensions/types.js";
import type { CompileResult } from "../../packages/wiki/src/utils/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceProject } from "./retirement-port-project.js";

/** The environment that enables the graph without naming a Stack. */
const GRAPH_ENV: NodeJS.ProcessEnv = { AKS_DATABASE_URL: DATABASE_URL, LLMWIKI_DIMENSIONS: "kg" };

/**
 * The FILE mode: the graph enabled, and nothing configured a database.
 *
 * Deliberately NOT `process.env` spread, and deliberately without
 * `AKS_DATABASE_URL`: the only thing that makes a run file-backed is the absence of a
 * configured database, which is exactly the named mode this case pins.
 */
const FILE_MODE_ENV: NodeJS.ProcessEnv = { LLMWIKI_DIMENSIONS: "kg" };

const harness = await createKgPostgresHarness("compile-port-invocation");

afterAll(() => harness.cleanup());

/**
 * One graph dimension whose write halves are unreachable.
 *
 * Retirement is the only thing this run can ask a dimension for, so a call into
 * `prepare` or `commit` would mean this case is observing a different path than the
 * one it claims.
 *
 * @param name - Dimension name the retirement helper may receive.
 * @returns A dimension that refuses every write and tolerates a retire.
 */
function graphDimension(name: DimensionName): Dimension {
  const unusedByRetirement = async (): Promise<never> => {
    throw new Error("compile retirement must never call a write phase");
  };
  return {
    name,
    prepare: unusedByRetirement,
    commit: unusedByRetirement,
    discard: async () => undefined,
    forget: async () => undefined,
  };
}

/**
 * A port that records its request and answers with one controllable dimension.
 *
 * @param received - Sink the requests are pushed into, in call order.
 * @returns A port typed against the published shape, not the engine's.
 */
function recordingPort(received: DimensionsRequest[]): DimensionsPort<Dimension> {
  return {
    resolve: (request) => {
      received.push(request);
      return [graphDimension("kg")];
    },
  };
}

describe.skipIf(!harness.reachable)("a supplied port on the compile path", () => {
  let root: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("is called once with the request the run resolved", async () => {
    root = await mkdtemp(path.join(tmpdir(), "compile-port-invocation-"));
    await seedDeletedSourceProject(root);
    captureProcessIo();
    const received: DimensionsRequest[] = [];

    const result = await compileAndReport(root, {
      env: GRAPH_ENV,
      embeddings: false,
      dimensionsPort: recordingPort(received),
    });

    expect(received).toHaveLength(1);
    expect(received[0].only).toEqual(["kg"]);
    expect(received[0].root).toBe(root);
    expect(received[0].env).toBe(GRAPH_ENV);
    expect(received[0].stackId).toEqual(expect.any(String));
    expect(typeof received[0].db).toBe("object");
    expect(result.errors).toEqual([]);
  }, 60_000);
});

/** One file-mode run's outcome: the compile's report, the port's requests, and what it printed. */
interface FileModeRun {
  readonly result: CompileResult;
  readonly received: DimensionsRequest[];
  readonly out: string;
}

/**
 * Compile a seeded deletion project whose run has NO database configured.
 *
 * A fresh directory outside the repository per run, removed before this returns, so
 * each case observes its own compile and leaves nothing behind — the same shape the
 * stack-mode case above uses, with the one difference that makes it file-backed: the
 * environment it is handed.
 *
 * @param env - The run's environment, and the whole of what decides its mode.
 * @returns The compile's result, every request the port received, and the output text.
 */
async function runFileModeCompile(env: NodeJS.ProcessEnv): Promise<FileModeRun> {
  const dir = await mkdtemp(path.join(tmpdir(), "compile-port-file-mode-"));
  const received: DimensionsRequest[] = [];
  try {
    await seedDeletedSourceProject(dir);
    const io = captureProcessIo();
    const result = await compileAndReport(dir, {
      env,
      embeddings: false,
      dimensionsPort: recordingPort(received),
    });
    return { result, received, out: io.out() };
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The two facts EVERY file-mode run below shares, asserted in one place.
 *
 * They are what makes each case non-vacuous: the seeded deletion really was read from
 * FILE state and consumed (`deleted`), the run succeeded (`errors`), and the graph was
 * asked nothing (`received`) — so an empty request list is a skip rather than a run
 * that never reached retirement.
 *
 * @param run - One file-mode compile's outcome.
 */
function expectDeletionProcessedAndGraphUntouched(run: FileModeRun): void {
  expect(run.result.deleted).toBe(1);
  expect(run.result.errors).toEqual([]);
  expect(run.received).toEqual([]);
}

describe("a supplied port on a file-backed compile", () => {
  it("is not called, because no Stack exists for a graph dimension", async () => {
    const run = await runFileModeCompile(FILE_MODE_ENV);

    expectDeletionProcessedAndGraphUntouched(run);
    // And the skip is SAID, naming what was skipped and why it could not be done:
    // a run whose graph retirement did not happen must not report the same success
    // as one where it did.
    expect(run.out).toMatch(/Graph retirement skipped for 1 deleted source\(s\)/);
    expect(run.out).toMatch(/no Stack exists to key a graph document by/);
  }, 60_000);

  it("stays silent about retirement when the graph was never enabled", async () => {
    // THE PRESERVED BEHAVIOUR: a file-backed wiki-only compile — the ordinary case —
    // has no graph work to skip, so it must ask the port nothing AND say nothing about
    // graph retirement. Without this case the announcement above could start firing on
    // every file-mode compile that deletes a source, which is not a skip of anything.
    const run = await runFileModeCompile({});

    expectDeletionProcessedAndGraphUntouched(run);
    expect(run.out).not.toMatch(/Graph retirement skipped/);
  }, 60_000);
});
