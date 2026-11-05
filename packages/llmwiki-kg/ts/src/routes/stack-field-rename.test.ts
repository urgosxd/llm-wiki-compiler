/**
 * @file packages/llmwiki-kg/ts/src/routes/stack-field-rename.test.ts
 * @description The retired `stack_id` spelling refused on the two request effects
 * no other file pins: the query key on the AKS read surfaces and the body key on
 * `POST /aks/v1/context`.
 *
 * The legacy body key on `POST /aks/v1/backfeed/flag` is pinned by
 * `backfeed-flag.test.ts`, and the renamed `["path", "stackId"]` 422 tail by
 * `stacks-errors.test.ts`. These two had no assertion at all: a `?stack_id=`
 * query silently fell through to the either/or refusal, and the context body key
 * was only covered through its `/flag` sibling.
 */

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { createFixture, createTestApp, deleteFixtureRows, state, useDomainPrefix } from "./aks-harness.js";

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("rename");

/** The 422 the resolver answers when no Stack reference survives the parse. */
const EITHER_OR = {
  detail: "Either stackId (UUID) or domain (slug) must be provided",
};

/** The 422 a context body still carrying the retired key produces. */
const LEGACY_BODY_MESSAGE =
  "Value error, `stack_id` was renamed to `stackId`; send `stackId` instead";

/** Every AKS read surface that accepts `?stackId=` / `?domain=`. */
const QUERY_SURFACES = [
  "/aks/v1/entities",
  "/aks/v1/export",
  "/aks/v1/backfeed/queue",
  "/aks/v1/pages",
] as const;

/**
 * The same surfaces answering 200 without a provider call.
 *
 * `/aks/v1/pages` is excluded on purpose: it generates a page per entity, which
 * needs the model. Its own current-key success is pinned by
 * `pages-pages.test.ts` (`/aks/v1/pages/{name}?stackId=` answers 200), so the 422
 * asserted below is enough to prove the retired key resolved no Stack at all.
 */
const SURFACES_WITHOUT_MODEL = ["/aks/v1/entities", "/aks/v1/export", "/aks/v1/backfeed/queue"] as const;

describe.skipIf(state.skipReason !== false)(
  "the retired stack_id spelling (live database)",
  () => {
    let app: Express;
    let stackId: string;
    let domain: string;

    beforeEach(async () => {
      await deleteFixtureRows();
      app = createTestApp();
      const fixture = await createFixture();
      stackId = fixture.stackId;
      domain = fixture.domain;
    });

    afterAll(async () => {
      await deleteFixtureRows();
    });

    it.each(QUERY_SURFACES)("answers 422 for the retired ?stack_id= on %s", async (path) => {
      const response = await request(app).get(`${path}?stack_id=${stackId}`);

      expect(response.status).toBe(422);
      // The exact body: a plain-string detail, not the 422 error array, and not
      // the 404 an unresolved-but-recognised id would produce.
      expect(response.body).toEqual(EITHER_OR);
    });

    it("accepts the current key on the same surfaces, so the refusal is the spelling", async () => {
      for (const path of SURFACES_WITHOUT_MODEL) {
        await request(app).get(`${path}?stackId=${stackId}`).expect(200);
      }
    });

    it("refuses the retired stack_id body key on POST /aks/v1/context", async () => {
      const response = await request(app)
        .post("/aks/v1/context")
        .send({ stack_id: stackId, query: "how does the gateway route traffic?" });

      expect(response.status).toBe(422);
      // `value_error` is what Pydantic emits for a raising validator, and the
      // `loc` names the key the caller actually sent.
      expect(response.body).toEqual({
        detail: [
          {
            type: "value_error",
            loc: ["body", "stack_id"],
            msg: LEGACY_BODY_MESSAGE,
            input: stackId,
          },
        ],
      });
    });

    it("resolves the same rows by the current stackId and by domain", async () => {
      const byId = await request(app).get(`/aks/v1/entities?stackId=${stackId}`).expect(200);
      const byDomain = await request(app).get(`/aks/v1/entities?domain=${domain}`).expect(200);

      expect((byId.body as unknown[]).length).toBe(3);
      expect(byId.body).toEqual(byDomain.body);
    });
  },
);
