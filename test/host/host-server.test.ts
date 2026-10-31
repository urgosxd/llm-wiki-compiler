/**
 * @file test/host/host-server.test.ts
 * @description One listener, two sub-apps, two security regimes — proven by
 * talking to the running host instead of asserting on internals.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS. The value of this module is that it shares
 * a listener WITHOUT merging policy. A test that only proved "both respond 200"
 * would pass even if the viewer's origin policy had been silently dropped. So each
 * case pins the property that distinguishes the two mounts:
 *
 *   - the graph health body is byte-identical to the oracle's shape;
 *   - the viewer answers on its own prefix, which the graph must not claim;
 *   - an unregistered path is a 404 from the viewer's router, not a 403 from its
 *     origin gate — the ordering the viewer documents;
 *   - a hostile Origin is rejected (fail-closed) while the graph route stays
 *     reachable without credentials (fail-open), in the same process.
 */
import { describe, expect, it } from "vitest";
import { runningHost as startRunningHost, type RunningHost } from "../fixtures/running-host.js";

/**
 * Start a host on a scratch project root.
 *
 * Delegates to the shared fixture so this suite and the `/domain` prefix suite boot
 * their listeners the same way: a host suite that builds its server differently
 * from its neighbour is asserting against a different server than it thinks.
 */
function runningHost(options: { includeGraph?: boolean } = {}): Promise<RunningHost> {
  return startRunningHost("host-test-", options);
}

describe("the host serves two sub-apps behind one listener", () => {
  it("answers the graph health probe with the oracle's pinned body", async () => {
    const { handle, base } = await runningHost();
    try {
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "ok",
        service: "aks-reference-server",
        version: "0.2.0",
      });
    } finally {
      await handle.close();
    }
  });

  it("serves the viewer on its own prefix in the same process", async () => {
    const { handle, base } = await runningHost();
    try {
      const response = await fetch(`${base}/api/health`);
      expect(response.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("returns the viewer's 404 for an unregistered path, not an origin 403", async () => {
    const { handle, base } = await runningHost();
    try {
      // The viewer validates origin, then routes: an unknown path on an acceptable
      // host is a 404. A 403 here would mean the origin gate ran on a request it
      // should have let through.
      expect((await fetch(`${base}/not-a-route`)).status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it("keeps the viewer fail-closed and the graph fail-open in one process", async () => {
    const { handle, base } = await runningHost();
    try {
      const hostile = await fetch(`${base}/api/health`, {
        headers: { origin: "http://evil.example" },
      });
      expect(hostile.status).toBe(403);

      // The graph route needs no credentials when AKS_API_KEY is unset: the
      // oracle's reference behaviour, preserved. Same listener, other policy.
      const graph = await fetch(`${base}/health`, {
        headers: { origin: "http://evil.example" },
      });
      expect(graph.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("serves the viewer alone when the graph mount is declined", async () => {
    const { handle, base } = await runningHost({ includeGraph: false });
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
      // With no graph mounted, a graph path is just an unknown viewer path.
      expect((await fetch(`${base}/health`)).status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it("resolves an OS-assigned port and reports it", async () => {
    const { handle } = await runningHost();
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.host).toBe("127.0.0.1");
    } finally {
      await handle.close();
    }
  });
});
