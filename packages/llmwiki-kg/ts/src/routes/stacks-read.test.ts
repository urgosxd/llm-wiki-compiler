/**
 * @file packages/llmwiki-kg/ts/src/routes/stacks-read.test.ts
 * @description `GET /stacks` and `GET /stacks/:stack_id`.
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { RESPONSE_KEYS, asRows, buildApp, createBody, currentDomainPrefix, deleteFixtureRows, skipReason, tick, useDomainPrefix } from "./stacks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("read");

describe.skipIf(skipReason !== false)("/stacks read (live database)", () => {
    let sequence = 0;

    /** Unique domain per call, carrying the cleanup prefix. */
    function uniqueDomain(label: string): string {
      sequence += 1;
      return `${currentDomainPrefix()}${label}-${Date.now().toString(36)}-${String(sequence)}`;
    }

  async function createOrderedStacks(app: Express): Promise<[request.Response, request.Response, request.Response]> {
    const names = ["A", "B", "C"] as const;
    const responses: request.Response[] = [];
    for (const name of names) {
      responses.push(
        await request(app)
          .post("/stacks")
          .send(createBody(uniqueDomain(`order-${name.toLowerCase()}`), { name })),
      );
    }
    return responses as [request.Response, request.Response, request.Response];
  }

    // Start every test from a known state, and clean up even if a test failed
    // before its own assertions ran.
    beforeEach(deleteFixtureRows);

    it("GET /stacks lists rows ordered by updated_at desc", async () => {
      const app = buildApp();

      // `stacks` is shared: `db.test.ts` runs in a parallel worker and writes its
      // own `t04-` rows, so "the table is empty" is not a stable assertion. What is
      // stable — and what this suite is responsible for — is that none of *this*
      // suite's rows exist yet.
      const empty = await request(app).get("/stacks");
      expect(empty.status).toBe(200);
      expect(
        asRows(empty.body).filter((row) =>
          String(row["domain"]).startsWith(currentDomainPrefix()),
        ),
      ).toEqual([]);

      const [first, second, third] = await createOrderedStacks(app);
      expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);

      // Touching the middle row must move it to the front — the reason the
      // ORDER BY exists.
      await tick();
      const touched = await request(app)
        .patch(`/stacks/${String(second.body.id)}`)
        .send({ description: "touched" });
      expect(touched.status).toBe(200);

      const listed = await request(app).get("/stacks");
      expect(listed.status).toBe(200);

      // Relative order of this suite's own rows, ignoring any concurrent fixture
      // from another suite: the touched row moves to the front.
      const rows = asRows(listed.body);
      const mine = rows.filter((row) => String(row["domain"]).startsWith(currentDomainPrefix()));
      expect(mine.map((row) => row["name"])).toEqual(["B", "C", "A"]);

      // Every row carries the full oracle shape, in order.
      for (const row of rows) {
        expect(Object.keys(row)).toEqual([...RESPONSE_KEYS]);
      }
    });

    it("GET /stacks/:stack_id returns 200 for a known id and 404 for an unknown one", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/stacks")
        .send(createBody(uniqueDomain("get")));
      expect(created.status).toBe(201);

      const found = await request(app).get(`/stacks/${String(created.body.id)}`);
      expect(found.status).toBe(200);
      expect(found.body).toEqual(created.body);

      const missingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const missing = await request(app).get(`/stacks/${missingId}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ detail: `Stack ${missingId} not found` });

      // The detail carries the canonical lowercase hyphenated form, which is what
      // Pydantic serializes — an uppercase or simple-form id is normalized first.
      const uppercase = await request(app).get(
        "/stacks/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      );
      expect(uppercase.status).toBe(404);
      expect(uppercase.body).toEqual({ detail: `Stack ${missingId} not found` });
    });
  },
);
