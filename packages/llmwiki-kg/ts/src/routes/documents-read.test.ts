/**
 * @file packages/llmwiki-kg/ts/src/routes/documents-read.test.ts
 * @description The two `GET` endpoints.
 */

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { RESPONSE_KEYS, UNKNOWN_UUID, asRows, buildApp, deleteFixtureRows, expectOracleTimestamp, field, insertStack, responseKeys, skipReason, tick, uniqueDomain, useDomainPrefix } from "./documents-harness.js";
useDomainPrefix("read");


describe.skipIf(skipReason !== false)("documents read (live database)", () => {
      beforeEach(deleteFixtureRows);

      it("GET /stacks/:stack_id/documents lists a stack's documents newest first", async () => {
        const app = buildApp();
        const stackId = await insertStack(uniqueDomain("list"));

        const emptyList = await request(app).get(`/stacks/${stackId}/documents`);
        expect(emptyList.status).toBe(200);
        expect(emptyList.body).toEqual([]);

        const first = await request(app)
          .post(`/stacks/${stackId}/documents`)
          .attach("file", Buffer.from("first document\n"), { filename: "first.txt" });
        expect(first.status).toBe(201);
        await tick();
        const second = await request(app)
          .post(`/stacks/${stackId}/documents`)
          .attach("file", Buffer.from("second document\n"), { filename: "second.txt" });
        expect(second.status).toBe(201);

        const listed = await request(app).get(`/stacks/${stackId}/documents`);
        expect(listed.status).toBe(200);

        const rows = asRows(listed.body);
        expect(rows.map((row) => row["filename"])).toEqual(["second.txt", "first.txt"]);
        for (const row of rows) {
          expect(Object.keys(row)).toEqual([...RESPONSE_KEYS]);
          expect(row["stack_id"]).toBe(stackId);
          expectOracleTimestamp(row["ingested_at"]);
        }

        // A second stack's documents never leak into the list.
        const otherStackId = await insertStack(uniqueDomain("list-other"));
        const other = await request(app)
          .post(`/stacks/${otherStackId}/documents`)
          .attach("file", Buffer.from("other stack\n"), { filename: "other.txt" });
        expect(other.status).toBe(201);

        const stillListed = await request(app).get(`/stacks/${stackId}/documents`);
        expect(asRows(stillListed.body)).toHaveLength(2);
      });

      it("GET /stacks/:stack_id/documents 404s an unknown stack", async () => {
        const app = buildApp();

        const response = await request(app).get(`/stacks/${UNKNOWN_UUID}/documents`);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ detail: `Stack ${UNKNOWN_UUID} not found` });

        // An uppercase path id is normalized to the canonical lowercase form.
        const uppercase = await request(app).get(
          `/stacks/${UNKNOWN_UUID.toUpperCase()}/documents`,
        );
        expect(uppercase.status).toBe(404);
        expect(uppercase.body).toEqual({ detail: `Stack ${UNKNOWN_UUID} not found` });
      });

      it("GET /stacks/:stack_id/documents/:doc_id returns the document, and 404s an unknown id", async () => {
        const app = buildApp();
        const stackId = await insertStack(uniqueDomain("getbyid"));

        const created = await request(app)
          .post(`/stacks/${stackId}/documents`)
          .attach("file", Buffer.from("fetch me\n"), { filename: "fetch.txt" });
        expect(created.status).toBe(201);
        const documentId = String(field(created.body, "id"));

        const found = await request(app).get(`/stacks/${stackId}/documents/${documentId}`);
        expect(found.status).toBe(200);
        expect(found.body).toEqual(created.body);
        expect(responseKeys(found.text)).toEqual([...RESPONSE_KEYS]);
        expectOracleTimestamp(field(found.body, "ingested_at"));

        const missing = await request(app).get(`/stacks/${stackId}/documents/${UNKNOWN_UUID}`);
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ detail: `Document ${UNKNOWN_UUID} not found` });
      });

      it("GET a document under the WRONG stack is a 404, not a cross-stack read", async () => {
        // This replaces a test that asserted the opposite. The old case was named
        // 'serves a document belonging to any stack' and cited the oracle as its
        // authority, which was accurate: the by-id route carried no stack, so any
        // caller read any tenant's document.
        //
        // That was a leak, not a feature, and it stayed invisible because the
        // connection ran as a superuser bypassing row-level security. With the
        // Stack in the path the read is scoped by construction, so the same request
        // now has to fail.
        //
        // 404 rather than 403 on purpose: 'forbidden' would confirm the id exists
        // somewhere, which is the same disclosure wearing a different status code.
        const app = buildApp();
        const ownerStack = await insertStack(uniqueDomain("owner"));
        const otherStack = await insertStack(uniqueDomain("other"));

        const created = await request(app)
          .post(`/stacks/${ownerStack}/documents`)
          .attach("file", Buffer.from("cross stack\n"), { filename: "cross.txt" });
        expect(created.status).toBe(201);
        const documentId = String(field(created.body, "id"));

        const sameStack = await request(app).get(`/stacks/${ownerStack}/documents/${documentId}`);
        expect(sameStack.status).toBe(200);

        const wrongStack = await request(app).get(`/stacks/${otherStack}/documents/${documentId}`);
        expect(wrongStack.status).toBe(404);
        expect(field(wrongStack.body, "stack_id")).toBeUndefined();
      });
  },
);
