import express from "express";
import type { Express, Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  INVALID_API_KEY_DETAIL,
  createRequireApiKey,
  requireApiKey,
  type ApiKeyMiddleware,
} from "./auth.js";
import { config, parseConfig, type Config } from "./config.js";

/**
 * FastAPI renders HTTPException(detail=...) as `{"detail": "..."}` with no
 * spaces in the separators. Pinned as raw text so the 401 body is compared
 * character for character against the Python oracle's contract.
 */
const EXPECTED_401_BODY =
  '{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}';

const AUTH_ENABLED: Config = parseConfig({ AKS_API_KEY: "secret-key" });
const AUTH_DISABLED: Config = parseConfig({});

/** Minimal app: one guarded route so the middleware is exercised in isolation. */
function appWith(middleware: ApiKeyMiddleware): Express {
  const app = express();
  app.get("/protected", middleware, (_req, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

describe("requireApiKey detail string", () => {
  it("matches the FastAPI detail character for character", () => {
    expect(INVALID_API_KEY_DETAIL).toBe(
      "Invalid or missing API key. Provide it in the X-API-Key header.",
    );
  });
});

describe("requireApiKey with auth disabled (empty AKS_API_KEY)", () => {
  it("passes a request with no header through (fail-open when unconfigured)", async () => {
    const response = await request(appWith(createRequireApiKey(AUTH_DISABLED))).get(
      "/protected",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("passes a request with an arbitrary header through", async () => {
    const response = await request(appWith(createRequireApiKey(AUTH_DISABLED)))
      .get("/protected")
      .set("X-API-Key", "anything-at-all");

    expect(response.status).toBe(200);
  });
});

describe("requireApiKey with auth enabled", () => {
  const app = appWith(createRequireApiKey(AUTH_ENABLED));

  it("returns 401 when the header is missing", async () => {
    const response = await request(app).get("/protected");

    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.text).toBe(EXPECTED_401_BODY);
    expect(response.body).toEqual({ detail: INVALID_API_KEY_DETAIL });
  });

  it("returns 401 when the header value is wrong", async () => {
    const response = await request(app).get("/protected").set("X-API-Key", "nope");

    expect(response.status).toBe(401);
    expect(response.text).toBe(EXPECTED_401_BODY);
  });

  it("returns 200 when the header value is correct", async () => {
    const response = await request(app)
      .get("/protected")
      .set("X-API-Key", "secret-key");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("returns 401 for a Bearer-prefixed value (no prefix handling exists)", async () => {
    const response = await request(app)
      .get("/protected")
      .set("X-API-Key", "Bearer secret-key");

    expect(response.status).toBe(401);
    expect(response.text).toBe(EXPECTED_401_BODY);
  });

  it("returns 401 for a prefix or suffix of the key (exact equality, not startsWith)", async () => {
    const short = await request(app).get("/protected").set("X-API-Key", "secret-ke");
    const long = await request(app).get("/protected").set("X-API-Key", "secret-keyy");

    expect(short.status).toBe(401);
    expect(long.status).toBe(401);
  });

  it("accepts the header whatever case the client sends it in", async () => {
    const upper = await request(app)
      .get("/protected")
      .set("X-API-KEY", "secret-key");
    const mixed = await request(app)
      .get("/protected")
      .set("x-Api-Key", "secret-key");

    expect(upper.status).toBe(200);
    expect(mixed.status).toBe(200);
  });

});

describe("default export binding", () => {
  it("requireApiKey follows the module config singleton", async () => {
    const response = await request(appWith(requireApiKey)).get("/protected");

    // Derived from the live config so the assertion holds whatever the
    // developer's ambient AKS_API_KEY happens to be.
    expect(response.status).toBe(config.authEnabled ? 401 : 200);
  });
});
