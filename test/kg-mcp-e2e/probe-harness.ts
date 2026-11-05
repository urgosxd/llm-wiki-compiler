/**
 * @file test/kg-mcp-e2e/probe-harness.ts
 * @description Stands the whole KG dimension up, and takes it all down again.
 *
 * The order below is the dependency order and nothing else:
 *
 * 1. build the package — both children run its `dist/` output, so it must exist;
 * 2. start a private Postgres container (Docker picks the host port);
 * 3. apply the schema with the repository's own runner (`applySchema`, parsed from
 *    `scripts/apply-schemas.sh`, so this file cannot drift from the real list);
 * 4. seed two Stacks with real rows;
 * 5. start the real KG API on an OS-granted port, against that database;
 * 6. put the counting proxy in front of it;
 * 7. spawn the MCP server with `AKS_BASE_URL` pointing at the proxy, and complete
 *    a real handshake.
 *
 * Every step records how long it took, because a probe this heavy has to justify
 * itself with numbers rather than an adjective.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql } from "postgres";

import { startEphemeralPostgres } from "../fixtures/ephemeral-postgres.js";
import type { EphemeralPostgres } from "../fixtures/ephemeral-postgres.js";
import { withClient, applySchema } from "../../packages/llmwiki-kg/ts/src/testing/per-run-database.js";
import { startCountingProxy } from "./counting-proxy.js";
import type { CountingProxy, ProxiedRequest } from "./counting-proxy.js";
import { startKgApi } from "./kg-api-child.js";
import type { ApiChild } from "./kg-api-child.js";
import { startKgMcp } from "./kg-mcp-child.js";
import type { McpProbe } from "./kg-mcp-child.js";
import { rowCounts, seedProbeStacks } from "./probe-database.js";
import type { RowCounts, Seed } from "./probe-database.js";

const run = promisify(execFile);

/** Repository root, so every path here is absolute and independent of cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The package build every child needs; `noEmitOnError` makes a failure fatal. */
const BUILD_ARGS = ["tsc", "-p", "packages/llmwiki-kg/ts/tsconfig.build.json"];

/** A build of 226 files does not fit in a default timeout. */
const BUILD_TIMEOUT_MS = 180_000;

/** What the whole stand-up took, step by step, in milliseconds. */
export interface ProbeTimings {
  readonly packageBuildMs: number;
  readonly containerReadyMs: number;
  readonly schemaAppliedMs: number;
  readonly seedMs: number;
  readonly apiReadyMs: number;
  readonly mcpHandshakeMs: number;
}

/** Everything the probe owns, in one handle whose `stop()` hides the order. */
export interface Probe {
  /** The two freshly seeded Stacks. */
  readonly seed: Seed;
  /** The observer between the MCP server and the API. */
  readonly proxy: CountingProxy;
  /** The real KG API child. */
  readonly api: ApiChild;
  /** The connected MCP client and its child process. */
  readonly mcp: McpProbe;
  /** The container, so a failing run can name it. */
  readonly postgres: EphemeralPostgres;
  /** The measurements above. */
  readonly timings: ProbeTimings;
  /** Every request the proxy forwarded so far. */
  readonly requests: () => readonly ProxiedRequest[];
  /** Current row counts in the probe database. */
  readonly counts: () => Promise<RowCounts>;
  /** Tear everything down: MCP child, proxy, API child, database, container. */
  readonly stop: () => Promise<void>;
}

/** Build the KG package once; both children run its `dist/` output. */
async function buildPackage(): Promise<number> {
  const started = Date.now();
  await run("npx", BUILD_ARGS, { cwd: REPO_ROOT, timeout: BUILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return Date.now() - started;
}

/** Each started piece registers its own undo here, the moment it exists. */
type Undo = Array<() => Promise<void>>;

/** What a successful stand-up produced, with its measurements. */
interface Standing {
  readonly postgres: EphemeralPostgres;
  readonly sql: Sql;
  readonly seed: Seed;
  readonly api: ApiChild;
  readonly proxy: CountingProxy;
  readonly mcp: McpProbe;
  readonly timings: ProbeTimings;
}

/**
 * Bring every piece up in dependency order, registering each piece's undo as it appears.
 *
 * @param undo - The caller's undo stack, appended to as each piece starts.
 * @returns The standing pieces and how long each step took.
 */
async function bringUp(undo: Undo): Promise<Standing> {
  const packageBuildMs = await buildPackage();

  const containerStarted = Date.now();
  const postgresFixture = await startEphemeralPostgres("kg-mcp-e2e");
  undo.push(() => postgresFixture.stop());
  const containerReadyMs = Date.now() - containerStarted;

  const schemaStarted = Date.now();
  await withClient(postgresFixture.url, (client) => applySchema(client));
  const schemaAppliedMs = Date.now() - schemaStarted;

  const sql: Sql = postgres(postgresFixture.url, { max: 4, onnotice: () => undefined });
  undo.push(() => sql.end({ timeout: 10 }));
  const seedStarted = Date.now();
  const seed = await seedProbeStacks(sql);
  const seedMs = Date.now() - seedStarted;

  const apiStarted = Date.now();
  const api = await startKgApi(postgresFixture.url);
  undo.push(() => api.stop());
  const apiReadyMs = Date.now() - apiStarted;

  const proxy = await startCountingProxy(api.baseUrl);
  undo.push(() => proxy.stop());

  const handshakeStarted = Date.now();
  const mcp = await startKgMcp(proxy.baseUrl);
  undo.push(() => mcp.stop());
  const mcpHandshakeMs = Date.now() - handshakeStarted;

  return {
    postgres: postgresFixture,
    sql,
    seed,
    api,
    proxy,
    mcp,
    timings: { packageBuildMs, containerReadyMs, schemaAppliedMs, seedMs, apiReadyMs, mcpHandshakeMs },
  };
}

/**
 * Start the whole stack.
 *
 * The undo stack is populated by {@link bringUp} as each piece appears, so a failure
 * anywhere — a build that will not compile, a container that never accepts
 * connections, an MCP child that dies during the handshake — takes down everything
 * started so far and then re-throws. MEASURED: with only the success path tearing
 * down, a failed handshake left a Postgres container running for the rest of the
 * session; a probe whose own cleanup depends on its success is not a probe.
 *
 * @returns The probe, ready for tool calls.
 */
export async function startProbe(): Promise<Probe> {
  const undo: Undo = [];
  const unwind = async (): Promise<void> => {
    // Reverse order: children before the database, the database before the container.
    for (const step of undo.splice(0).reverse()) await step().catch(() => undefined);
  };
  try {
    const standing = await bringUp(undo);
    return {
      seed: standing.seed,
      proxy: standing.proxy,
      api: standing.api,
      mcp: standing.mcp,
      postgres: standing.postgres,
      timings: standing.timings,
      requests: () => standing.proxy.requests(),
      counts: () => rowCounts(standing.sql),
      stop: unwind,
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}
