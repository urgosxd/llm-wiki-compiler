/**
 * @file test/fixtures/running-host.ts
 * @description Start a real host on a scratch root and hand back its base URL.
 *
 * ## Why this is shared rather than written twice
 *
 * Two host suites need the same four-step boot — scratch dir, realpath, snapshot,
 * `startHost` on port 0 — and the second copy was flagged as a clone group. The
 * duplication is not the point: a host suite that builds its listener differently
 * from its neighbour is asserting against a different server than the one it thinks
 * it is, and the drift is invisible until one of them stops matching production.
 *
 * `port: 0` is deliberate in both: the OS assigns a free port, so parallel workers
 * never collide on a fixed number.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildViewerSnapshot } from "../../src/viewer/snapshot.js";
import { startHost, type HostHandle } from "../../src/host/server.js";

/** A running host plus the base URL to reach it. */
export interface RunningHost {
  readonly handle: HostHandle;
  readonly base: string;
}

/**
 * Start a host on a fresh scratch project.
 *
 * @param prefix - Distinguishes the temp dirs of suites that run in parallel.
 * @param options - Passed through to `startHost`; `includeGraph` and
 *   `projectRoot` are the usual ones. `projectRoot` decides whether the mutation
 *   endpoints and the MCP mount exist at all, so a suite that needs either must
 *   pass it.
 * @returns The handle and `http://host:port`.
 */
export async function runningHost(
  prefix: string,
  options: {
    includeGraph?: boolean;
    projectRoot?: string;
    mcpServerFactory?: () => { connect(transport: never): Promise<void>; close(): Promise<void> };
  } = {},
): Promise<RunningHost> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  const viewerSnapshot = await buildViewerSnapshot(root);
  const handle = await startHost({ viewerSnapshot, port: 0, ...options });
  return { handle, base: `http://${handle.host}:${handle.port}` };
}
