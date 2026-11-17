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

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
  type DimensionsDatabase,
} from "../../../packages/wiki/src/dimensions/activation.js";
// The launcher scaffolding both spawning suites share: the bundle path, the readiness wait and the
// exit deadline live in one place, so `boot-review-surfaces.test.ts` cannot drift from this file.
import {
  announcedOrEmpty,
  healthStatus,
  launch,
  launchDatabaseHost,
  plantFileCandidate,
  REPO_ROOT,
  runToExit,
  spawnHostToExit,
  waitForReady,
  type Running,
} from "../../../test/fixtures/launcher-harness.js";
import { createSuiteDatabase } from "../../../test/fixtures/per-run-database.js";
// The launcher cases below measure a FILE-BACKED wiki, so this file declares that mode the way
// `test/fixtures/file-mode.ts` documents: no database configured. Without it the child inherits the
// database URL the runner seeds into every worker and refuses to start, because a database with no
// Stack named is a failure and not a mode (spec S2 of `odd/tasks/single-stack-authority.md`).
import "../../../test/fixtures/file-mode.js";

/**
 * Preload that raises SIGTERM against the child itself at the readiness write, so
 * the stop contract is measured at a code-determined instant instead of after a
 * pipe round-trip. See the fixture's own header for why the signal is child-side.
 */
const SIGTERM_AT_READY = path.join(REPO_ROOT, "test", "fixtures", "sigterm-at-ready.cjs");

/**
 * The line a file-mode child writes to stderr the moment it opens an outbound socket.
 *
 * A marker rather than the bare throw below, because a caller that catches the error
 * would otherwise hide the very attempt this file needs to see.
 */
const OUTBOUND_SOCKET_MARKER = "BOOT-OPENED-AN-OUTBOUND-SOCKET";

/**
 * Preload that turns ANY outbound socket connection into a loud failure.
 *
 * A boot with no database configured must not open a database connection at all — not
 * merely fail to reach one — and a lazily pooled client makes "no connection" invisible
 * from the outside: the process can exit 0 while having dialled a server it inherited
 * from the environment. This makes the dial itself observable, and it names neither the
 * target nor its credentials, so it cannot leak what it refuses to reach.
 */
const NO_OUTBOUND_CONNECT_PRELOAD = `// Preload: no boot here may open an outbound connection.
const net = require("node:net");
net.Socket.prototype.connect = function connect() {
  process.stderr.write(${JSON.stringify(`${OUTBOUND_SOCKET_MARKER}\n`)});
  throw new Error("a boot with no database configured must not open an outbound connection");
};
`;

/**
 * How many rows `public.stacks` holds in `dimensions` right now.
 *
 * Counted through SQL against the throwaway database, never through the code under
 * test: the question is what the boot WROTE, and asking the product would let a bug
 * answer for itself.
 *
 * @param dimensions - Handle on the database the boot was pointed at.
 * @returns The row count of `public.stacks`.
 */
async function countStacks(dimensions: DimensionsDatabase): Promise<number> {
  const [row] = await dimensions.db.execute<{ n: number }>("select count(*)::int as n from public.stacks");
  return Number(row?.n);
}

/**
 * SHA-256 over every `public.stacks` row, in id order.
 *
 * A COUNT proves "no second Stack"; it cannot see the first one being rewritten. This
 * digest covers every column of every row — id, domain, scope, strategy and both
 * timestamps — so an upsert that recreated or touched the same Stack changes it. Read
 * through SQL, so the product cannot answer for itself.
 *
 * @param dimensions - Handle on the database the boots were pointed at.
 * @returns The hex digest of the ordered row set.
 */
async function stackRowsDigest(dimensions: DimensionsDatabase): Promise<string> {
  const rows: unknown = await dimensions.db.execute("select * from public.stacks order by id");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
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

/**
 * Boot the launcher once against `env`, require a listener that answers, then stop it.
 *
 * `label` distinguishes the two boots of the idempotence case, whose whole claim is that
 * the SECOND one behaves like the first; a shared message would report the wrong one.
 *
 * @param env - The child's environment.
 * @param label - Which boot this is, for the failure messages.
 */
async function bootAndStop(env: NodeJS.ProcessEnv, label: string): Promise<void> {
  const running = launch(["host", "--port", "0"], root, env);
  try {
    const announced = await announcedOrEmpty(running);
    expect(announced, `${label} must announce the listener it bound; child stderr: ${running.stderr()}`).toMatch(/^http:\/\//);
    expect(await healthStatus(announced), `${label} must answer /health; child stderr: ${running.stderr()}`).toBe(200);
  } finally {
    running.terminate();
    await running.exited;
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
    const base = await waitForReady(running);
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

describe("a deployment whose database holds no Stack yet", () => {
  it("provisions the default Stack and binds, instead of dying before it listens", async () => {
    const suite = await createSuiteDatabase("boot-precedence");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      // Measured, never assumed: a case that started from a populated database would
      // prove nothing about the empty-database boot it exists to arrange.
      expect(await countStacks(dimensions), "the throwaway database must start with ZERO Stacks").toBe(0);
      const { running, announced } = await launchDatabaseHost(root, suite.url);
      try {
        // The OUTCOME, both halves of it: the Stack the boot provisioned, and a service that
        // answers. The child's streams go in the MESSAGE only; no error text is asserted.
        expect(await countStacks(dimensions), `the boot must provision exactly ONE Stack; child stderr: ${running.stderr()}`).toBe(1);
        expect(announced, `the host must announce the listener it bound; child stderr: ${running.stderr()}`).toMatch(/^http:\/\//);
        expect(await healthStatus(announced), `GET ${announced}/health must answer; child stderr: ${running.stderr()}`).toBe(200);
      } finally {
        running.terminate();
        await running.exited;
      }
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  });
});

describe("a second boot against the database the first boot populated", () => {
  it("provisions no second Stack, and binds again", async () => {
    const suite = await createSuiteDatabase("boot-idempotence");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    // The SAME environment for both boots: same database, no Stack named, so the only
    // thing that can differ between them is what the first one left behind.
    const env = { ...process.env, [AKS_DATABASE_URL_ENV_VAR]: suite.url, [AKS_STACK_ID_ENV_VAR]: "" };
    try {
      expect(await countStacks(dimensions), "the throwaway database must start with ZERO Stacks").toBe(0);
      await bootAndStop(env, "the first boot");
      // Measured, not carried forward: two counts in sequence are what a claim about
      // idempotence needs. One `count = 1` would say nothing about the second boot.
      const afterFirstBoot = await countStacks(dimensions);
      await bootAndStop(env, "the second boot");
      const afterSecondBoot = await countStacks(dimensions);
      expect(afterFirstBoot, "the first boot must provision exactly ONE Stack").toBe(1);
      expect(afterSecondBoot, "the second boot must provision NO second Stack").toBe(1);
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  });
});

describe("a Stack-backed host whose checkout carries a candidate file", () => {
  it("counts its OWN queue, not the checkout's files", async () => {
    const suite = await createSuiteDatabase("boot-candidate-drift");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      // A leftover `.llmwiki/candidates` directory is the realistic shape: any checkout
      // that ever ran a file-mode compile carries one. It is also the whole point — the
      // count must come from the Stack the boot RESOLVED, not from a directory the
      // process happens to be sitting in.
      await plantFileCandidate(root);
      const { running, announced } = await launchDatabaseHost(root, suite.url);
      try {
        expect(announced, `the host must announce the listener it bound; child stderr: ${running.stderr()}`).toMatch(/^http:\/\//);
        const pages = await fetch(`${announced}/api/pages`);
        expect(pages.status, `GET ${announced}/api/pages must answer; child stderr: ${running.stderr()}`).toBe(200);
        const body = (await pages.json()) as { counts: { pendingReviews: number } };
        // The row queue this boot provisioned is EMPTY, so the count is 0. The planted
        // file is the only thing that could make it anything else.
        expect(
          body.counts.pendingReviews,
          "a Stack-backed host must count its OWN queue, not the checkout's files",
        ).toBe(0);
        // Read after the count it explains: the 0 above means "the queue is empty", not "no Stack
        // was there to read", so the Stack the boot provisioned is measured last, when the count
        // it accounts for is already on the record.
        expect(await countStacks(dimensions), `the boot must provision exactly ONE Stack; child stderr: ${running.stderr()}`).toBe(1);
      } finally {
        running.terminate();
        await running.exited;
      }
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  });
});

describe("the Stack row an earlier boot provisioned", () => {
  it("is byte-identical after a second boot against the same database", async () => {
    const suite = await createSuiteDatabase("boot-stack-digest");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    const env = { ...process.env, [AKS_DATABASE_URL_ENV_VAR]: suite.url, [AKS_STACK_ID_ENV_VAR]: "" };
    try {
      await bootAndStop(env, "the first boot");
      const digestAfterFirstBoot = await stackRowsDigest(dimensions);
      await bootAndStop(env, "the second boot");
      const digestAfterSecondBoot = await stackRowsDigest(dimensions);
      // Stronger than the count beside it: a rewritten row keeps the count at 1 while
      // changing what it holds, and only the digest can see that.
      expect(
        digestAfterSecondBoot,
        "a second boot must leave the provisioned Stack byte-identical, not merely singular",
      ).toBe(digestAfterFirstBoot);
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  });
});

describe("a deployment with no database configured", () => {
  it("binds the file backend and opens no outbound connection", async () => {
    // "No database configured" stated the way production reads it — PRESENT and blank,
    // which no loader can refill (see `test/fixtures/file-mode.ts`). The socket guard is
    // what makes "no provisioning attempted" observable: reaching a database would mean
    // dialling one, and this boot may not dial anything at all.
    const preload = path.join(root, "no-outbound-connect.cjs");
    await writeFile(preload, NO_OUTBOUND_CONNECT_PRELOAD);
    const running = launch(["host", "--port", "0"], root, {
      ...process.env,
      [AKS_DATABASE_URL_ENV_VAR]: "",
      [AKS_STACK_ID_ENV_VAR]: "",
      NODE_OPTIONS: `--require ${preload}`,
    });
    try {
      const announced = await announcedOrEmpty(running);
      expect(announced, `a file-backed host must announce its listener; child stderr: ${running.stderr()}`).toMatch(/^http:\/\//);
      expect(await healthStatus(announced), `GET ${announced}/health must answer; child stderr: ${running.stderr()}`).toBe(200);
      expect(running.stderr(), "a file-mode boot must open NO outbound connection").not.toContain(
        OUTBOUND_SOCKET_MARKER,
      );
    } finally {
      running.terminate();
      await running.exited;
    }
  });
});

describe("the mode the launcher is handed", () => {
  /**
   * A well-formed but unreachable DSN: this case is about WHICH mode a child was asked for, not
   * about reaching anything, and the refusal below is raised before a socket is opened.
   */
  const UNREACHABLE_DSN = "postgres://unused@127.0.0.1:1/unused";

  it("refuses a database-backed child that names no Stack, instead of starting file-backed", async () => {
    // The mirror image of this file's file-mode declaration, and the pin that keeps the
    // declaration a CHOICE: a caller that asks for a database explicitly still gets one, and a
    // database with no Stack named is then the loud, named refusal rather than a silent
    // degradation to the file backend (spec S1/S5 of `odd/tasks/single-stack-authority.md`).
    const settled = await runToExit(["host", "--port", "0"], root, {
      ...process.env,
      [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN,
      [AKS_STACK_ID_ENV_VAR]: "",
    });
    expect(settled.code, `a Stack-less database-backed host must exit 1; stderr: ${settled.stderr}`).toBe(1);
    expect(
      settled.stderr,
      "the failure must name the variable whose configuration made the run impossible",
    ).toContain(`${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack`);
    expect(settled.stdout, "a refused run must never announce a listener").not.toContain("Host ready at");
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
