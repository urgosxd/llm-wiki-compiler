/**
 * Security regression tests for `llmwiki view`.
 *
 * Validates the spec's §Non-Negotiable Security Requirements on a live
 * subprocess: every registered route emits the exact CSP, CORP, nosniff,
 * and Referrer-Policy headers — including the Slice 2 placeholders for
 * `/` and `/assets/*`. Cross-site `Origin`, `Sec-Fetch-Site: cross-site`,
 * and DNS-rebind-style `Host` mismatch are rejected with HTTP 403.
 */

import { describe, it, expect } from "vitest";
import http from "http";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import path from "path";
import {
  useViewerProcessLifecycle,
  type ViewerProcessHandle,
} from "./fixtures/run-cli-server.js";

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";

const { start: startViewerProcess } = useViewerProcessLifecycle();

async function startViewer(): Promise<ViewerProcessHandle> {
  const root = await makeTempRoot("viewer-security");
  await writePage(path.join(root, "wiki/concepts"), "x", { title: "X" }, "Body.");
  return startViewerProcess(root);
}

async function rawFetch(
  handle: ViewerProcessHandle,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${handle.host}:${handle.port}${pathname}`, { headers });
}

/**
 * Low-level HTTP request that bypasses the fetch spec's forbidden-header
 * list (notably `Host`), so we can prove the server rejects mismatched
 * Host values — the DNS-rebinding attack the spec calls out.
 */
function rawHttpRequestStatus(
  handle: ViewerProcessHandle,
  pathname: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: handle.host,
        port: handle.port,
        method: "GET",
        path: pathname,
        headers,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * The `Host` value the viewer accepts for a handle's bind: IPv6 literals are
 * bracketed (RFC 3986/7230), which is the form the server's acceptable-host
 * list builds. IPv4 and named hosts go in bare.
 */
function boundHostHeader(handle: ViewerProcessHandle): string {
  const host = handle.host.includes(":") ? `[${handle.host}]` : handle.host;
  return `${host}:${handle.port}`;
}

describe("security headers", () => {
  it.each([
    ["/", 200],
    ["/assets/viewer.js", 200],
    ["/assets/anything.js", 404],
    ["/api/pages", 200],
    ["/api/health", 200],
    ["/api/page/concepts/x", 200],
    ["/api/search?q=x", 200],
    // Unregistered route — still carries the mandatory headers — the
    // spec requires every response to be hardened, not just registered API hits.
    ["/nope", 404],
  ])("emits CSP / CORP / nosniff / Referrer-Policy on %s", async (pathname, expectedStatus) => {
    const handle = await startViewer();
    const res = await rawFetch(handle, pathname);
    expect(res.status).toBe(expectedStatus);
    expect(res.headers.get("Content-Security-Policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("origin and host validation", () => {
  it("rejects requests whose Host header does not match the bound host:port (DNS rebind)", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/api/pages", { Host: "evil.example.com" });
    expect(status).toBe(403);
  });

  it("accepts the localhost alias for a 127.0.0.1 bind", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/api/pages", {
      Host: `localhost:${handle.port}`,
    });
    expect(status).toBe(200);
  });

  it("rejects browser requests with a cross-site Origin header", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("accepts same-origin Origin headers", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", {
      Origin: `http://${handle.host}:${handle.port}`,
    });
    expect(res.status).toBe(200);
  });

  it("rejects Sec-Fetch-Site: cross-site", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/api/pages", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("rejects bad Host on an unregistered route with 403 (origin check fires before 404)", async () => {
    const handle = await startViewer();
    const status = await rawHttpRequestStatus(handle, "/nope", { Host: "evil.example.com" });
    expect(status).toBe(403);
  });

  it("rejects cross-site Origin on an unregistered route with 403", async () => {
    const handle = await startViewer();
    const res = await rawFetch(handle, "/nope", { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  /**
   * THE CONTRACT BEHIND A 403 ON `/`.
   *
   * `/` answers **200** when the request carries the address the server bound and
   * **403** when it carries any other `Host`. That 403 is the viewer's fail-CLOSED
   * origin gate working: `packages/api/src/host/server.ts:13-14` states the trust
   * boundary and `server.ts:426-432` records why the bound address is what the
   * comparison uses; the predicate is `validateOriginHeaders` in
   * `packages/wiki/src/viewer/server.ts`.
   *
   * Measured on a real container: `/` returned 403 under a literal probe and 200
   * with the container's own `Host: <eth0>:4173`. Under `-p 4173:4173` the
   * container binds its own bridge address, so a request arriving through the
   * published port carries `Host: 127.0.0.1:4173` and is correctly refused —
   * `docker-compose.yml:68-77` records both the refused and the accepted shape.
   * `docker/` and `packages/api/src/host/` are byte-identical to the base commit,
   * so that 403 is not a regression from this or any recent change.
   *
   * These two assertions are the permanent, CI-runnable form of a container probe
   * CI cannot run — no committed test spawns a container FOR THIS CHECK, and CI
   * has no Docker at all, so this gate pair cannot be a container test. (Docker
   * does appear elsewhere in the suite: `test/fixtures/testcontainers-postgres.ts:184,192`
   * start a pgvector container that `test/global-setup.ts` uses, so DB suites do
   * spawn one when no reusable container exists — that is a different subject.)
   * DO NOT replace these assertions with a container-dependent test: that trades a
   * hermetic check for one that skips exactly where the gate needs watching.
   *
   * OPERATIONAL RULE for any future container check, learned twice now: resolve
   * the mapped port by inspecting the running container at run time
   * (`docker port <container> 5432/tcp`-style), never from a hardcoded number and
   * never from a document. `odd/tasks/stack-scoped-compile-lock.md:87` recorded
   * `32782` where the truth was `32768`, and a stale document is indistinguishable
   * from a broken service.
   */
  describe("/ origin gate: bound Host is served, any other Host is refused", () => {
    it("returns 200 for / when Host matches the bound address", async () => {
      const handle = await startViewer();
      const status = await rawHttpRequestStatus(handle, "/", { Host: boundHostHeader(handle) });
      expect(status).toBe(200);
    });

    it("returns 403 for / when Host is a published-port style mismatch", async () => {
      const handle = await startViewer();
      const status = await rawHttpRequestStatus(handle, "/", {
        Host: `127.0.0.1:${handle.port + 1}`,
      });
      expect(status).toBe(403);
    });
  });
});
