/**
 * @file packages/llmwiki-kg/ts/src/kg-app-harness.ts
 * @description Shared boot harness for the split `kg-app-*.test.ts` files.
 *
 * Not a test file, so the runner does not collect it. Same shape as
 * `routes/aks-harness.ts` and `routes/pages-harness.ts`: the boot, the constants
 * and the request helpers live here, and each test file keeps its own `describe`
 * blocks plus the reasoning for what it asserts.
 *
 * ## Why this is a split and not a shorter function
 *
 * `kg-app.test.ts` was at 414 lines while its largest `describe` callback was at
 * 43 lines against the 39-line per-function ceiling. Shortening that callback in
 * place grows the file, and the file's ceiling is 400, so the two constraints
 * pull in opposite directions and the remedy is extraction. The pressure is a
 * recurring pattern rather than a local accident: `scripts/schema-parity-check.ts`
 * and `scripts/kg-ingest-outcomes-db.ts` also sit at 397-399 lines. In this
 * repository a file at the ceiling gets split; it never gets a waiver.
 *
 * ## Why the tests speak HTTP to a listening socket
 *
 * The claim being tested is that the FOUR MCP tools are reachable from the
 * SHIPPED artifact. An in-memory transport would prove that `createMcpServer`
 * answers `tools/list`, which was already true before anything was mounted —
 * `mcp-transport.test.ts` covers exactly that. What was false is that a client
 * could reach the server through the listener the process actually binds, and
 * only a request that travels over TCP through Express can fail for that reason.
 * So the app is booted on an ephemeral `127.0.0.1` port, the MCP client is
 * pointed at that port, and every assertion goes through the wire.
 *
 * ## Why the database is stubbed instead of real
 *
 * `GET /stacks` runs one SQL statement inside a transaction. Injecting a router
 * `wrap` that hands the handler a stub handle keeps these tests free of Postgres
 * and of any write, while still exercising the REAL route: the row is parsed by
 * `StackResponse`, serialised by the real handler and re-projected by the real
 * `listStacks` tool. Only the `select` is replaced.
 *
 * ## Why the two guards are wired separately
 *
 * Every root-mounted KG router guards all paths that reach it, so a 401 on
 * `/mcp` could come from a router rather than from the `/mcp` mount. The guard
 * tests therefore open the routers with {@link PASS_THROUGH}: the ONLY thing
 * that can refuse the request is the `/mcp` guard, which is what makes those
 * tests fail when that guard is deleted.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  NextFunction,
  Request,
  RequestHandler,
  Response as ExpressResponse,
} from "express";

import { createKgApp } from "./app.js";
import { createRequireApiKey } from "./auth.js";
import type { ApiKeyMiddleware } from "./auth.js";
import { parseConfig } from "./config.js";
import type { Database, TransactionalHandler } from "./db.js";
import { MCP_HTTP_PATH } from "./mcp/http.js";

/**
 * The two product constants every split file asserts against, re-exported here.
 *
 * They are re-exported rather than imported from their own modules in each test
 * file so that a test reads ONE import surface: the path the mount claims and
 * the body the guard answers with are both part of what the harness boots.
 */
export { INVALID_API_KEY_DETAIL } from "./auth.js";
export { MCP_HTTP_PATH } from "./mcp/http.js";

/** The key the injected guard demands, and the key the MCP client sends. */
export const TEST_API_KEY = "kg-mcp-mount-test-key";

/** Auth config with the guard ENABLED, so a missing key is a real refusal. */
const AUTH_CONFIG = parseConfig({ AKS_API_KEY: TEST_API_KEY });

/** The one Stack `GET /stacks` answers with, in the shape `STACK_COLUMNS` selects. */
const STUB_ROWS = [
  {
    id: "20efd96a-f6e1-4994-8812-65113f8db4db",
    name: "Stubbed Stack",
    domain: "kg-mcp-mount-probe",
    description: null,
    scope: "stack",
    compilation_strategy: "incremental",
    synthesize_descriptions: false,
    created_at: "2026-10-21T17:05:32.366119Z",
    updated_at: "2026-10-21T17:05:32.366119Z",
    ontology: null,
  },
];

/**
 * A `Database` stand-in whose `execute` answers {@link STUB_ROWS}.
 *
 * `GET /stacks` is the only statement these tests reach, so `execute` is the
 * whole surface used. The cast is the seam itself: drizzle's handle type cannot
 * be partially implemented, and a real Postgres would only re-prove the query
 * the route suite already pins.
 */
function stubDatabase(): Database {
  return { execute: () => Promise.resolve(STUB_ROWS) } as unknown as Database;
}

/** Route wrapper that runs the handler against {@link stubDatabase}, with no transaction. */
function stubWrap(tx: Database): (handler: TransactionalHandler) => RequestHandler {
  return (handler) => (req: Request, res: ExpressResponse, next: NextFunction): void => {
    void handler(req, res, tx).catch(next);
  };
}

/** Let every request through: used to isolate the `/mcp` guard from the routers'. */
export const PASS_THROUGH: ApiKeyMiddleware = (_req, _res, next) => next();

/** Set by {@link boot} once the OS has granted a port; read per tool call. */
interface McpBaseUrl {
  baseUrl: string;
  apiKey: string;
}

/** A booted app: the origin it listens on, and how to stop it. */
export interface RunningApp {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

/** How a test wants the two independent guards wired. */
export interface BootOptions {
  /** Guard on the inner routers; the `/mcp` guard stays auth-enabled regardless. */
  readonly routerApiKey?: ApiKeyMiddleware;
}

/**
 * Boots the composed app on an ephemeral port and points MCP at that port.
 *
 * The MCP dependencies are read per tool call (`resolveDependencies`), so the
 * base URL is filled in once the port is known — which is only after `listen`.
 *
 * @param options - Which guard the inner routers get.
 * @returns The running app, and the way to stop it.
 */
async function boot(options: BootOptions = {}): Promise<RunningApp> {
  const mcpDependencies: McpBaseUrl = { baseUrl: "", apiKey: TEST_API_KEY };
  const app = createKgApp({
    routerDependencies: {
      wrap: stubWrap(stubDatabase()),
      apiKey: options.routerApiKey ?? createRequireApiKey(AUTH_CONFIG),
    },
    mcpDependencies,
    apiKey: createRequireApiKey(AUTH_CONFIG),
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  mcpDependencies.baseUrl = origin;

  return {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Boots an app, runs `body` against it, and always stops it. */
export async function withApp(
  body: (app: RunningApp) => Promise<void>,
  options: BootOptions = {},
): Promise<void> {
  const app = await boot(options);
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

/**
 * Hands the client transport to `Client.connect` through the `Transport` interface.
 *
 * The SDK declares `implements Transport` on its transports while typing the
 * optional members as `T | undefined` accessors; under `exactOptionalPropertyTypes`
 * those are not assignable to the interface. The same mismatch exists on the
 * server side and is handled the same way there.
 *
 * @param transport - The client transport this test talks through.
 * @returns The same object, typed as the interface `connect` accepts.
 */
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as unknown as Transport;
}

/**
 * A real MCP client over the streamable HTTP transport, carrying the key.
 *
 * @param origin - The loopback origin the app is listening on.
 * @returns A client with a completed `initialize` handshake.
 */
export async function connect(origin: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}${MCP_HTTP_PATH}`), {
    requestInit: { headers: { "X-API-Key": TEST_API_KEY } },
  });
  const client = new Client({ name: "kg-mcp-integration", version: "1.0.0" });
  await client.connect(asTransport(transport));
  return client;
}

/**
 * Decodes the single text block of a tool result as JSON.
 *
 * @param result - A `tools/call` result, still in its protocol envelope.
 * @returns The JSON document the tool answered with.
 */
export function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.text === undefined) {
    throw new Error("Expected a text content block in the tool result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * Posts `body` to `path`, sending `X-API-Key` only when a key is supplied.
 *
 * The body is sent as-is rather than serialised here, so a deliberately
 * malformed one stays malformed on the wire.
 *
 * @param origin - The loopback origin the app is listening on.
 * @param path - The absolute request path, which may be unmounted.
 * @param body - The raw body text.
 * @param key - The key to send; omitted means "send no `X-API-Key` at all".
 * @returns The raw response, so status and body can be asserted exactly.
 */
export function postJson(
  origin: string,
  path: string,
  body: string,
  key?: string,
): Promise<Response> {
  const headers: Record<string, string> = key === undefined
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", "X-API-Key": key };
  return fetch(`${origin}${path}`, { method: "POST", headers, body });
}

/**
 * Posts a JSON-RPC `tools/list` to `/mcp` with no `X-API-Key` header.
 *
 * @param origin - The loopback origin the app is listening on.
 * @returns The raw response, so status and body can be asserted exactly.
 */
export async function postWithoutKey(origin: string): Promise<Response> {
  return postJson(
    origin,
    MCP_HTTP_PATH,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  );
}
