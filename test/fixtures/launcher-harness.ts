/**
 * @file test/fixtures/launcher-harness.ts
 * @description The one place that starts the launcher bundle `dist/api.js`, plus the readiness
 * wait, the exit deadline and the checkout scaffolding every suite that spawns it shares.
 *
 * ## Why this is a fixture and not a local helper in each suite
 *
 * Two suites spawn the same artifact and need the same three things around it: a child whose
 * stdout and stderr are captured as they arrive, a wait that uses the process's OWN readiness line
 * instead of a sleep, and the constants that name the bundle and bound the wait.
 * `packages/api/src/main.test.ts` pins the launcher's modes, exit codes and stop path;
 * `packages/api/src/boot-review-surfaces.test.ts` pins what two HTTP surfaces answer once the boot
 * resolved a Stack. Written twice, the two copies drift on the deadline, on the artifact path or on
 * the stream wiring without either being wrong on its own — and fallow reports the copies as
 * duplication before a reader ever sees the drift.
 *
 * ## Why the suites spawn the artifact instead of importing the module
 *
 * The claim is a container claim: `docker/entry.sh` execs a bundle in `dist/`, and the image is
 * only useful if that bundle comes up. A green build says the bundle was WRITTEN, never that it
 * starts, and the failures this guards against — a workspace package left externalized into
 * `dist/`, a launcher that dispatches to a module the bundle does not carry — are invisible to a
 * build and need a real child process.
 *
 * ## Precondition: the build has run
 *
 * `test/global-setup.ts` builds `dist/` once before any file loads. {@link launch} names that
 * precondition rather than letting a bare `ENOENT` escape from the spawn.
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
} from "../../packages/wiki/src/dimensions/activation.js";

/** Repository root, from this file's own location rather than the runner's cwd. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The artifact `docker/entry.sh` execs: the launcher's own bundle. */
const LAUNCHER = path.join(REPO_ROOT, "dist", "api.js");

/** The command that produces the artifact, quoted by the precondition failure. */
const BUILD_COMMAND = "corepack pnpm run build";

/** The line `host` mode prints once its listener has bound, captured to reach it. */
const READY_LINE = /^Host ready at (http:\/\/\S+)$/m;

/** Bound on the wait for readiness, and on the wait for a stopped child to be gone. */
const HOST_DEADLINE_MS = 30_000;

/**
 * The part of a live child {@link waitForStdout} needs: its output so far and the promise that
 * settles when it is gone. Narrower than {@link Running} so a child spawned for a signal contract
 * can share the same readiness wait.
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
export interface Running extends Observable {
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
 * How a `host` child ended. The signal is the discriminator the stop-path case needs: a child the
 * kernel stopped for us reports `code === null` and a signal, and a child that took the graceful
 * path reports a code and no signal.
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
 * The child {@link spawnCaptured} returns. All three stdio slots are pipes, so the stdin
 * {@link Running.send} writes to is never null.
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
 * Spawn the launcher bundle with `args` and capture both streams. This is the one place that
 * decides how a launcher child is started, so the readiness cases, the stop-path cases and the
 * surface cases cannot drift on the build precondition or the stream wiring.
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
export function launch(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Running {
  const captured = spawnCaptured(args, cwd, env);
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
export async function runToExit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return launch(args, cwd, env).exited;
}

/**
 * Spawn `<launcher> host --no-graph --port 0` and wait for ONE event — `close`, the same event
 * {@link launch} awaits, so stdout is complete when it is read — bounded by
 * {@link HOST_DEADLINE_MS}. `close` also carries the signal, which is what tells a graceful stop
 * apart from a death by default disposition.
 *
 * @param cwd - The working directory the child runs in.
 * @param env - The child's environment; defaults to this process's own.
 * @returns The child and its exit promise.
 */
export function spawnHostToExit(cwd: string, env: NodeJS.ProcessEnv = process.env): HostChild {
  const captured = spawnCaptured(["host", "--no-graph", "--port", "0"], cwd, env);
  const exited = new Promise<StopOutcome>((resolve, reject) => {
    const deadline = setTimeout(() => {
      captured.child.kill("SIGKILL");
      const seen = `stdout: ${captured.stdout()}; stderr: ${captured.stderr()}`;
      reject(new Error(`host did not exit within ${HOST_DEADLINE_MS}ms; ${seen}`));
    }, HOST_DEADLINE_MS);
    captured.child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout: captured.stdout(), stderr: captured.stderr() });
    });
  });
  return { ...captured, exited };
}

/**
 * Wait for `running.stdout()` to match `pattern`, or reject when it exits first.
 *
 * A fixed sleep would be a race in both directions: too short flakes on a loaded machine, too long
 * costs every run. The process's own output is the signal.
 */
async function waitForStdout(running: Observable, pattern: RegExp): Promise<RegExpMatchArray> {
  const deadline = Date.now() + HOST_DEADLINE_MS;
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
 * The status the announced listener answers `/health` with.
 *
 * The three cases that need "the service really bound" ask the same question of the same route,
 * so the probe lives here with the rest of the launcher scaffolding and each case keeps its own
 * assertion and its own failure message.
 *
 * @param base - The base URL the child announced.
 * @returns The HTTP status of `GET <base>/health`.
 */
export async function healthStatus(base: string): Promise<number> {
  const response = await fetch(`${base}/health`);
  return response.status;
}

/**
 * The base URL the child announced, or `""` when it never announced one.
 *
 * The soft form exists for the cases that ASSERT the announcement — a case whose own assertion
 * carries the child's stderr reads better than a helper that throws its own message first.
 *
 * @param running - The spawned child.
 * @returns The announced base URL, or `""`.
 */
export async function announcedOrEmpty(running: Observable): Promise<string> {
  return waitForStdout(running, READY_LINE).then((matched) => matched[1] as string, () => "");
}

/**
 * Wait for the child to announce the listener it bound, or reject with its stderr.
 *
 * @param running - The spawned child.
 * @returns The base URL the child announced.
 */
export async function waitForReady(running: Observable): Promise<string> {
  return waitForStdout(running, READY_LINE).then(
    (matched) => matched[1] as string,
    () => {
      throw new Error(`the host never announced a listener; stderr: ${running.stderr()}`);
    },
  );
}

/** A host booted against a database with no Stack named, and the listener it announced. */
interface DatabaseBoot {
  /** The running child, for the case's `finally` block to stop. */
  readonly running: Running;
  /** The base URL it announced, or `""` when it never announced one. */
  readonly announced: string;
}

/**
 * Boot `host --port 0` against `databaseUrl` with NO Stack named — the shape a first deployment
 * has, and the only one where the boot's own resolution and the process environment can disagree.
 *
 * The launch and the readiness wait are the same in every case that needs that shape; what each
 * case asserts about the boot stays in the case.
 *
 * @param cwd - The checkout the child runs in.
 * @param databaseUrl - The throwaway database the boot is pointed at.
 * @returns The running child and the base URL it announced.
 */
export async function launchDatabaseHost(cwd: string, databaseUrl: string): Promise<DatabaseBoot> {
  const running = launch(["host", "--port", "0"], cwd, {
    ...process.env,
    [AKS_DATABASE_URL_ENV_VAR]: databaseUrl,
    [AKS_STACK_ID_ENV_VAR]: "",
  });
  return { running, announced: await announcedOrEmpty(running) };
}

/**
 * One pending candidate, well-formed enough that the FILE queue counts and lists it.
 *
 * A real record rather than a malformed file: a malformed file is skipped by the file reader too,
 * so it could not tell "the row queue answered" apart from "the file queue answered and dropped
 * what it found".
 */
const PLANTED_CANDIDATE = JSON.stringify({
  id: "planted-1",
  title: "Planted",
  slug: "planted",
  summary: "",
  sources: [],
  body: "---\ntitle: Planted\n---\n\nBody.\n",
  generatedAt: "2026-01-01T00:00:00.000Z",
  reviewMode: "forced",
  heldReasons: [{ code: "manual-review-requested" }],
});

/**
 * Leave one pending candidate in the checkout, the way any file-mode compile does.
 *
 * @param root - The project root the child is started in.
 */
export async function plantFileCandidate(root: string): Promise<void> {
  const candidatesDir = path.join(root, ".llmwiki", "candidates");
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(path.join(candidatesDir, "planted-1.json"), PLANTED_CANDIDATE);
}
