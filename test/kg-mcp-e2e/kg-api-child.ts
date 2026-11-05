/**
 * @file test/kg-mcp-e2e/kg-api-child.ts
 * @description The real KG API, as its own process, on a port the OS grants.
 *
 * ## Why the child process and not `createApp().listen(0)`
 *
 * `packages/llmwiki-kg/ts/src/index.ts` is the entry S1 names, and importing it is
 * impossible: it binds a listener at import time and exits the process on a bad
 * config. Running `dist/index.js` therefore exercises the parts a test double would
 * quietly skip — `PORT` parsing, `validateConfig`, the Drizzle pool built from
 * `DATABASE_URL` at first access, and the banner it prints when it is up. A probe
 * whose whole point is "not simulated" should not start the service the one way the
 * service is never started in production.
 *
 * `listen(0)` on `createApp()` would take the port from the OS directly. This file
 * keeps the real entry and gets the port the only way that entry allows: a port the
 * OS reports as free, asked for by binding and releasing it a moment earlier, then
 * handed to the child as `PORT`.
 *
 * ## Why the model providers are pointed at a closed port
 *
 * `validateConfig` refuses to start without provider credentials, and a probe must
 * not need a real one. Nothing in this suite asserts a model answer: the tools it
 * queries are pure Postgres reads (`get_entities`, `traverse_stack`,
 * `list_stacks`), and `query_stack` is asserted at the boundary where its Stack
 * actually matters — the request it sends. So the providers are configured, and
 * unreachable, which keeps the run offline and deterministic instead of hanging on
 * a network the probe does not own.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Repository root, so the child is spawned by absolute path. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The built API entry point: the same file `npm start` runs. */
const API_ENTRY = `${REPO_ROOT}/packages/llmwiki-kg/ts/dist/index.js`;

/** A port nothing listens on, so a provider call fails fast instead of waiting. */
const UNREACHABLE_PROVIDER = "http://127.0.0.1:1";

/** How long the API may take to answer `/health`. */
const READY_TIMEOUT_MS = 45_000;

/** How often readiness is re-tried. */
const READY_POLL_MS = 100;

/** How long a SIGTERM is given before the child is killed outright. */
const STOP_TIMEOUT_MS = 10_000;

/** How many log lines of the child are kept for a failure message. */
const LOG_TAIL = 40;

/** The running API and the way to stop it. */
export interface ApiChild {
  /** Base URL on loopback, e.g. `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  /** Port the OS granted, for the record. */
  readonly port: number;
  /** The last lines the child printed, for a failing assertion's message. */
  readonly log: () => string;
  /** Stop the child. Best effort, safe to call twice. */
  stop: () => Promise<void>;
}

/** A port the OS reports as free, obtained by binding port 0 and releasing it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port === 0) throw new Error("the OS granted no port for the KG API child");
  return port;
}

/** The environment the API child runs with: its database, its port, no real keys. */
function childEnv(port: number, databaseUrl: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    NODE_ENV: "test",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    AKS_API_KEY: "",
    EMBEDDING_PROVIDER: "gateway",
    GATEWAY_URL: UNREACHABLE_PROVIDER,
    GATEWAY_API_KEY: "probe-provider-key",
    EXTRACTION_PROVIDER: "openai",
    OPENAI_API_KEY: "probe-provider-key",
  };
}

/** Keep the tail of the child's output, so a failure can quote it. */
function collectLog(child: ChildProcess): { text: () => string } {
  const lines: string[] = [];
  const keep = (chunk: Buffer): void => {
    lines.push(chunk.toString("utf-8"));
    while (lines.length > LOG_TAIL) lines.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return { text: () => lines.join("") };
}

/** Wait until `/health` answers 200, or fail naming what the child printed. */
async function waitUntilReady(baseUrl: string, log: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // Not listening yet: the only expected failure while the child boots.
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`the KG API did not answer /health within ${String(READY_TIMEOUT_MS)} ms:\n${log()}`);
}

/** Stop the child: SIGTERM, then SIGKILL if it is still alive. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

/**
 * Start `dist/index.js` against the probe's database.
 *
 * @param databaseUrl - Connection string of the probe's own database.
 * @returns The running API; `stop()` ends the child.
 */
export async function startKgApi(databaseUrl: string): Promise<ApiChild> {
  const port = await freePort();
  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: REPO_ROOT,
    env: childEnv(port, databaseUrl),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = collectLog(child);
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await waitUntilReady(baseUrl, log.text);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { baseUrl, port, log: log.text, stop: () => stopChild(child) };
}
