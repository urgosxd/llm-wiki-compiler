/**
 * @file test/fixtures/per-run-database-signal.test.ts
 * @description The per-run database's teardown must not consume another component's exit.
 *
 * ## The defect this pins
 *
 * `test/commands/host-command.test.ts` passes 3/3 at base and failed on
 * `feat/reach-test-gates`: the host command's `stop()` emits `SIGTERM` IN PROCESS, the
 * per-run teardown reacted to it, dropped this worker's database, and then called
 * `process.exit(0)` — which the suite's own `exitSpy` absorbs. So the worker survived a
 * shutdown it had not finished, with the database its remaining tests needed already
 * gone, and the next test could never print a readiness line.
 *
 * A teardown hook that fires on a signal the process never received from outside, and
 * that consumes another component's exit path, is the bug — not the suite that emits.
 * The rules, each asserted below through a real connection or a real process:
 *
 * 1. The signal handler never calls `process.exit`.
 * 2. It drops only databases this process minted, idempotently.
 * 3. It removes its own listener.
 * 4. It re-raises the original signal, so every other listener and the default exit
 *    semantics resume exactly as they were — unless another listener is still
 *    registered, in which case that component owns the exit and this module stays out
 *    of its way.
 *
 * ## Why the second case is a real child process
 *
 * A genuine signal cannot be observed from inside the process it kills. The only honest
 * way to see "the database was dropped and the exit code is the conventional signal
 * code" is to spawn a process, hand it a database of its own, signal it, and read both
 * the exit status and the server's catalog afterwards.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "llmwiki-kg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { firstJsonReport } from "./child-report.js";
import { perRunDatabase } from "./per-run-database.js";

/** This worker's own database: the one a spurious in-process signal must never drop. */
const own = await perRunDatabase();

/** The database the spawned child provisioned, so teardown cannot leak it. */
const spawned: string[] = [];

afterAll(async () => {
  for (const name of spawned.splice(0)) await dropIfPresent(name);
});

/** The `Sql` handle `createClient` returns, named without reaching into the driver. */
type Client = ReturnType<typeof createClient>;

/** The SERVER this worker provisions on: the same address, the always-present database. */
function serverUrl(): string {
  const url = new URL(own.url);
  url.pathname = "/postgres";
  return url.toString();
}

/** Run `work` against the server's catalog, always closing the client. */
async function withCatalog<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient(serverUrl(), 10);
  try {
    return await work(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Does a database with exactly this name exist on the server right now? */
async function databaseExists(name: string): Promise<boolean> {
  return withCatalog(async (client) => {
    const rows = await client<{ total: number }[]>`
      select count(*)::int as total from pg_database where datname = ${name}
    `;
    return (rows[0]?.total ?? 0) === 1;
  });
}

/** Drop a database this file created, if it is still there. Best effort. */
async function dropIfPresent(name: string): Promise<void> {
  if (!(await databaseExists(name))) return;
  await withCatalog((client) => client.unsafe(`drop database if exists "${name}" with (force)`));
}

/** A child process that provisioned its own database and is still running. */
interface ChildSuite {
  readonly name: string;
  readonly child: ChildProcess;
  readonly directory: string;
}

/** The program the child runs: provision a database on the given server, report, wait. */
const CHILD_SOURCE = [
  'import { perRunDatabase } from "__MODULE__";',
  "const suite = await perRunDatabase(process.env.PER_RUN_SIGNAL_BASE);",
  "console.log(JSON.stringify({ name: suite.name, pid: process.pid }));",
  "setInterval(() => undefined, 1_000);",
].join("\n");
/** Start a real process that owns a per-run database and keeps running. */
async function startChild(): Promise<ChildSuite> {
  const module = fileURLToPath(
    new URL("../../packages/llmwiki-kg/ts/src/testing/per-run-database.ts", import.meta.url),
  );
  const directory = mkdtempSync(path.join(tmpdir(), "per-run-signal-"));
  const script = path.join(directory, "child.ts");
  writeFileSync(script, CHILD_SOURCE.replace("__MODULE__", module));
  // Plain `node`, not a loader: a loader can turn the signal death into a normal exit
  // with 128+n, and this case has to observe what the OS did to the process.
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PER_RUN_SIGNAL_BASE: serverUrl() },
  });
  const { name } = await firstJsonReport<{ name: string }>(child, "child");
  spawned.push(name);
  return { name, child, directory };
}

/** Kill the child if it is somehow still alive, and remove its script directory. */
function finish(child: ChildSuite): void {
  if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
  rmSync(child.directory, { recursive: true, force: true });
}

/** Signal the child and resolve with how it died. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once("exit", (code, received) => resolve({ code, signal: received }));
    child.kill(signal);
  });
}

describe("per-run database teardown and the process's exit path", () => {
  it("leaves its database and the other component's exit path alone", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const handled: string[] = [];
    let listenersDuringShutdown = -1;
    // A stand-in for any component that owns its own shutdown (`serve-bind.ts` does
    // exactly this): it must run once, and it must stay in charge of the exit.
    const shutdown = (): void => {
      handled.push("shutdown");
      listenersDuringShutdown = process.listenerCount("SIGTERM");
    };
    process.on("SIGTERM", shutdown);
    try {
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(1);

      process.emit("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(handled).toEqual(["shutdown"]);
      expect(listenersDuringShutdown).toBe(1);
      // Both are effects of the same rule and neither may be skipped once the other
      // has already failed, so they are soft: the report names every effect it broke.
      expect.soft(exitSpy).not.toHaveBeenCalled();
      expect.soft(await databaseExists(own.name)).toBe(true);
    } finally {
      process.removeListener("SIGTERM", shutdown);
      exitSpy.mockRestore();
    }
  }, 60_000);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "drops its database and dies by %s when it is the only listener",
    async (signal) => {
      const child = await startChild();
      try {
        expect(await databaseExists(child.name)).toBe(true);

        const exit = await signalChild(child.child, signal);

        // `code`/`signal` as the OS reported them: a process that dies from a signal has
        // no exit code, and the signal is named. Anything else is somebody else's exit.
        expect(exit).toEqual({ code: null, signal });
        expect(await databaseExists(child.name)).toBe(false);
      } finally {
        finish(child);
      }
    },
    120_000,
  );
});
