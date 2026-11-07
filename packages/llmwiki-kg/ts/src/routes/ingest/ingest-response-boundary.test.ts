/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest/ingest-response-boundary.test.ts
 * @description The ingest endpoint must not answer the caller before its last
 * transaction has COMMITted.
 *
 * ## The property, and why it is the caller's property and not an implementation detail
 *
 * `POST /stacks/:stackId/documents/:doc_id/ingest` runs its eight stages across three
 * short transactions, because no transaction may be open while a provider is called.
 * The answer belongs to the LAST of them: today the pipeline writes the 200 from
 * inside the callback it hands to the runner, so the client receives its
 * `IngestionResult` while that transaction is still open and its COMMIT is still
 * pending. A caller that acts on a 200 — a follow-up statement, a retry trigger, a
 * second request — can therefore observe pre-commit state, and a 200 can even be
 * delivered for a write that later rolls back. Both are visible from the socket, so
 * both are properties this file asserts, not internals it pokes at.
 *
 * ## Why a GATED runner instead of timing
 *
 * The defect is an ORDERING defect, and timing assertions would measure how fast a
 * local database answers rather than which event preceded which. The test therefore
 * replaces the injected `run` with a wrapper that does the real work — same pool, same
 * `createTransactionRunner`, same COMMIT — and then holds its own RESOLUTION behind a
 * promise the test owns. Holding the resolution after the real runner resolves keeps
 * nothing open across the wait: the transaction is committed and its connection is back
 * in the pool, so the repository's no-long-held-transaction rule stays intact, while
 * the pipeline's continuation is provably paused.
 *
 * ## Why the property hangs on the engagement SIGNAL, not on elapsed time
 *
 * Holding a resolution proves nothing until the gate is known to be holding one: an
 * earlier version raced the first answer against a fixed ~300 ms window and only then
 * checked that the gate had engaged. On a loaded machine the pipeline can take longer
 * than that window to reach the third boundary, so the window elapsed with no answer and
 * the file reported "held" even for an implementation that writes its 200 from inside
 * the `run` callback — the exact defect it exists to catch. The wrapper therefore
 * exposes an `engagement` promise that resolves the moment it first holds a resolution
 * at the answer boundary, and the test awaits THAT before it looks at the client. No
 * assertion here depends on how long the pipeline takes to reach the boundary: the
 * engagement wait has its own generous budget and fails the test as a broken fixture
 * (never as a held answer) when it expires, and only an ENGAGED gate makes the short
 * post-engagement window meaningful, because from that instant the continuation is
 * provably paused.
 *
 * The gate watches the pipeline's THIRD boundary onward, which is the last one today
 * and is documented as such at the top of `pipeline.ts`. Gating from the first call
 * instead would hold the READ stage and prove nothing; gating `>= 3` keeps the property
 * honest if a fourth stage is added later.
 *
 * ## Why the whole success shape is asserted, not just the status
 *
 * This endpoint has no differential coverage of its own: `ingest-*.test.ts` assert what
 * ingest STORES, and the response body is only ever consumed with a bare
 * `.expect(200)`. A boundary change that dropped, renamed or coerced a field would
 * therefore pass every existing suite. Parsing the body through `IngestionResult` and
 * pinning `document_id` to the document that was actually ingested is the cheapest
 * check that the replay-after-COMMIT path still produces the same nine-key wire shape.
 *
 * Every provider answer is scripted (`core/extraction-harness.js`), and no classifier is
 * configured, so nothing here reaches a network and no decision client is involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Provider configuration, hoisted above every import — see `ingest-formation.test.ts`. */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

import request from "supertest";
import express from "express";
import type { Express } from "express";

import { createRequireApiKey } from "../../auth.js";
import { parseConfig } from "../../config.js";
import { createRequestTransactionWrapper, createTransactionRunner } from "../../db.js";
import type { TransactionRunner } from "../../db.js";
import { installFetchStub, setToolResponse, uninstallFetchStub } from "../../core/extraction-harness.js";
import { createIngestRouter } from "../ingest.js";
import {
  createDocument,
  createStack,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "../ingest-harness.js";
import { IngestionResult } from "./models.js";

useDomainPrefix("boundary");

/** The document's prose; the triplet's endpoints are quoted from it verbatim. */
const BODY = "El Comité de Cambios ejecuta la gestión de cambios.";

/** The model's whole answer: one triplet whose labels are in the default catalog. */
const ANSWER = {
  triplets: [
    {
      subject: { type: "role", name: "Comité de Cambios" },
      relation: { type: "ejecuta" },
      object: { type: "process", name: "Gestión de cambios" },
    },
  ],
  entities: [],
};

/**
 * How long the client is given to answer once the gate is KNOWN to be engaged.
 *
 * This window runs after {@link GatedRunner.engagement} resolved, so its outcome cannot
 * be explained by a slow pipeline: the continuation was already paused when it started.
 */
const HOLD_WINDOW_MS = 300;

/**
 * How long the pipeline is given to reach the answer boundary at all.
 *
 * Expiring here is a broken fixture — the gate never engaged, so nothing about the
 * ordering was observed — and never evidence that the client was held.
 */
const ENGAGEMENT_TIMEOUT_MS = 15_000;

/**
 * The first boundary whose COMMIT must precede the answer.
 *
 * `pipeline.ts` documents three short transactions; the third is the one that writes
 * the audit blob and produces the payload the response carries.
 */
const ANSWER_BOUNDARY = 3;

/** One first-answer observation: the client was answered, or the window elapsed. */
type FirstAnswer =
  | { readonly kind: "answered"; readonly status: number }
  | { readonly kind: "held" };

/** One engagement observation: the gate held the boundary, or the budget expired. */
type Engagement = { readonly kind: "engaged" } | { readonly kind: "never" };

/** A runner whose resolution can be held by the test once the real COMMIT is done. */
interface GatedRunner {
  /** Pass this as the router's `run`. */
  readonly run: TransactionRunner;
  /** Resolves the FIRST time a resolution at the answer boundary is actually held. */
  readonly engagement: Promise<void>;
  /** Release the held resolution. Idempotent. */
  open(): void;
  /** How many pipeline boundaries reached the hold. */
  held(): number;
}

/**
 * Wraps the real fixture runner so its RESOLUTION — not its COMMIT — is gated.
 *
 * The returned `engagement` promise resolves at the instant the hold is taken, which is
 * what lets the test distinguish "the answer was ordered after the boundary" from "the
 * pipeline had not reached the boundary yet".
 *
 * @param openGate - Called when the test releases the gate.
 * @returns The injectable runner, its engagement signal, and the counters asserted on.
 */
function createGatedRunner(openGate: { release: () => void }): GatedRunner {
  const real = createTransactionRunner(database());
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGate.release = () => release();
  let engaged: () => void = () => {};
  const engagement = new Promise<void>((resolve) => {
    engaged = resolve;
  });
  const stats = { calls: 0, held: 0 };
  const run: TransactionRunner = async (fn) => {
    stats.calls += 1;
    const boundary = stats.calls;
    // The real runner COMMITs before it resolves, so awaiting the gate afterwards
    // holds no transaction: the connection is already back in the pool.
    const value = await real(fn);
    if (boundary >= ANSWER_BOUNDARY) {
      stats.held += 1;
      engaged();
      await gate;
    }
    return value;
  };
  return { run, engagement, open: () => release(), held: () => stats.held };
}

/**
 * Awaits `signal`, falling back to `fallback` once `ms` elapse.
 *
 * The timer is cleared as soon as the signal settles, so a fast signal leaves nothing
 * pending, and a rejected signal rejects here instead of being reported as a fallback.
 */
function within<T, F>(signal: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    signal.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Builds an app whose ingest route opens its transactions with `run`. */
function buildApp(run: TransactionRunner): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));
  const app = express();
  app.use(express.json({ strict: false }));
  // The production shape: `run` is present, so the handler takes the runner branch and
  // the pipeline owns its own bounded transactions.
  app.use(createIngestRouter({ wrap, apiKey, run }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

describe.skipIf(skipReason !== false)("ingest answers only after its transaction COMMITs", () => {
  const gate = { release: () => {} };

  beforeEach(async () => {
    await deleteFixtureRows();
    installFetchStub();
  });

  afterEach(async () => {
    // Never leave a held resolution behind, even when an assertion failed early.
    gate.release();
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("keeps the client unanswered until the last boundary resolves, then answers 200 (S3)", async () => {
    const stackId = await createStack();
    const documentId = await createDocument(stackId, BODY);
    setToolResponse([ANSWER]);
    const gated = createGatedRunner(gate);

    // Started once, never awaited until the gate is released: `.then` here is what
    // issues the request, and awaiting the SAME native promise afterwards cannot end
    // it twice.
    const answered = request(buildApp(gated.run))
      .post(ingestUrl(stackId, documentId))
      .then((response) => response);

    // The property is carried by the ENGAGEMENT: nothing about the client is inspected
    // until the gate is provably holding the last boundary's resolution.
    const engagement: Engagement = await within(
      gated.engagement.then(() => ({ kind: "engaged" as const })),
      ENGAGEMENT_TIMEOUT_MS,
      { kind: "never" as const },
    );
    expect(
      engagement.kind,
      `the pipeline never reached boundary ${String(ANSWER_BOUNDARY)} within ${String(ENGAGEMENT_TIMEOUT_MS)}ms: broken fixture, not a held answer`,
    ).toBe("engaged");

    // Meaningful only now: the continuation was already paused when this window began,
    // so "held" cannot be an artefact of a slow pipeline.
    const first: FirstAnswer = await within(
      answered.then((response) => ({ kind: "answered" as const, status: response.status })),
      HOLD_WINDOW_MS,
      { kind: "held" as const },
    );
    expect(
      first.kind,
      first.kind === "answered"
        ? `the client already had status ${first.status} while the last transaction's COMMIT was gated`
        : `the answer waited ${HOLD_WINDOW_MS}ms after the gate engaged`,
    ).toBe("held");

    gated.open();
    const response = await answered;

    expect(gated.held(), "the gate never engaged: no pipeline boundary was held").toBeGreaterThan(0);
    expect(response.status).toBe(200);
    expect(response.type).toBe("application/json");
    const body = IngestionResult.parse(response.body);
    expect(body.document_id).toBe(documentId);
  });
});
