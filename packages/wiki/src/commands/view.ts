/**
 * CLI handler for `llmwiki view` — the local read-only web viewer.
 *
 * Responsibilities:
 *   - parse and validate the host/port/allow-lan symmetry (spec
 *     §Non-Negotiable Security Requirements: non-loopback bind requires
 *     BOTH `--allow-lan` AND `--host <host>`; either alone exits 1)
 *   - build the frozen `ViewerSnapshot` once at startup
 *   - start the HTTP server and emit a parseable readiness line so
 *     test fixtures (and the user) know what URL to point a browser at
 *   - register SIGINT / SIGTERM handlers for graceful shutdown
 */

import { spawn } from "child_process";
import { startViewer } from "../viewer/server.js";
import { buildReadyUrl, registerShutdown, resolveBindConfig } from "./serve-bind.js";

/** Parsed CLI options. */
interface ViewCommandOptions {
  port?: string | number;
  host?: string;
  allowLan?: boolean;
  open?: boolean;
}

/**
 * Run `llmwiki view`. Resolves once the server has bound; the returned
 * promise stays unresolved for the lifetime of the listening process so
 * Commander's exit semantics keep the event loop alive until the signal
 * handler closes the server.
 */
export default async function viewCommand(options: ViewCommandOptions): Promise<void> {
  const { host, port } = resolveBindConfig(options);
  const root = process.cwd();
  const handle = await startViewer({ root, host, port, workflowJourneys: false });
  const url = buildReadyUrl(handle.host, handle.port);
  process.stdout.write(`Viewer ready at ${url}\n`);
  if (options.open) openInBrowser(url);
  registerShutdown(handle.close);
}

/**
 * Fire-and-forget native-shell open of the viewer URL. Failures here are
 * intentionally swallowed: a broken browser launch must not prevent the
 * server from keeping the readiness it just announced.
 */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

