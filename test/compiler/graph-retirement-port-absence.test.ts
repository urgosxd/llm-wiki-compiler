/**
 * @file test/compiler/graph-retirement-port-absence.test.ts
 * @description A stackless compile with graph retirement DISABLED completes, never
 * asks a port for dimensions, and opens no connection for the graph — and omitting
 * the port entirely is still a working compile.
 *
 * ## Why this property needed a pin
 *
 * The Stack pre-check survives this slice on purpose: routing it through the port
 * would turn "graph disabled → no work, no connection, no throw" into a throw for
 * every stackless wiki-only compile, which is the ordinary case. Nothing pinned
 * that, so the obvious-looking refactor ("it mentions dimensions, so move it into
 * the port") would fail silently in review and loudly only for embedders.
 *
 * ## How "no connection" is observed without a seam
 *
 * The compiler builds its own database handle, so a handle cannot be injected and a
 * probe cannot be put under one. Two honest observations stand in for that, and
 * neither is dressed up as more than it is:
 *
 *   - the connection string names a port nothing answers, so a graph resolution that
 *     QUERIED would fail the run rather than pass it quietly;
 *   - the supplied port throws if it is called at all, so any dimension resolution
 *     for the graph — the only thing that would need the graph's handle — is loud.
 *
 * Together they say "no graph connection was attempted". They do not claim the
 * absence of a handle object, which is built lazily and connects on first query.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { DimensionsPort, DimensionsRequest } from "../../packages/wiki/src/sdk/core-types.js";
import type { Dimension } from "../../packages/wiki/src/dimensions/types.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceProject } from "./retirement-port-project.js";

/** A connection string nothing answers: any query against it fails the run. */
const UNREACHABLE_DSN = "postgresql://aks:aks@127.0.0.1:1/aks";

/** A bare checkout: no Stack id, and the switch left at its `wiki`-only default. */
const DEFAULT_SWITCH_ENV: NodeJS.ProcessEnv = { AKS_DATABASE_URL: UNREACHABLE_DSN };

/** The same checkout with the wiki named out loud, which is also graph-disabled. */
const WIKI_ONLY_ENV: NodeJS.ProcessEnv = { ...DEFAULT_SWITCH_ENV, LLMWIKI_DIMENSIONS: "wiki" };

/**
 * A port that records the request it received and then refuses the run.
 *
 * Throwing is the point: for a graph-disabled compile the port must never be asked,
 * so being asked has to surface as a failure naming this reason rather than as a
 * quietly skipped retirement.
 *
 * @param received - Sink the request is pushed into, in call order.
 * @returns A port that must never be called on these paths.
 */
function loudPort(received: DimensionsRequest[]): DimensionsPort<Dimension> {
  return {
    resolve: (request) => {
      received.push(request);
      throw new Error(
        "graph retirement is disabled, so no port may be asked to resolve dimensions",
      );
    },
  };
}

describe("a stackless compile with graph retirement disabled", () => {
  let root: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function project(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), "retirement-absence-"));
    await seedDeletedSourceProject(root);
    captureProcessIo();
    return root;
  }

  it.each([
    ["the switch is unset", DEFAULT_SWITCH_ENV],
    ["the switch names the wiki alone", WIKI_ONLY_ENV],
  ])("completes without being asked for dimensions when %s", async (_label, env) => {
    const dir = await project();
    const received: DimensionsRequest[] = [];

    const result = await compileAndReport(dir, {
      env,
      embeddings: false,
      dimensionsPort: loudPort(received),
    });

    expect(received).toEqual([]);
    expect(result.errors).toEqual([]);
    // The deletion really was processed, so the run reached the point where
    // retirement would have resolved dimensions had the graph been enabled.
    expect(result.deleted).toBe(1);
  }, 60_000);

  it("still compiles through the SDK with the port omitted (a real run)", async () => {
    const dir = await project();
    // The SDK's compile guards the chat provider before running the pipeline, so a
    // credential has to exist for the call to be reached at all. No extraction runs:
    // the project has a deletion and no source to compile.
    vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-used-by-this-case");

    const result = await createWiki({ root: dir, env: DEFAULT_SWITCH_ENV }).compile({
      embeddings: false,
    });

    expect(result).toMatchObject({ errors: [], deleted: 1 });
  }, 60_000);
});
