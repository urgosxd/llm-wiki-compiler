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
 * from the LIVE state draft, and `forgetDeletedSources` then reads
 * `state.sources[change.file]?.source` from that same object, finds nothing and skips
 * the source. Graph retirement therefore retires nothing through `compile`, with or
 * without a supplied port. That is a pre-existing gap outside this slice's scope: it is
 * reported, not pinned here, because a case asserting it would enshrine it. What IS
 * proven is the seam this slice adds — the run composes or accepts a port and calls it
 * with the request it resolved, before that lookup is ever reached.
 *
 * ## Why this case needs a database
 *
 * Retirement is only reached with the graph enabled, and with the graph enabled the
 * Stack pre-check provisions the default Stack when the environment names none. That
 * provisioning is a real query, so the case runs against the shared harness database,
 * and the default Stack row it leaves behind is the same one other suites leave. Every
 * other seam stays file-backed because no Stack id is configured.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import type { DimensionsPort, DimensionsRequest } from "../../packages/wiki/src/sdk/core-types.js";
import type { Dimension, DimensionName } from "../../packages/wiki/src/dimensions/types.js";
import { DATABASE_URL, createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceProject } from "./retirement-port-project.js";

/** The environment that enables the graph without naming a Stack. */
const GRAPH_ENV: NodeJS.ProcessEnv = { AKS_DATABASE_URL: DATABASE_URL, LLMWIKI_DIMENSIONS: "kg" };

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
