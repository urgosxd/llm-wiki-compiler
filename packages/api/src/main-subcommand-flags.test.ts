/**
 * @file packages/api/src/main-subcommand-flags.test.ts
 * @description Proves the launcher REJECTS a flag that belongs to the other
 * subcommand, instead of parsing it and dropping it.
 *
 * ## Why a silently ignored flag is worse than a rejected one
 *
 * `host` serves the project in the process's own working directory, and `serve`
 * roots its MCP server at `--root`. Only `serve` has a root, so only `serve` can
 * honour `--root`; only `host` opens a listener, so only `host` can honour
 * `--port` and `--no-graph`. A launcher whose parser accepts the union of both
 * flag sets, with each subcommand reading only its own half, turns every
 * mismatched pair into a silent success: `docker run … image host --root /data`
 * bound a port, served the WRONG project, answered `GET /` with 200, and exited 0
 * on SIGTERM. Nothing in that run is red — no error, no warning, no failing health
 * check — so the operator only finds out when the wiki answers with the image's
 * own empty tree. Rejecting the flag with a usage error, before anything binds,
 * makes a mistake that is cheap to make as loud as it is cheap.
 *
 * ## Why the artifact, and why the shared spawner
 *
 * The claim is about what a caller observes of the shipped bundle: the exit code
 * and the first line of stderr, at the process boundary. Importing `main.ts`
 * would evaluate the module's argv dispatch against the test runner's own
 * arguments, so every case spawns `node dist/api.js` and reads what the child
 * did. The accepting case reuses `test/fixtures/run-cli-server`, the one place
 * that already knows how to start `host` and wait for its readiness line, rather
 * than growing a second launcher spawner.
 *
 * ## Each rejection case also asserts that nothing BOUND
 *
 * A rejection that has already opened a listener is not a rejection. A child that
 * has not exited by the deadline is killed and reported as "started serving",
 * and no case accepts a readiness line on stdout.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startViewerCLI } from "../../../test/fixtures/run-cli-server.js";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The artifact `docker/entry.sh` execs: the launcher's own bundle. */
const LAUNCHER = path.join(REPO_ROOT, "dist", "api.js");

/** The command that produces the artifact, quoted by the precondition failure. */
const BUILD_COMMAND = "corepack pnpm run build";

/**
 * How long a REJECTED invocation may take to exit. A usage error is written and
 * the process exits immediately, so anything slower is a process that stayed up
 * to serve — which is the defect, reported by name rather than awaited.
 */
const REJECT_DEADLINE_MS = 15_000;

/** One cross-subcommand invocation, and the flag that must be named back. */
interface CrossSubcommandCase {
  /** Test title, phrased as who must reject what. */
  readonly title: string;
  /** argv for the launcher, given the project root the case runs in. */
  readonly args: (root: string) => string[];
  /** The flag the usage error must name. */
  readonly rejected: string;
}

/**
 * The pairs the two option tables must stay disjoint on. Each one used to be
 * accepted by the shared parser and then dropped by the subcommand that could
 * not use it, so each one silently produced a success.
 */
const CROSS_SUBCOMMAND_FLAGS: readonly CrossSubcommandCase[] = [
  { title: "host rejects --root, which only serve can honour", args: (root) => ["host", "--port", "0", "--root", root], rejected: "--root" },
  { title: "serve rejects --port, which only host can honour", args: () => ["serve", "--port", "0"], rejected: "--port" },
  { title: "serve rejects --no-graph, which only host can honour", args: () => ["serve", "--no-graph"], rejected: "--no-graph" },
];

/** What one finished invocation left behind. */
interface Rejection {
  /** Exit code, or `null` when the deadline had to kill the child. */
  readonly code: number | null;
  /** Everything written to stdout. */
  readonly stdout: string;
  /** Everything written to stderr. */
  readonly stderr: string;
  /** Whether the child was still running at the deadline, i.e. it started serving. */
  readonly timedOut: boolean;
}

/**
 * Run the launcher to its own exit, with a deadline that kills a child which
 * refuses to exit.
 *
 * `execFile` is the right tool because this case never needs the child's output
 * as it happens: it needs "did it exit, with which code, saying what". Its
 * `timeout` + `killSignal` is the deadline, and `error.killed` is how a process
 * that had to be killed is told apart from one that exited on its own.
 *
 * @param args - argv after the launcher's own path.
 * @param cwd - The working directory the child runs in.
 * @returns The exit code, both streams, and whether the deadline fired.
 */
function runToExit(args: readonly string[], cwd: string): Promise<Rejection> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LAUNCHER, ...args],
      { cwd, timeout: REJECT_DEADLINE_MS, killSignal: "SIGKILL", encoding: "utf8" },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const timedOut = error?.killed === true;
        const code = typeof error?.code === "number" ? error.code : 0;
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
      },
    );
  });
}

let root: string;

beforeEach(async () => {
  if (!existsSync(LAUNCHER)) throw new Error(`${LAUNCHER} is missing, so the build has not run; run \`${BUILD_COMMAND}\``);
  root = await mkdtemp(path.join(tmpdir(), "api-subcommand-flags-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the launcher's option acceptance is per subcommand", () => {
  it.each(CROSS_SUBCOMMAND_FLAGS)("$title", async ({ args, rejected }) => {
    const settled = await runToExit(args(root), root);
    expect(settled.timedOut, `${rejected} must not be accepted: the child stayed up serving instead of rejecting it`).toBe(false);
    expect(settled.code, `${rejected} must be a usage error, not a flag the subcommand ignores`).toBe(1);
    expect(settled.stderr.split("\n")[0], "the first stderr line must name the rejected flag and nothing else").toBe(`unknown option: ${rejected}`);
    expect(settled.stderr, "the failure must carry the usage text, like every other usage error").toContain("Usage: api");
    expect(settled.stdout, "a rejected invocation must never announce a listener").not.toContain("Host ready at");
  });

  it("host still ACCEPTS every flag it owns, --no-graph included", async () => {
    const handle = await startViewerCLI(["--port", "0"], root);
    await handle.kill();
    expect(handle.process.exitCode, "host must still exit 0 on SIGTERM, as the container's stop path requires").toBe(0);
  });
});
