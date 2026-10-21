import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./server.js";

/**
 * Byte-for-byte liveness contract, verified against the Python oracle
 * (`GET http://localhost:8000/health`). Field names, values, and order
 * are part of the contract: the TS port must not reorder or reshape it.
 */
const EXPECTED_HEALTH_BODY =
  '{"status":"ok","service":"aks-reference-server","version":"0.2.0"}';

describe("GET /health", () => {
  it("returns 200 with the exact oracle body, in oracle field order", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    // Compare the raw text so field order is verified, not just deep equality.
    expect(response.text).toBe(EXPECTED_HEALTH_BODY);
    expect(response.body).toEqual({
      status: "ok",
      service: "aks-reference-server",
      version: "0.2.0",
    });
  });

  it("requires no authentication", async () => {
    const response = await request(createApp()).get("/health");
    expect(response.status).toBe(200);
  });
});

describe("unknown route", () => {
  it("returns 404 with a JSON body containing detail", async () => {
    const response = await request(createApp()).get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toHaveProperty("detail");
    expect(typeof response.body.detail).toBe("string");
  });
});
