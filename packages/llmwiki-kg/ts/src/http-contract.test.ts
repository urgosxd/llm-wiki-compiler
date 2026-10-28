import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { resolveMethod } from "./http-contract.js";
import { createApp } from "./server.js";

/**
 * HTTP-layer contract: method-not-allowed, CORS, and the generic 500 wire
 * format.
 *
 * Everything asserted here was measured against the live Python oracle on
 * `http://localhost:8000` before it was written; the comments name the
 * measurement where the result is surprising. These behaviors live in the
 * Express mount, not in the `/stacks` route logic, which is why they have their
 * own suite.
 *
 * Nothing here touches the database: every request either fails before routing
 * (405/404 on the method axis), is answered by CORS, or is served by `/health`.
 * The one case that needs a real row — the generic 500 — lives in
 * `server.test.ts`, where the live-database suite already runs.
 */

const ORACLE_ALLOW_METHODS = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY";

/** `Allow` values measured on the oracle, per path. */
const ORACLE_ALLOW = {
  /** Only `POST /` is declared on the `/stacks` router. */
  stacksCollection: "POST",
  /**
   * Only `GET /{stack_id}` is declared — the *consistency* of this value is a
   * measurement, not a mistake: `PATCH` and `DELETE` exist on the same path and
   * Starlette still reports only the first matching route's methods.
   */
  stackItem: "GET",
  /** `@app.get("/health")`. Nothing is registered for HEAD. */
  health: "GET",
  /**
   * `GET /domain/kg/stacks/{stack_id}/graph` — an extension with no oracle
   * counterpart. Its value is measured from this app, not from Python: only
   * `GET` is declared here, so any other method reports exactly that one.
   */
  stackGraph: "GET",
} as const;

function expectMethodNotAllowed(
  response: request.Response,
  allow: string,
): void {
  expect(response.status).toBe(405);
  expect(response.headers["allow"]).toBe(allow);
  expect(response.headers["content-type"]).toMatch(/application\/json/);
  // Raw text, so the key order and the absence of extra fields are pinned.
  expect(response.text).toBe('{"detail":"Method Not Allowed"}');
}

describe("405 method-not-allowed on existing paths", () => {
  const app = createApp();

  it("PUT /stacks returns 405 with allow: POST", async () => {
    expectMethodNotAllowed(await request(app).put("/stacks"), ORACLE_ALLOW.stacksCollection);
  });

  it("DELETE /stacks returns 405 with allow: POST", async () => {
    expectMethodNotAllowed(
      await request(app).delete("/stacks"),
      ORACLE_ALLOW.stacksCollection,
    );
  });

  it("PATCH /stacks returns 405 with allow: POST", async () => {
    expectMethodNotAllowed(
      await request(app).patch("/stacks"),
      ORACLE_ALLOW.stacksCollection,
    );
  });

  it("HEAD /stacks returns 405 with allow: POST and no body", async () => {
    // Express would normally serve HEAD through the GET handler. The oracle
    // declares no HEAD route at all, so this must be a 405, not a 200.
    const response = await request(app).head("/stacks");

    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe(ORACLE_ALLOW.stacksCollection);
    // The oracle sends the 31-byte JSON body's `content-length` but no body, as
    // HTTP framing requires for HEAD; `res.send` on a HEAD request reproduces
    // that. supertest reports the absent body as `undefined`, which is the
    // assertion here because the runtime contract is "no body bytes".
    expect(response.headers["content-length"]).toBe("31");
    expect(response.text).toBeUndefined();
  });

  it("POST /stacks/<uuid> returns 405 with allow: GET", async () => {
    const stackId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expectMethodNotAllowed(
      await request(app).post(`/stacks/${stackId}`),
      ORACLE_ALLOW.stackItem,
    );
  });

  it("PUT /stacks/<uuid> returns 405 with allow: GET, not the union of methods", async () => {
    // Measured: the oracle answers `allow: GET` even though PATCH and DELETE
    // are registered for this exact path. Starlette reports the methods of the
    // first route that partially matches and stops there.
    const stackId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expectMethodNotAllowed(
      await request(app).put(`/stacks/${stackId}`),
      ORACLE_ALLOW.stackItem,
    );
  });

  it("HEAD /stacks/<uuid> returns 405 with allow: GET, not 200", async () => {
    const stackId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const response = await request(app).head(`/stacks/${stackId}`);

    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe(ORACLE_ALLOW.stackItem);
  });

  it.each(["patch", "post", "delete"] as const)(
    "%s /health returns 405 with allow: GET",
    async (method) => {
      expectMethodNotAllowed(
        await request(app)[method]("/health"),
        ORACLE_ALLOW.health,
      );
    },
  );

  it("HEAD /health returns 405 with allow: GET, matching the oracle", async () => {
    const response = await request(app).head("/health");

    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe(ORACLE_ALLOW.health);
  });

  it("OPTIONS /stacks without Access-Control-Request-Method returns 405", async () => {
    // A bare OPTIONS is not a preflight; CORS leaves it alone and the oracle
    // answers it on the method axis like any other unsupported method.
    expectMethodNotAllowed(
      await request(app).options("/stacks"),
      ORACLE_ALLOW.stacksCollection,
    );
  });

  it("PUT /stacks with a malformed JSON body still answers 405, not 400", async () => {
    // Starlette rejects on method before the app (and therefore any body
    // parsing) is reached, so body-parser never gets a chance to complain.
    const response = await request(app)
      .put("/stacks")
      .set("Content-Type", "application/json")
      .send("{bad");

    expectMethodNotAllowed(response, ORACLE_ALLOW.stacksCollection);
  });

  it("a path that partially matches but has too many segments stays 404", async () => {
    // `/stacks/<a>/<b>` matches no route at any segment boundary the oracle
    // checks, so it is a genuine 404 rather than a 405.
    const response = await request(app).post("/stacks/a/b");

    expect(response.status).toBe(404);
    expect(response.text).toBe('{"detail":"Not Found"}');
  });

  /**
   * The graph endpoint lives under `/domain/kg`, a prefix the oracle does not
   * use. These cases pin that it is additive: it answers its own path, and it
   * leaves every oracle path's method axis exactly as measured.
   */
  describe("the /domain/kg graph extension", () => {
    const stackId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const graphPath = `/domain/kg/stacks/${stackId}/graph`;

    it("PUT /stacks/<uuid> still reports the stacks router alone", async () => {
      // The `Allow` walk takes the FIRST partial match. The graph router shares
      // no prefix with `/stacks`, so it cannot become that first match and this
      // value stays exactly what the oracle measured.
      expectMethodNotAllowed(
        await request(app).put(`/stacks/${stackId}`),
        ORACLE_ALLOW.stackItem,
      );
    });

    it("the graph path resolves to a full match rather than a 404", () => {
      // Asserted through the walk instead of a request, because a real GET would
      // reach the handler and open a transaction — this suite stays database-free
      // on purpose. A `full` match is what proves the mount is wired, and it is
      // exactly what a missing route could not produce.
      expect(resolveMethod(app.router.stack, graphPath, "GET")).toEqual({
        kind: "full",
      });
    });

    it("a method the graph route does not declare answers 405 with allow: GET", async () => {
      expectMethodNotAllowed(
        await request(app).put(graphPath),
        ORACLE_ALLOW.stackGraph,
      );
    });

    it("the old /stacks/<uuid>/graph path is now a 404", async () => {
      // The relocation is a move, not an alias: the endpoint must not linger on
      // the oracle-owned prefix, where it would still perturb that prefix's
      // `Allow` observations.
      const response = await request(app).get(`/stacks/${stackId}/graph`);

      expect(response.status).toBe(404);
      expect(response.text).toBe('{"detail":"Not Found"}');
    });
  });
});

describe("method resolution, against measured oracle values", () => {
  /**
   * A miniature app whose shape matches the oracle's route list: `/health`, the
   * `/stacks` router, and the two `documents` paths that expose the ordering
   * rule. Mounted in the oracle's declaration order.
   */
  const app = express();
  app.get("/health", (_req, res) => res.end());

  const stacks = express.Router();
  stacks.use((_req, _res, next) => next());
  stacks.post("/", (_req, res) => res.end());
  stacks.get("/:stack_id", (_req, res) => res.end());
  stacks.patch("/:stack_id", (_req, res) => res.end());
  stacks.delete("/:stack_id", (_req, res) => res.end());
  app.use("/stacks", stacks);

  const documents = express.Router();
  documents.post("/stacks/:stack_id/documents", (_req, res) => res.end());
  documents.get("/stacks/:stack_id/documents", (_req, res) => res.end());
  documents.get("/documents/:doc_id", (_req, res) => res.end());
  documents.delete("/documents/:doc_id", (_req, res) => res.end());
  app.use("/", documents);

  const stackLayers = app.router.stack;
  const uuid = "11111111-1111-1111-1111-111111111111";

  /**
   * `[method, path, oracle status, oracle allow]`.
   *
   * The `documents` rows and the `/stacks/{uuid}` rows are the ones that make
   * the rule visible: a first-path-match reading fails them, and so does a
   * union-of-methods reading.
   */
  const cases: readonly (readonly [string, string, number, string | undefined])[] = [
    ["PUT", "/stacks", 405, "POST"],
    ["POST", `/stacks/${uuid}`, 405, "GET"],
    ["PUT", `/stacks/${uuid}`, 405, "GET"],
    ["HEAD", `/stacks/${uuid}`, 405, "GET"],
    // A declared method reached through a later route is a dispatch, not a 405.
    ["PATCH", `/stacks/${uuid}`, 200, undefined],
    ["DELETE", `/stacks/${uuid}`, 200, undefined],
    ["GET", `/stacks/${uuid}`, 200, undefined],
    ["PUT", `/stacks/${uuid}/documents`, 405, "POST"],
    ["PUT", `/documents/${uuid}`, 405, "GET"],
    ["DELETE", "/health", 405, "GET"],
    ["HEAD", "/health", 405, "GET"],
    ["GET", "/health", 200, undefined],
    // Unknown paths stay unknown; no synthetic 405.
    ["POST", "/stacks/a/b", 404, undefined],
    ["PUT", "/nope", 404, undefined],
  ];

  it.each(cases)("%s %s -> %i", (method, path, status, allow) => {
    const outcome = resolveMethod(stackLayers, path, method);

    if (status === 405) {
      expect(outcome).toEqual({ kind: "partial", allow: [allow] });
    } else if (status === 200) {
      expect(outcome).toEqual({ kind: "full" });
    } else {
      expect(outcome).toEqual({ kind: "none" });
    }
  });
});

describe("404 stays a 404", () => {
  const app = createApp();

  it.each(["get", "post", "put", "delete", "patch", "head", "options"] as const)(
    "%s /does-not-exist returns the JSON Not Found body",
    async (method) => {
      const response = await request(app)[method]("/does-not-exist");

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      if (method !== "head") {
        expect(response.text).toBe('{"detail":"Not Found"}');
      }
    },
  );
});

describe("CORS", () => {
  const app = createApp();

  it("preflight with Origin returns the full oracle header set", async () => {
    const response = await request(app)
      .options("/stacks")
      .set("Origin", "http://example.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-api-key");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    // `QUERY` is part of Starlette's ALL_METHODS list; the port omitted it.
    expect(response.headers["access-control-allow-methods"]).toBe(
      ORACLE_ALLOW_METHODS,
    );
    // Mirrored back verbatim, not re-serialized.
    expect(response.headers["access-control-allow-headers"]).toBe(
      "content-type,x-api-key",
    );
    expect(response.headers["access-control-max-age"]).toBe("600");
    expect(response.headers["vary"]).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
    );
    expect(response.text).toBe("OK");
  });

  it("preflight without Access-Control-Request-Headers omits allow-headers", async () => {
    const response = await request(app)
      .options("/stacks")
      .set("Origin", "http://example.com")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty("access-control-allow-headers");
  });

  it("preflight validates the requested method the way the oracle does", async () => {
    // Measured: `Access-Control-Request-Method: post` (lowercase) is a failure,
    // the oracle compares the raw value against its uppercase method list.
    const rejected = await request(app)
      .options("/stacks")
      .set("Origin", "http://example.com")
      .set("Access-Control-Request-Method", "post");

    expect(rejected.status).toBe(400);
    expect(rejected.text).toBe("Disallowed CORS method");

    const accepted = await request(app)
      .options("/stacks")
      .set("Origin", "http://example.com")
      .set("Access-Control-Request-Method", "QUERY");

    expect(accepted.status).toBe(200);
    expect(accepted.text).toBe("OK");
  });

  it("a real preflight is not converted into a 405", async () => {
    const response = await request(app)
      .options("/stacks")
      .set("Origin", "http://example.com")
      .set("Access-Control-Request-Method", "PUT");

    expect(response.status).not.toBe(405);
    expect(response.status).toBe(200);
  });

  it("a request with no Origin does not emit access-control-allow-origin", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    expect(response.headers["vary"]).toBe("Origin");
  });

  it("a request with an Origin emits the wildcard allow-origin", async () => {
    const response = await request(app).get("/health").set("Origin", "http://example.com");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["vary"]).toBe("Origin");
  });

  it("same rule applies to error responses", async () => {
    const withOrigin = await request(app).get("/does-not-exist").set("Origin", "http://e.com");
    expect(withOrigin.headers["access-control-allow-origin"]).toBe("*");

    const withoutOrigin = await request(app).get("/does-not-exist");
    expect(withoutOrigin.headers).not.toHaveProperty("access-control-allow-origin");
    expect(withoutOrigin.headers["vary"]).toBe("Origin");
  });

  it("a preflight without Origin is answered by the router, not by CORS", async () => {
    // No Origin means no CORS preflight at all; the oracle falls through to the
    // method axis and answers 405.
    const response = await request(app)
      .options("/stacks")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(405);
    expect(response.headers).not.toHaveProperty("access-control-allow-origin");
    expect(response.text).toBe('{"detail":"Method Not Allowed"}');
  });
});
