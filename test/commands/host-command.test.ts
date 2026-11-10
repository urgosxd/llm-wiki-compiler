/**
 * @file test/commands/host-command.test.ts
 * @description The `host` mode must actually bind a listener that serves the
 * mutation endpoints.
 *
 * WHY THIS EXISTS. Before a `host` mode existed, NOTHING started the unified host:
 * `llmwiki view` started the older viewer-only server, `llmwiki serve` is MCP over
 * stdio, and `startHost` was reachable only from tests. A surface no entry can start
 * is not a product surface, and a test that only asserted "the function exists"
 * would not have caught that.
 *
 * WHY IT NOW SPAWNS THE SHIPPED ENTRY INSTEAD OF IMPORTING A COMMAND. This suite
 * used to import `packages/wiki/src/commands/host.ts`, the CLI's dispatcher for
 * `startHost`. That command is deleted: the dispatch moved into `@repo/api`'s
 * launcher, which is the process `docker/entry.sh` execs, so the subject worth
 * testing is the entry that ships — `node dist/api.js host --no-graph`. The spawn
 * goes through the shared `run-cli-server` fixture, which is the one place that
 * waits for the readiness line and tears the child down.
 *
 * Every assertion the in-process version made is kept: a real listener, the
 * mutation routes answering 200, the `--no-graph` opt-out leaving the graph routes
 * unmounted, and the privacy gate rejecting a lone `--host`. `--no-graph` is not a
 * new narrowing here — the command was already invoked with `noGraph: true` in this
 * suite before the move. The exit code on a rejected bind is asserted from the
 * fixture's own early-exit report, which a rejected promise could not show.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { useStackEnv } from "../fixtures/stack-env.js";
import { useViewerProcessLifecycle } from "../fixtures/run-cli-server.js";

/** A scratch project to stand in as the launcher's working directory. */
async function scratchProject(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-command-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

describe("the host mode of the surviving entry", () => {
  // Every dimension is Postgres-backed: `host` cannot start without a tenant. The
  // Stack is installed into `process.env`, which the spawned child inherits.
  useStackEnv("host-command");
  const { start } = useViewerProcessLifecycle();

  it("binds a listener and serves the mutation endpoints", async () => {
    const host = await start(await scratchProject());
    const base = `http://${host.host}:${host.port}`;
    try {
      // The endpoints exist and answer like a real API, not a 404.
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      expect((await fetch(`${base}/api/compile`, { method: "POST" })).status).toBe(200);
    } finally {
      await host.kill();
    }
  }, 60_000);

  it("omits the graph routes when the graph is disabled", async () => {
    const host = await start(await scratchProject());
    const base = `http://${host.host}:${host.port}`;
    try {
      // `--no-graph` is an explicit opt-out, so its routes must be absent rather
      // than failing at request time.
      expect((await fetch(`${base}/health`)).status).toBe(404);
    } finally {
      await host.kill();
    }
  }, 60_000);

  it("rejects a host flag supplied without --allow-lan", async () => {
    // The privacy gate is shared with the viewer command; this proves the host did
    // not grow its own, weaker copy. A rejected bind never becomes ready, so the
    // fixture reports the child's exit instead of a URL.
    await expect(start(await scratchProject(), ["--port", "0", "--host", "192.168.1.10"])).rejects.toThrow(
      /code=1[\s\S]*--host and --allow-lan must be supplied together/,
    );
  }, 30_000);
});
