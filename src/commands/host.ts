/**
 * @file src/commands/host.ts
 * @description `llmwiki host` — start the unified HTTP listener.
 *
 * ## Why this command exists
 *
 * Before it, no command started `startHost`. `llmwiki view` started the older
 * viewer-only server, and `llmwiki serve` is MCP over stdio, not HTTP. The unified
 * listener — the one that serves the viewer, the graph, and the mutation endpoints
 * from a single port — was reachable only from tests. A surface nobody can start
 * is not a product surface.
 *
 * ## What it serves
 *
 *   /api/ingest, /api/compile   mutations, fail-closed (origin-checked)
 *   /api/**, /                  viewer, fail-closed
 *   /health, /stacks, /aks/v1   graph, fail-open (the vendored server had no auth)
 *
 * The trust split is per-mount, not per-listener: the graph keeps the fail-open
 * behaviour it was measured with, and everything that mutates the project stays
 * behind the origin check.
 *
 * The project root is `process.cwd()`, matching every other command: the CLI
 * operates on the project you are standing in.
 */

import { buildViewerSnapshot } from "../viewer/snapshot.js";
import { startHost } from "../host/server.js";
import { buildReadyUrl, registerShutdown, resolveBindConfig, type BindOptions } from "./serve-bind.js";

/** Parsed CLI options for `llmwiki host`. */
export interface HostCommandOptions extends BindOptions {
  /**
   * Skip the graph sub-app.
   *
   * Explicit rather than inferred from a missing database connection: an implicit
   * "no database means no mount" would make the served surface depend on ambient
   * state, so the same command would serve different routes on different machines.
   */
  readonly noGraph?: boolean;
}

/**
 * Run `llmwiki host`. Resolves once the listener has bound; the process then stays
 * alive until a signal handler closes it, which keeps Commander's exit semantics
 * intact.
 *
 * @param options - Bind flags and the graph opt-out.
 * @throws When the privacy gate rejects the bind configuration.
 */
export default async function hostCommand(options: HostCommandOptions = {}): Promise<void> {
  const { host, port } = resolveBindConfig(options);
  const root = process.cwd();

  // Built before binding so the listener never accepts a request against a
  // half-constructed snapshot.
  const viewerSnapshot = await buildViewerSnapshot(root);
  const handle = await startHost({
    viewerSnapshot,
    host,
    port,
    projectRoot: root,
    ...(options.noGraph === true ? { includeGraph: false } : {}),
  });

  const url = buildReadyUrl(handle.host, handle.port);
  process.stdout.write(`Host ready at ${url}\n`);
  registerShutdown(handle.close);
}
