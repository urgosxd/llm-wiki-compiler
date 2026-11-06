/**
 * @file packages/llmwiki-kg/ts/src/routes/classification-log/prune-safety.test.ts
 * @description The two properties of failure retention that a shared-state test cannot
 * prove by interleaving alone — LIKE escaping and advisory-lock serialization — plus
 * the HTTP contract facts the operator documentation asserts.
 *
 * WHY THIS FILE EXISTS. The sibling suites prove the delete is bounded and reports what
 * it did. Two of those proofs are weaker than they look, and both weaknesses sit on the
 * delete itself:
 *
 * - **Escaping.** `provider_failure_preserved:` contains `_`, which is a single-character
 *   LIKE wildcard, so an unescaped pattern also matches `provider-failure-preserved:` and
 *   `providerXfailureXpreserved:`. The existing decoy test seeds ONE such lookalike; this
 *   file seeds every shape the wildcard can produce, so removing one `replaceAll` call can
 *   no longer pass unnoticed.
 * - **Serialization.** Two concurrent prunes of one Stack agreeing on a total proves the
 *   aggregate is right, not that `pg_advisory_xact_lock` exists: a lock-free run can land
 *   the same totals by timing. Here a FOREIGN session holds the Stack's lock first, so the
 *   prune must still be unresolved while it is held — a missing lock fails the test
 *   deterministically instead of probabilistically — and a failure event appended DURING
 *   the block must survive.
 *
 * The remaining cases pin contracts the operator docs state and no test observed: a Stack
 * that does not exist answers `200` with zeroes rather than `404`, `X-API-Key` is the
 * header that authenticates (the same value sent as a Bearer token is a `401`, because
 * there is no prefix handling), and the reported `cutoff` is the database's normalized
 * `Z`-suffixed timestamp with six fractional digits.
 *
 * ## Timing margins
 *
 * The lock test waits in bounded steps instead of polling: long enough that a scheduler
 * hiccup cannot make an unblocked prune look blocked, short enough to stay well inside the
 * vitest timeout. Nothing here loops on a condition, so a genuinely missing lock fails the
 * `settled === false` assertion immediately rather than after a retry budget.
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

import { createRequireApiKey, INVALID_API_KEY_DETAIL } from "../../auth.js";
import { parseConfig } from "../../config.js";
import {
  createClient,
  createRequestTransactionWrapper,
  createTransactionRunner,
} from "../../db.js";
import {
  createStack,
  database,
  deleteFixtureRows,
  skipReason,
  TEST_DATABASE_URL,
  UNKNOWN_UUID,
  useDomainPrefix,
} from "../ingest-harness.js";
import { createIngestRouter } from "../ingest.js";
import type { IngestRouterDependencies } from "../ingest.js";
import { VERIFIED_REFUSAL_REASON } from "../reclassify/persist.js";
import { FAILURE_REASON_PREFIX, pruneClassificationFailures } from "./prune.js";
import { logRows, MINUTES_PER_DAY, seedLogRow, seedLogRows } from "./prune-harness.js";
import type { LogRowSeed } from "./prune-harness.js";

useDomainPrefix("prune-safety");

/** The key the app under test is configured with; not a credential, a fixture value. */
const OPERATOR_API_KEY = "operator-key-not-a-credential";

/** How long the foreign session gets to take the advisory lock before the prune starts. */
const LOCK_SETTLE_MS = 400;

/** How long an unblocked prune would need to finish, so "still unresolved" means blocked. */
const BLOCK_OBSERVATION_MS = 600;

/** A bounded wait, so the lock test measures a window instead of racing a scheduler. */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** One preserved-after-failure event of one candidate, at a chosen age. */
function failure(stackId: string, candidateRef: string, ageInMinutes: number): LogRowSeed {
  return { stackId, candidateRef, reason: `${FAILURE_REASON_PREFIX}:failed`, ageInMinutes };
}

/** The storage call every non-HTTP test makes, so the runner wiring is written once. */
function pruneStorage(stackId: string, confirm: boolean) {
  return pruneClassificationFailures(createTransactionRunner(database()), { stackId, confirm });
}

/** The candidate refs a Stack's surviving history holds, in history order. */
async function survivingRefs(stackId: string): Promise<readonly string[]> {
  return (await logRows(stackId)).map((row) => row.candidate_ref);
}

/** Builds the application an operator calls, with a real API key configured. */
function buildApp(): Express {
  const deps: IngestRouterDependencies = {
    wrap: createRequestTransactionWrapper(database()),
    apiKey: createRequireApiKey(parseConfig({ AKS_API_KEY: OPERATOR_API_KEY })),
    run: createTransactionRunner(database()),
  };
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(createIngestRouter(deps));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** The retention endpoint of one Stack, with the raw query string appended. */
function pruneUrl(stackId: string, query = ""): string {
  return `/stacks/${stackId}/classification-log/prune${query}`;
}

describe.skipIf(skipReason !== false)("classification failure retention safety", () => {
  let app: Express;

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
  });

  afterEach(async () => {
    await deleteFixtureRows();
  });

  it("escapes LIKE wildcards so only the literal failure prefix is pruned", async () => {
    const stackId = await createStack();
    const old = 40 * MINUTES_PER_DAY;
    await seedLogRows([
      failure(stackId, "literal", old),
      // Every shape the unescaped `_` wildcard would reach: one-for-one substitution,
      // a dash, and a missing colon.
      { stackId, candidateRef: "underscore", reason: "providerXfailureXpreserved:failed", ageInMinutes: old },
      { stackId, candidateRef: "dashed", reason: "provider-failure-preserved:failed", ageInMinutes: old },
      { stackId, candidateRef: "no-colon", reason: "provider_failure_preservedXfailed", ageInMinutes: old },
      { stackId, candidateRef: "refusal", reason: VERIFIED_REFUSAL_REASON, ageInMinutes: old },
      { stackId, candidateRef: "changed", reason: "classification_changed", ageInMinutes: old },
    ]);

    const outcome = await pruneStorage(stackId, true);

    expect(outcome).toMatchObject({ matchedCount: 1, deletedCount: 1 });
    expect([...(await survivingRefs(stackId))].sort()).toEqual([
      "changed",
      "dashed",
      "no-colon",
      "refusal",
      "underscore",
    ]);
  });

  it("waits on the Stack's advisory lock and spares an event appended while blocked", async () => {
    const stackId = await createStack();
    await seedLogRows([failure(stackId, "old-one", 40 * MINUTES_PER_DAY)]);
    const holder = createClient(TEST_DATABASE_URL);
    let release = (): void => {};
    try {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = holder.begin(async (tx) => {
        // The same key the storage operation takes, held in a session of our own.
        await tx`select pg_advisory_xact_lock(hashtext(${`kg-classification-log-prune:${stackId}`}))`;
        await held;
      });
      await sleep(LOCK_SETTLE_MS);

      let settled = false;
      const pruned = pruneStorage(stackId, true).then((outcome) => {
        settled = true;
        return outcome;
      });
      await sleep(BLOCK_OBSERVATION_MS);
      // A prune that finished here never took the lock; this is what proves it exists.
      expect(settled).toBe(false);

      await seedLogRow(failure(stackId, "in-flight", 0));
      release();
      await holding;
      const outcome = await pruned;

      expect(outcome).toMatchObject({ matchedCount: 1, deletedCount: 1 });
      expect(await survivingRefs(stackId)).toEqual(["in-flight"]);
    } finally {
      // Released BEFORE the session closes: a failed assertion above must report itself
      // instead of stalling the teardown on a transaction nobody is going to end.
      release();
      await holder.end();
    }
  });

  it("answers 200 with zeroes for a Stack that does not exist instead of 404", async () => {
    const response = await request(app)
      .post(pruneUrl(UNKNOWN_UUID))
      .set("X-API-Key", OPERATOR_API_KEY)
      .expect(200);

    // A bounded set operation, not a lookup: no Stack means nothing to match, not a typo
    // to report, so there is deliberately no 404 path.
    expect(response.body).toMatchObject({ dryRun: true, matchedCount: 0, deletedCount: 0 });
  });

  it("authenticates X-API-Key and refuses the same value sent as a Bearer token", async () => {
    const stackId = await createStack();

    const accepted = await request(app)
      .post(pruneUrl(stackId))
      .set("X-API-Key", OPERATOR_API_KEY)
      .expect(200);
    expect(accepted.body).toMatchObject({ dryRun: true });

    // No prefix handling exists, so a Bearer-prefixed value is simply a wrong key.
    const refused = await request(app)
      .post(pruneUrl(stackId))
      .set("Authorization", `Bearer ${OPERATOR_API_KEY}`)
      .expect(401);
    expect(refused.body).toEqual({ detail: INVALID_API_KEY_DETAIL });
  });

  it("reports the cutoff as a 27-character UTC timestamp with six fractional digits", async () => {
    const stackId = await createStack();

    const response = await request(app)
      .post(pruneUrl(stackId))
      .set("X-API-Key", OPERATOR_API_KEY)
      .expect(200);

    expect(response.body.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(response.body.cutoff).toHaveLength(27);
  });
});
