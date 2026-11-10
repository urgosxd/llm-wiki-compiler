/**
 * @file packages/api/src/main.test.ts
 * @description Proves the `@repo/api` launcher — the process `docker/entry.sh`
 * starts — actually RUNS both of the modes the container asks for.
 *
 * ## Why this file spawns the artifact instead of importing the module
 *
 * The claim being tested is a container claim: `/usr/local/bin/entry.sh` execs a
 * bundle in `dist/` and the image is only useful if that bundle comes up. A
 * green build says the bundle was WRITTEN, never that it starts, and the two
 * failures this guards against are exactly the ones a build cannot see — a
 * workspace package left externalized into `dist/` (resolves in the repository,
 * `ERR_MODULE_NOT_FOUND` in the image) and a launcher that dispatches to a
 * module the bundle does not carry. Both need a real child process, so every
 * case below spawns `node dist/api.js` and asserts on what the process does:
 * its exit code, its stdout/stderr contract, and — for `host` — a live HTTP
 * response from the port it announced.
 *
 * ## Why both modes, when `serve` is the container default
 *
 * `entry.sh` reaches `host` through `LLMWIKI_MODE` and `serve` through the
 * no-argument default, and the stdio MCP surface is reachable from NO other
 * entry. A launcher that starts only the mode someone happened to try would
 * leave the other half of the image dead, so both are started here.
 *
 * ## Precondition: the build has run
 *
 * `test/global-setup.ts` builds `dist/` once before any file loads, and the
 * missing-artifact case below names that precondition rather than reporting a
 * bare `ENOENT` from the spawn.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The artifact `docker/entry.sh` execs: the launcher's own bundle. */
const LAUNCHER = path.join(REPO_ROOT, "dist", "api.js");

/** The command that produces the artifact, quoted by the precondition failure. */
const BUILD_COMMAND = "corepack pnpm run build";

/** The line `host` mode prints once its listener has bound, captured to reach it. */
const READY_LINE = /^Host ready at (http:\/\/\S+)$/m;

/**
 * Preload that raises SIGTERM against the child itself at the readiness write, so
 * the stop contract is measured at a code-determined instant instead of after a
 * pipe round-trip. See the fixture's own header for why the signal is child-side.
 */
const SIGTERM_AT_READY = path.join(REPO_ROOT, "test", "fixtures", "sigterm-at-ready.cjs");

/** Bound on the wait for a stopped child to be gone; a bound, never the wait itself. */
const HOST_EXIT_DEADLINE_MS = 30_000;

/**
 * The part of a live child {@link waitForStdout} needs: its output so far and the
 * promise that settles when it is gone. Narrower than {@link Running} so a child
 * spawned for a signal contract can share the same readiness wait.
 */
interface Observable {
  /** Raw bytes the process has written to stdout so far. */
  readonly stdout: () => string;
  /** Raw bytes the process has written to stderr so far. */
  readonly stderr: () => string;
  /** Settles once the process is gone. */
  readonly exited: Promise<unknown>;
}

/** One launched child process, with everything it has said so far. */
interface Running extends Observable {
  /** Raw bytes the process wrote to stdout. */
  readonly stdout: () => string;
  /** Raw bytes the process wrote to stderr. */
  readonly stderr: () => string;
  /** Resolves with the settled stdout/stderr once the process exits. */
  readonly exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Write one line to the process's stdin. */
  readonly send: (line: string) => void;
  /** Close stdin, which is how a stdio MCP client asks the server to stop. */
  readonly closeStdin: () => void;
  /** Signal the process the way `docker stop` does. */
  readonly terminate: () => void;
}

/**
 * The child {@link spawnCaptured} returns. All three stdio slots are pipes, so the
 * stdin `Running.send` writes to is never null — the narrowing the local `spawn`
 * used to give `launch` for free.
 */
type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** A spawned launcher child with its two output streams captured as they arrive. */
interface Captured {
  /** The child process itself. */
  readonly child: PipedChild;
  /** Everything the child has written to stdout so far. */
  readonly stdout: () => string;
  /** Everything the child has written to stderr so far. */
  readonly stderr: () => string;
}

/**
 * Spawn the launcher bundle with `args` and capture both streams. This is the one
 * place that decides how a launcher child is started, so the readiness cases and
 * the stop-path cases cannot drift on the build precondition or the stream wiring.
 *
 * @param args - argv after the launcher's own path.
 * @param cwd - The working directory the child runs in.
 * @param env - The child's environment; defaults to this process's own.
 * @returns The child and its captured streams.
 */
function spawnCaptured(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Captured {
  if (!existsSync(LAUNCHER)) {
    throw new Error(`${LAUNCHER} is missing, so the build has not run; run \`${BUILD_COMMAND}\``);
  }
  const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

/** Start the launcher bundle with `args`, rooted at `cwd`. */
function launch(args: readonly string[], cwd: string): Running {
  const captured = spawnCaptured(args, cwd);
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    captured.child.on("close", (code) => resolve({ code, stdout: captured.stdout(), stderr: captured.stderr() }));
  });
  return {
    stdout: captured.stdout,
    stderr: captured.stderr,
    exited,
    send: (line) => void captured.child.stdin.write(`${line}\n`),
    closeStdin: () => captured.child.stdin.end(),
    terminate: () => void captured.child.kill("SIGTERM"),
  };
}

/** Run the launcher to completion, for the cases that only assert on the exit. */
async function runToExit(args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return launch(args, cwd).exited;
}

/**
 * Wait for `running.stdout()` to match `pattern`, or reject when it exits first.
 *
 * A fixed sleep would be a race in both directions: too short flakes on a loaded
 * machine, too long costs every run. The process's own output is the signal.
 */
async function waitForStdout(running: Observable, pattern: RegExp): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const matched = running.stdout().match(pattern);
    if (matched !== null) return matched;
    const settled = await Promise.race([running.exited, new Promise((resolve) => setTimeout(resolve, 50))]);
    if (settled !== undefined && typeof settled === "object") {
      throw new Error(`the process exited before printing ${pattern}; stderr: ${running.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; stdout so far: ${running.stdout()}`);
  }
}

/**
 * How a `host` child ended. The signal is the discriminator these cases need: a
 * child the kernel stopped for us reports `code === null` and a signal, and a child
 * that took the graceful path reports a code and no signal.
 */
interface StopOutcome {
  /** Exit code, or `null` when a signal terminated the process. */
  readonly code: number | null;
  /** The signal that terminated the process, or `null` when it exited on its own. */
  readonly signal: NodeJS.Signals | null;
  /** Everything the child wrote to stdout. */
  readonly stdout: string;
  /** Everything the child wrote to stderr. */
  readonly stderr: string;
}

/** A spawned `host` child and the single promise that settles once it is gone. */
interface HostChild extends Observable {
  /** The child process, for delivering the signals a stop path must survive. */
  readonly child: ChildProcess;
  /** Resolves once the child is gone, after both streams closed. */
  readonly exited: Promise<StopOutcome>;
}

/**
 * Spawn `<launcher> host --no-graph --port 0` and wait for ONE event — `close`,
 * the same event {@link launch} awaits, so stdout is complete when it is read —
 * bounded by {@link HOST_EXIT_DEADLINE_MS}. `close` also carries the signal, which
 * is what tells a graceful stop apart from a death by default disposition.
 *
 * @param cwd - The working directory the child runs in.
 * @param env - The child's environment; defaults to this process's own.
 * @returns The child and its exit promise.
 */
function spawnHostToExit(cwd: string, env: NodeJS.ProcessEnv = process.env): HostChild {
  const captured = spawnCaptured(["host", "--no-graph", "--port", "0"], cwd, env);
  const exited = new Promise<StopOutcome>((resolve, reject) => {
    const deadline = setTimeout(() => {
      captured.child.kill("SIGKILL");
      const seen = `stdout: ${captured.stdout()}; stderr: ${captured.stderr()}`;
      reject(new Error(`host did not exit within ${HOST_EXIT_DEADLINE_MS}ms; ${seen}`));
    }, HOST_EXIT_DEADLINE_MS);
    captured.child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout: captured.stdout(), stderr: captured.stderr() });
    });
  });
  return { ...captured, exited };
}

/** The JSON-RPC `initialize` request every MCP client opens a session with. */
const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "launcher-test", version: "0.0.0" },
  },
});

/** The little of a JSON-RPC response these cases read. */
interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly serverInfo?: { readonly name?: string } };
  readonly error?: { readonly message?: string };
}

/** The first JSON-RPC response line the server wrote, once one appears. */
async function waitForJsonRpc(running: Running): Promise<JsonRpcResponse> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const line = running.stdout().split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (line !== undefined) return JSON.parse(line) as JsonRpcResponse;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a JSON-RPC response; stdout: ${running.stdout()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "api-launcher-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the container launcher, in both modes the container starts", () => {
  it("serves a JSON-RPC initialize over stdio in serve mode", async () => {
    const running = launch(["serve", "--root", root], root);
    running.send(INITIALIZE_REQUEST);
    const response = await waitForJsonRpc(running);
    expect(response.error, "initialize must not answer with a JSON-RPC error").toBeUndefined();
    expect(response.result?.serverInfo?.name, "the MCP handshake must identify the wiki server").toBe("llmwiki");
    running.closeStdin();
    const settled = await running.exited;
    expect(settled.code, `serve must exit 0 when its stdin closes; stderr: ${settled.stderr}`).toBe(0);
  });

  it("binds a port, answers /health, and stops cleanly on SIGTERM in host mode", async () => {
    const running = launch(["host", "--port", "0"], root);
    const matched = await waitForStdout(running, READY_LINE);
    const base = matched[1] as string;
    const response = await fetch(`${base}/health`);
    expect(response.status, `GET ${base}/health must answer while the listener is up`).toBe(200);
    running.terminate();
    const settled = await running.exited;
    expect(settled.code, `host must exit 0 on SIGTERM; stderr: ${settled.stderr}`).toBe(0);
  });

  it("keeps the --host/--allow-lan privacy gate in host mode", async () => {
    const settled = await runToExit(["host", "--port", "0", "--host", "127.0.0.1"], root);
    expect(settled.code, "a lone --host must fail rather than bind").toBe(1);
    expect(settled.stderr, "the failure must state the gate").toContain("Privacy gate");
  });
});

describe("the container launcher's SIGTERM stop contract", () => {
  it("arms the SIGTERM stop path before it announces readiness", async () => {
    const host = spawnHostToExit(root, { ...process.env, NODE_OPTIONS: `--require ${SIGTERM_AT_READY}` });
    const settled = await host.exited;
    expect(settled.stdout, "the child must reach readiness, or it never met the stop path this case measures").toContain("Host ready at");
    expect(settled.signal, "the child died FROM the signal: readiness must imply the stop path is already armed").toBeNull();
    expect(settled.code, "host must still exit 0 on SIGTERM, as the container's stop path requires").toBe(0);
  });
});

describe("the container launcher's usage contract", () => {
  it("fails a missing command with exit 1 and the usage text", async () => {
    const settled = await runToExit([], root);
    expect(settled.code, "no command is a usage error").toBe(1);
    expect(settled.stderr).toContain("no command given");
    expect(settled.stderr, "the failure must show the usage text").toContain("Usage: api");
  });

  it("fails an unknown command with exit 1 and names it", async () => {
    const settled = await runToExit(["bogus"], root);
    expect(settled.code, "an unknown command is a usage error").toBe(1);
    expect(settled.stderr).toContain("unknown command: bogus");
  });

  it("rejects an unknown option instead of silently defaulting it", async () => {
    const settled = await runToExit(["host", "--prot", "4173"], root);
    expect(settled.code, "a typoed option must not start a listener").toBe(1);
    expect(settled.stderr).toContain("unknown option: --prot");
    expect(settled.stdout, "a rejected invocation must never announce a listener").not.toContain("Host ready at");
  });
});
