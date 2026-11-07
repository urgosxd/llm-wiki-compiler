/**
 * @file packages/llmwiki-kg/ts/src/request-transaction-boundary.test.ts
 * @description Pin WHERE the request transaction ends, relative to the HTTP answer.
 *
 * ## The property these tests exist for
 *
 * `createRequestTransactionWrapper` hands the handler its request-scoped `tx` and
 * awaits it, so the COMMIT is issued when the handler RESOLVES. The handler also
 * sends the HTTP response, and Express flushes it immediately. Nothing therefore
 * orders the two: the client can be holding a success for a row that is not yet
 * committed, and is not committed at all if the COMMIT later fails. That is one
 * defect with three observed symptoms — a follow-up statement that cannot see the
 * row it was just told was written, `23503` foreign keys on `stack_documents`
 * under contention, and an entity stuck `pending` because a decision UPDATE read
 * pre-commit state.
 *
 * So the tests assert the caller-visible contract, never the implementation: what
 * an INDEPENDENT connection can see at the moment the client has its answer.
 *
 * ## Why a probe route instead of a real endpoint
 *
 * A real endpoint's body has to be measured against the Python oracle, so its
 * timing is not something this file may control. The wrapper is the thing under
 * test, and it is a pure adapter: mounting it in front of a handler that writes,
 * answers and then stalls is the smallest honest way to ask "has the COMMIT
 * landed yet?". The stall (`pg_sleep`) exists so the answer cannot be a race: on
 * today's code the transaction is still open for a known, measured interval after
 * the client's `201`, so the failure is deterministic rather than a coin flip.
 *
 * ## Why the tests own their table
 *
 * `public.stacks` and its neighbours are `force row level security` tables, so
 * reading them back needs a tenant context this file has no business inventing;
 * and `document_chunks`/`ontology_*` carry columns whose constraints would make a
 * minimal insert an assertion about them rather than about the commit. A table of
 * two columns in this process's OWN per-run database carries none of that: it is
 * `create table if not exists` in `beforeAll`, emptied in `afterAll`, and the
 * per-run database is dropped when the process ends, so nothing leaks and the
 * suite is re-runnable.
 *
 * ## Why the deferred unique constraint
 *
 * A commit-time failure has to be distinguishable from a handler-time failure.
 * A `DEFERRABLE INITIALLY DEFERRED` unique constraint is checked at COMMIT only,
 * so a handler can insert a duplicate pair, answer `201`, and still have the
 * COMMIT rejected — exactly the shape being pinned. A `CHECK` constraint cannot
 * be deferred in Postgres and would fail inside the handler instead.
 *
 * ## The error shape
 *
 * The live server answers an error with no numeric `status` through `handleError`
 * (`server.ts`), which is not exported: HTTP 500, `text/plain`, body
 * `Internal Server Error`. The probe app reproduces that branch verbatim rather
 * than approximating it, because the shape IS the assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";

import { createClient, createDatabase, createRequestTransactionWrapper } from "./db.js";
import type { Database, TransactionalHandler } from "./db.js";
import { noDatabase } from "./testing/no-database.js";
import { perRunDatabase } from "./testing/per-run-database.js";

/** The SERVER this process's own database is provisioned on. */
const TEST_SERVER_URL =
  process.env["AKS_TEST_DATABASE_URL"] ??
  process.env["LLMWIKI_TEST_DATABASE_URL"] ??
  "postgresql://aks:aks@localhost:5434/aks";

/** Fail fast when the server is unreachable, so a skip is a reported failure. */
const CONNECT_TIMEOUT_SECONDS = 3;

/**
 * How long the probe handler keeps its transaction open AFTER answering.
 *
 * Long enough that a fast machine cannot close the window: one round trip for the
 * client's `201` plus one independent `select` is milliseconds, and this is 500 of
 * them. Short enough that a failing run stays readable.
 */
const STALL_AFTER_ANSWER_SECONDS = 0.5;

/** The table these tests write to; created here, never part of the schema. */
const PROBE_TABLE = "request_transaction_boundary_probe";

/**
 * Two columns, one deferred unique constraint.
 *
 * `slot` exists only so a duplicate can be inserted without violating the primary
 * key, and the constraint on it is deferred so the violation surfaces at COMMIT.
 */
const PROBE_TABLE_DDL = `
  create table if not exists ${PROBE_TABLE} (
    token text primary key,
    slot text not null,
    constraint ${PROBE_TABLE}_slot_key unique (slot) deferrable initially deferred
  )
`;

/** This process's own database, or the error that stopped it from being created. */
const SUITE = await perRunDatabase(TEST_SERVER_URL).catch((error: unknown) =>
  error instanceof Error ? error : new Error(String(error)),
);

/** One identifiable row these tests insert. */
interface Probe {
  readonly token: string;
  readonly slot: string;
}

/**
 * Open two clients against `url` and prove both connect.
 *
 * Two, deliberately: the transaction runs on the first, and the assertion about
 * what a caller can see runs on the second. A row visible only through the client
 * that wrote it would prove nothing about commit ordering.
 *
 * @param url - Connection string of this process's own database.
 * @returns The pair of clients, or the reason one could not be opened.
 */
async function connect(url: string): Promise<{ error: string } | { pool: Sql; observer: Sql }> {
  const transactionPool = createClient(url, CONNECT_TIMEOUT_SECONDS);
  const observationClient = createClient(url, CONNECT_TIMEOUT_SECONDS);
  try {
    await transactionPool`select 1`;
    await observationClient`select 1`;
    return { pool: transactionPool, observer: observationClient };
  } catch (error) {
    await transactionPool.end({ timeout: 1 }).catch(() => undefined);
    await observationClient.end({ timeout: 1 }).catch(() => undefined);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The clients this file uses, or the observed reason there are none. */
const AVAILABILITY =
  SUITE instanceof Error
    ? { error: `could not create a per-run database (${SUITE.message})` }
    : await connect(SUITE.url);

/** The skip decision every test here is gated on. */
const skipReason: string | false =
  "pool" in AVAILABILITY
    ? false
    : noDatabase(
        "The request transaction boundary suite needs a Postgres database and none could be obtained.",
        `database unreachable at ${TEST_SERVER_URL}: ${AVAILABILITY.error}`,
      );

if (skipReason !== false) {
  console.warn(`[request-transaction-boundary.test] skipping integration tests — ${skipReason}`);
}

/** The pool the request transactions run on. */
function pool(): Sql {
  if (!("pool" in AVAILABILITY)) throw new Error("integration setup did not complete");
  return AVAILABILITY.pool;
}

/** The SECOND, independent connection every visibility assertion reads through. */
function observer(): Sql {
  if (!("pool" in AVAILABILITY)) throw new Error("integration setup did not complete");
  return AVAILABILITY.observer;
}

/** A sequence so two probes minted in the same millisecond cannot collide. */
let sequence = 0;

/** One uniquely identifiable probe row, in its own `slot`. */
function uniqueProbe(label: string): Probe {
  sequence += 1;
  const token = `probe-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  return { token, slot: token };
}

/** Read `probe` out of the request body, as the probe routes receive it. */
function probeFromRequest(req: Request): Probe {
  const body: Partial<Probe> = req.body ?? {};
  return { token: String(body.token), slot: String(body.slot) };
}

/** Insert one probe row through the caller's transaction. */
async function insertProbe(tx: Database, probe: Probe): Promise<void> {
  await tx.execute(
    sql`insert into ${sql.raw(PROBE_TABLE)} (token, slot) values (${probe.token}, ${probe.slot})`,
  );
}

/**
 * The tokens an INDEPENDENT connection can see right now.
 *
 * Deliberately not routed through the transaction's pool: this is the caller's
 * view after the answer, which is the whole property.
 */
async function visibleTokens(token: string): Promise<string[]> {
  const rows = await observer().unsafe<{ token: string }[]>(
    `select token from ${PROBE_TABLE} where token = $1 order by token`,
    [token],
  );
  return rows.map((row) => row.token);
}

/** Answers `201`, then keeps the transaction open past the answer. */
const respondThenStall: TransactionalHandler = async (req, res, tx) => {
  await insertProbe(tx, probeFromRequest(req));
  res.status(201).json({ ok: true });
  await tx.execute(sql`select pg_sleep(${STALL_AFTER_ANSWER_SECONDS})`);
};

/** Answers `201`, having queued a duplicate that only COMMIT will reject. */
const failAtCommit: TransactionalHandler = async (req, res, tx) => {
  const probe = probeFromRequest(req);
  await insertProbe(tx, probe);
  await insertProbe(tx, { token: `${probe.token}-duplicate`, slot: probe.slot });
  res.status(201).json({ ok: true });
};

/** Writes, then throws before answering, so the wrapper must roll back. */
const throwBeforeAnswering: TransactionalHandler = async (req, _res, tx) => {
  await insertProbe(tx, probeFromRequest(req));
  throw new Error("probe handler failed on purpose");
};

/**
 * `handleError`'s 5xx branch, reproduced because `server.ts` does not export it.
 *
 * A non-5xx status keeps the live JSON `detail` shape; nothing here produces one,
 * and diverging from the live handler would make the error assertions meaningless.
 */
function answerLikeTheServer(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const declared = typeof err === "object" && err !== null && "status" in err ? err.status : 500;
  const status = typeof declared === "number" ? declared : 500;
  if (status >= 500) {
    res.status(status).type("text/plain").send("Internal Server Error");
    return;
  }
  const detail = err instanceof Error && err.message !== "" ? err.message : "Bad Request";
  res.status(status).json({ detail });
}

/** An app that serves the three probe handlers through the REAL wrapper. */
function buildProbeApp(): Express {
  const wrap = createRequestTransactionWrapper(createDatabase(pool()));
  const app = express();
  app.use(express.json({ strict: false }));
  app.post("/probe/respond-then-stall", wrap(respondThenStall));
  app.post("/probe/fail-at-commit", wrap(failAtCommit));
  app.post("/probe/throw-before-answering", wrap(throwBeforeAnswering));
  app.use(answerLikeTheServer);
  return app;
}

describe.skipIf(skipReason !== false)("request transaction boundary (live database)", () => {
  beforeAll(async () => {
    await pool().unsafe(PROBE_TABLE_DDL);
  });

  afterAll(async () => {
    await pool().unsafe(`delete from ${PROBE_TABLE}`).catch(() => undefined);
    await pool().end({ timeout: 5 }).catch(() => undefined);
    await observer().end({ timeout: 5 }).catch(() => undefined);
  });

  it("commits before the client that received 201 can observe the row", async () => {
    const probe = uniqueProbe("commit-before-answer");

    const answer = await request(buildProbeApp())
      .post("/probe/respond-then-stall")
      .send(probe);

    // The handler's own success is not in question: the wrapper lets it through.
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ ok: true });

    // The client holds its answer NOW. An independent connection must see the row.
    expect(await visibleTokens(probe.token)).toEqual([probe.token]);
  });

  it("answers a failed COMMIT with the server's error, not the handler's success", async () => {
    const probe = uniqueProbe("commit-fails");

    const answer = await request(buildProbeApp())
      .post("/probe/fail-at-commit")
      .send(probe);

    expect(answer.status).toBe(500);
    expect(answer.type).toBe("text/plain");
    expect(answer.text).toBe("Internal Server Error");
    expect(await visibleTokens(probe.token)).toEqual([]);
  });

  it("rolls back a handler that throws and keeps today's error shape", async () => {
    const probe = uniqueProbe("handler-throws");

    const answer = await request(buildProbeApp())
      .post("/probe/throw-before-answering")
      .send(probe);

    expect(answer.status).toBe(500);
    expect(answer.type).toBe("text/plain");
    expect(answer.text).toBe("Internal Server Error");
    expect(await visibleTokens(probe.token)).toEqual([]);
  });
});
