/**
 * @file packages/llmwiki-kg/ts/src/kg-app.test.ts
 * @description Integration test for the composed KG app: MCP at `/mcp`, over a real socket.
 *
 * ## Why `list_stacks` is CALLED and not merely enumerated
 *
 * All four tools are HTTP clients of the KG API (`handlers.ts` fetches
 * `${baseUrl}/stacks`, `/aks/v1/context`, `/aks/v1/traverse`, `/aks/v1/entities`).
 * A mount that enumerates but forwards to a `baseUrl` nobody listens on is
 * enumerable AND dead, so enumeration alone would have passed a criterion the
 * feature does not meet. `list_stacks` is the call under test because it reads
 * the graph, needs no provider and therefore no spend.
 *
 * ## Where the rest of the reasoning lives
 *
 * The boot over a real socket, the stubbed database and the separately wired
 * guards are in `kg-app-harness.ts`; the `/mcp` chain ordering, envelope and
 * claimed-path probes are in `kg-app-mcp-chain.test.ts`. The three files were
 * produced by extracting, not by shortening a callback in place: this file was
 * already at 414 lines against the 400-line ceiling, so a 43-line callback could
 * not be brought under the 39-line per-function ceiling by reflowing it here.
 * Each of the two extracted files carries the comment that explains it.
 */

import { describe, expect, it } from "vitest";

import {
  INVALID_API_KEY_DETAIL,
  MCP_HTTP_PATH,
  PASS_THROUGH,
  TEST_API_KEY,
  connect,
  payloadOf,
  postWithoutKey,
  withApp,
} from "./kg-app-harness.js";

/** The tool names the KG server must expose, exactly, sorted for comparison. */
const EXPECTED_TOOLS = ["get_entities", "list_stacks", "query_stack", "traverse_stack"];

/** The KG API's own liveness body, which the composition must not disturb. */
const HEALTH_BODY = { status: "ok", service: "aks-reference-server", version: "0.2.0" };

describe("MCP over HTTP on the composed KG app", () => {
  it("enumerates exactly the four tools through the wire", async () => {
    await withApp(async (app) => {
      const client = await connect(app.origin);
      const { tools } = await client.listTools();
      await client.close();

      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    });
  });

  it("answers list_stacks end to end from the served /stacks route", async () => {
    await withApp(async (app) => {
      const client = await connect(app.origin);
      const result = await client.callTool({ name: "list_stacks", arguments: {} });
      await client.close();

      const payload = payloadOf(result);
      const stacks = payload["stacks"] as ReadonlyArray<Record<string, unknown>>;
      expect(result.isError ?? false).toBe(false);
      expect(payload["count"]).toBe(1);
      expect(stacks.map((entry) => entry["name"])).toEqual(["Stubbed Stack"]);
      expect(stacks[0]?.["domain"]).toBe("kg-mcp-mount-probe");
    });
  });
});

describe("a malformed /mcp body", () => {
  it("is answered with the KG error envelope, never an HTML stack trace", async () => {
    await withApp(async (app) => {
      const response = await fetch(`${app.origin}${MCP_HTTP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-Key": TEST_API_KEY },
        body: "{oops",
      });
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(Object.keys(body)).toEqual(["detail"]);
      expect(typeof body["detail"]).toBe("string");
      expect(text).not.toContain("SyntaxError");
      expect(text).not.toContain("node_modules");
      expect(text).not.toContain("at parse");
      expect(text).not.toMatch(/\n\s+at /);
    }, { routerApiKey: PASS_THROUGH });
  });
});

describe("the guards on the composed app", () => {
  it("refuses an unauthenticated POST /mcp in the shape the KG routes use", async () => {
    // The inner routers are opened with a pass-through guard so the ONLY
    // middleware that can answer 401 here is the `/mcp` one: without it the
    // request reaches the transport and the assertions below fail.
    await withApp(async (app) => {
      const response = await postWithoutKey(app.origin);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ detail: INVALID_API_KEY_DETAIL });
    }, { routerApiKey: PASS_THROUGH });
  });

  it("keeps the KG API reachable behind the mount", async () => {
    // PRESERVE: `index.ts` now composes this app instead of calling
    // `createApp()` directly, so the inner app must still answer its own paths
    // and its own 404 body — the two things the composition could swallow.
    //
    // The routers get the pass-through guard for the reason `server.test.ts`
    // sees a 404 at all: with auth enabled a root-mounted router's guard
    // answers 401 before the 404 fallback runs, which is pre-existing KG
    // behavior and has nothing to do with this composition.
    await withApp(async (app) => {
      const health = await fetch(`${app.origin}/health`);
      const missing = await fetch(`${app.origin}/not-a-kg-route`);

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual(HEALTH_BODY);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ detail: "Not Found" });
    }, { routerApiKey: PASS_THROUGH });
  });
});

describe("what the /mcp mount claims", () => {
  it("does not claim /mcp/mcp: only the exact path is served", async () => {
    // The mount is a route, not a prefix. The baseline is another path no
    // router knows, compared inside this test, so the assertion is "the MCP
    // handler never ran" rather than a literal string.
    await withApp(async (app) => {
      const headers = { "content-type": "application/json", "X-API-Key": TEST_API_KEY };
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const nested = await fetch(`${app.origin}${MCP_HTTP_PATH}/mcp`, { method: "POST", headers, body });
      const baseline = await fetch(`${app.origin}/not-a-kg-route`, { method: "POST", headers, body });

      expect(await baseline.text()).toBe('{"detail":"Not Found"}');
      expect(nested.status).toBe(baseline.status);
      expect(await nested.text()).toBe('{"detail":"Not Found"}');
    }, { routerApiKey: PASS_THROUGH });
  });

  it("still serves GET and DELETE, the transport's SSE and session methods", async () => {
    // PRESERVE: the mount went from `app.use(prefix)` to `app.all(exactPath)`,
    // so the methods the transport serves must still reach it. Neither answer
    // below is the router-never-ran 404, which is the point.
    await withApp(async (app) => {
      const headers = { "X-API-Key": TEST_API_KEY };
      const sse = await fetch(`${app.origin}${MCP_HTTP_PATH}`, { method: "GET", headers });
      const ended = await fetch(`${app.origin}${MCP_HTTP_PATH}`, { method: "DELETE", headers });

      expect(sse.status).toBe(406);
      expect(await sse.json()).toMatchObject({ jsonrpc: "2.0" });
      expect(ended.status).toBe(200);
    });
  });
});
