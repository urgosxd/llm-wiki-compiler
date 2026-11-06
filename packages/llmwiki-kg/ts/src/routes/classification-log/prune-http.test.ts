/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune-http.test.ts
 * @description What the OPERATOR sees when they reach classification-failure retention
 * over HTTP: the exact status codes, the exact response keys, the query contract, and
 * the stored rows before and after each call.
 *
 * WHY THIS FILE EXISTS. The storage function has its own suites, and they prove the
 * delete is bounded. They prove nothing about the surface an operator actually calls,
 * which is where the dangerous mistakes live:
 *
 * - a default that DELETES. `dryRun` must default to true, and the route must never
 *   hand `confirm: true` to the storage layer unless the caller spelled it out;
 * - a confirmation flag that turns itself on. `z.coerce.boolean()` reads the string
 *   `"false"` as `true`, so `?confirm=false` would delete; only the literals `true`
 *   and `false` are accepted here and everything else is a 422;
 * - a rejected request that still mutates. Every 422 case below is asserted against
 *   the unchanged history, not just against the status code;
 * - a window that is ignored, or a Stack boundary that is not enforced, both of which
 *   answer 200 while deleting the wrong rows.
 *
 * ## How it is driven
 *
 * Supertest against a real Express application built the way the sibling route suites
 * build one: the production `createIngestRouter` — which is where the reclassification
 * route and therefore this one are mounted — over the fixture pool, with a real
 * `createTransactionRunner`. Nothing is stubbed below the HTTP layer, so a 422 here is
 * the 422 an operator would receive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  delete process.env["TYPESAFE_API_KEY"];
});

import express from "express";
import type { Express } from "express";
import request from "supertest";

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import {
  createStack,
  database,
  deleteFixtureRows,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { VERIFIED_REFUSAL_REASON } from "../reclassify/persist.js";
import { FAILURE_REASON_PREFIX } from "./prune.js";
import { logRows, MINUTES_PER_DAY, seedLogRows } from "./prune-harness.js";
import type { LogRowSeed } from "./prune-harness.js";

useDomainPrefix("prune-http");

/** The five keys the success body carries, in the order an operator reads them. */
const RESPONSE_KEYS = ["dryRun", "retentionDays", "cutoff", "matchedCount", "deletedCount"];

/** One preserved-after-failure event of one candidate, at a chosen age. */
function failure(stackId: string, candidateRef: string, ageInMinutes: number): LogRowSeed {
  return { stackId, candidateRef, reason: `${FAILURE_REASON_PREFIX}:failed`, ageInMinutes };
}

/** One refusal event: state, never an event, so retention must not reach it. */
function refusal(stackId: string, candidateRef: string, ageInMinutes: number): LogRowSeed {
  return { stackId, candidateRef, reason: VERIFIED_REFUSAL_REASON, ageInMinutes };
}

/** Builds the application the operator calls, over the fixture pool. */
function buildApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: "" })),
    run: createTransactionRunner(database()),
  };
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ detail: message });
    },
  );
  return app;
}

/** The retention endpoint of one Stack, with the raw query string appended. */
function pruneUrl(stackId: string, query = ""): string {
  return `/stacks/${stackId}/classification-log/prune${query}`;
}

/** The candidate refs a Stack's surviving history holds, in history order. */
async function survivingRefs(stackId: string): Promise<readonly string[]> {
  return (await logRows(stackId)).map((row) => row.candidate_ref);
}

describe.skipIf(skipReason !== false)("POST classification-log prune", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  it("reports what it would delete and deletes nothing when no confirm is supplied", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-failure", 40 * MINUTES_PER_DAY),
      failure(stackId, "recent-failure", 1 * MINUTES_PER_DAY),
    ]);
    const before = await logRows(stackId);

    const response = await request(app).post(pruneUrl(stackId)).expect(200);

    expect(Object.keys(response.body)).toEqual(RESPONSE_KEYS);
    expect(response.body).toEqual({
      dryRun: true,
      retentionDays: 30,
      cutoff: expect.any(String),
      matchedCount: 1,
      deletedCount: 0,
    });
    expect(Number.isNaN(Date.parse(response.body.cutoff))).toBe(false);
    expect(await logRows(stackId)).toEqual(before);
  });

  it("treats an explicit confirm=false as a dry run, not a confirmation", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-one", 40 * MINUTES_PER_DAY),
      failure(stackId, "old-two", 50 * MINUTES_PER_DAY),
      failure(stackId, "recent", 1 * MINUTES_PER_DAY),
    ]);
    const before = await logRows(stackId);

    const response = await request(app).post(pruneUrl(stackId, "?confirm=false")).expect(200);

    expect(response.body).toEqual({
      dryRun: true,
      retentionDays: 30,
      cutoff: expect.any(String),
      matchedCount: 2,
      deletedCount: 0,
    });
    // The trap this pins: a coerced boolean reads "false" as truthy and deletes.
    expect(await logRows(stackId)).toEqual(before);
  });

  it("deletes the eligible failure rows and keeps newer failures and old refusals", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-one", 40 * MINUTES_PER_DAY),
      failure(stackId, "old-two", 50 * MINUTES_PER_DAY),
      failure(stackId, "recent", 1 * MINUTES_PER_DAY),
      refusal(stackId, "verified", 40 * MINUTES_PER_DAY),
    ]);

    const response = await request(app).post(pruneUrl(stackId, "?confirm=true")).expect(200);

    expect(response.body).toEqual({
      dryRun: false,
      retentionDays: 30,
      cutoff: expect.any(String),
      matchedCount: 2,
      deletedCount: 2,
    });
    expect([...(await survivingRefs(stackId))].sort()).toEqual(["recent", "verified"]);
  });

  it("honours a custom retention window instead of the default", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "beyond-window", 60 * MINUTES_PER_DAY),
      failure(stackId, "between-windows", 40 * MINUTES_PER_DAY),
      failure(stackId, "inside-window", 10 * MINUTES_PER_DAY),
    ]);

    const response = await request(app)
      .post(pruneUrl(stackId, "?confirm=true&retentionDays=45"))
      .expect(200);

    expect(response.body).toEqual({
      dryRun: false,
      retentionDays: 45,
      cutoff: expect.any(String),
      matchedCount: 1,
      deletedCount: 1,
    });
    // 40 days is older than the default and newer than the window asked for: kept.
    expect([...(await survivingRefs(stackId))].sort()).toEqual(["between-windows", "inside-window"]);
  });

  it("rejects every malformed query with a 422 and leaves the history untouched", async () => {
    const stackId = await createStack();
    await seedLogRows([
      failure(stackId, "old-failure", 40 * MINUTES_PER_DAY),
      failure(stackId, "recent-failure", 1 * MINUTES_PER_DAY),
    ]);
    const before = await logRows(stackId);
    const cases = [
      { query: "?confirm=yes", field: "confirm" },
      { query: "?confirm=true&retentionDays=0", field: "retentionDays" },
      { query: "?confirm=true&retentionDays=99999", field: "retentionDays" },
      { query: "?confirm=true&retentionDays=abc", field: "retentionDays" },
    ];

    for (const entry of cases) {
      const response = await request(app).post(pruneUrl(stackId, entry.query)).expect(422);
      expect(Array.isArray(response.body.detail)).toBe(true);
      expect(response.body.detail[0].loc).toEqual(["query", entry.field]);
    }
    expect(await logRows(stackId)).toEqual(before);
  });

  it("prunes the Stack named in the path and no other Stack's rows", async () => {
    const stackUnderRetention = await createStack();
    const otherStack = await createStack();
    await seedLogRows([
      failure(stackUnderRetention, "mine", 40 * MINUTES_PER_DAY),
      failure(otherStack, "theirs", 40 * MINUTES_PER_DAY),
    ]);
    const otherBefore = await logRows(otherStack);

    const response = await request(app)
      .post(pruneUrl(stackUnderRetention, "?confirm=true"))
      .expect(200);

    expect(response.body).toEqual({
      dryRun: false,
      retentionDays: 30,
      cutoff: expect.any(String),
      matchedCount: 1,
      deletedCount: 1,
    });
    expect(await survivingRefs(stackUnderRetention)).toEqual([]);
    expect(await logRows(otherStack)).toEqual(otherBefore);
  });
});
