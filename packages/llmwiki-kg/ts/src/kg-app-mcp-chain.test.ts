/**
 * @file packages/llmwiki-kg/ts/src/kg-app-mcp-chain.test.ts
 * @description The `/mcp` chain probes: guard ordering, the exact envelope, the claimed path.
 *
 * ## Why these three probes are their own file
 *
 * They were the T9 block of `kg-app.test.ts`. Together they pushed a single
 * `describe` callback to 43 lines against the 39-line per-function ceiling, and
 * the file holding them was at 414 lines against the 400-line ceiling — so
 * splitting the callback in place traded one violation for the other. Extracting
 * the block here and the boot into `kg-app-harness.ts` clears both ceilings, and
 * three assertions are unchanged: same values, same order, same comments.
 *
 * ## What each block pins, and why it is not obvious
 *
 * Ordering is the property in the first block: a parser that ran before the
 * guard would answer `400`, so `401` on a malformed body is the only observable
 * proof that the guard runs first.
 *
 * The second block pins the envelope BYTE for byte — including its `30`-byte
 * length, recorded because an earlier ledger entry claimed 31 and the number is
 * cheap to get wrong.
 *
 * The third block is the negative control. `/mcp/mcp` and `/mcp/anything` are
 * compared against a path no router knows, in the same request, rather than
 * against a literal string: a `401` on a probe path means a router answered, not
 * that the path was unmounted. `/mcp/` is the case that could have been assumed
 * wrong — under Express's non-strict matching it IS the mounted route, so it is
 * pinned as the measured `406` JSON-RPC answer beside the two sub-paths that must
 * equal the unmounted baseline.
 */

import { describe, expect, it } from "vitest";

import {
  INVALID_API_KEY_DETAIL,
  MCP_HTTP_PATH,
  PASS_THROUGH,
  TEST_API_KEY,
  postJson,
  withApp,
} from "./kg-app-harness.js";

describe("the /mcp chain: guard ordering and the exact error envelope", () => {
  it("refuses an unauthenticated malformed body with 401, before any parsing", async () => {
    // Ordering is the property: parser-first answers 400, and no guard lets the transport answer.
    await withApp(async (app) => {
      const response = await postJson(app.origin, MCP_HTTP_PATH, "{oops");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ detail: INVALID_API_KEY_DETAIL });
    }, { routerApiKey: PASS_THROUGH });
  });

  it("answers a valid-key malformed body with the exact KG envelope", async () => {
    await withApp(async (app) => {
      const response = await postJson(app.origin, MCP_HTTP_PATH, "{oops", TEST_API_KEY);
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(text).toBe('{"detail":"Invalid JSON body"}');
      expect(Buffer.byteLength(text)).toBe(30);
      expect(text).not.toContain("SyntaxError");
      expect(text).not.toContain("node_modules");
      expect(text).not.toContain("<!DOCTYPE");
    }, { routerApiKey: PASS_THROUGH });
  });
});

describe("the /mcp path the mount claims", () => {
  it("claims no /mcp sub-path: each is compared to an unmounted baseline", async () => {
    await withApp(async (app) => {
      const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const baseline = await postJson(app.origin, "/not-a-kg-route", list, TEST_API_KEY);
      const baselineBody = await baseline.text();
      expect(baselineBody).toBe('{"detail":"Not Found"}');
      for (const path of ["/mcp/mcp", "/mcp/anything"]) {
        const response = await postJson(app.origin, path, list, TEST_API_KEY);
        expect([path, response.status, await response.text()]).toEqual([path, baseline.status, baselineBody]);
      }
      // Non-strict routing: `/mcp/` is the SAME route, not a sub-path (observed, not assumed).
      const trailing = await postJson(app.origin, "/mcp/", list, TEST_API_KEY);
      expect(trailing.status).toBe(406);
      expect(await trailing.json()).toMatchObject({ jsonrpc: "2.0" });
    }, { routerApiKey: PASS_THROUGH });
  });
});
