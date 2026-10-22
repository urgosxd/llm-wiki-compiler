import type { NextFunction, Request, RequestHandler, Response } from "express";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresType, Sql } from "postgres";

import { config } from "./config.js";
import * as schema from "./schema.js";

/**
 * Database access.
 *
 * TypeScript counterpart of `app/core/database.py`. The Python module hands
 * every request its own psycopg2 connection, commits on success, rolls back on
 * exception, and closes the connection in a `finally`.
 *
 * ## Deliberate divergence: a pool, not a connection per request
 *
 * The Python oracle opens a fresh TCP connection per request. That is strictly
 * worse than pooling — every request pays a handshake — and postgres-js pools
 * by default, so this port keeps the pool.
 *
 * What is preserved is the *transaction* semantics, which is the part that is
 * actually contractual: each request runs inside its own transaction, commits
 * when the handler succeeds, rolls back when it throws, and always releases its
 * connection back to the pool. {@link withTransaction} and
 * {@link transactionMiddleware} reproduce that, including connection release on
 * a thrown handler and on a client abort.
 *
 * ## Timestamps are carried as strings
 *
 * See `odd/findings/timestamp-precision.md`. Postgres `timestamptz` carries
 * microsecond precision; `Date.prototype.toISOString()` emits exactly three
 * fractional digits. Round-tripping through `Date` therefore destroys the last
 * three digits and mismatches the oracle on roughly 999 of every 1000 rows.
 *
 * The driver is therefore configured so OID 1184/1114 are never turned into
 * `Date` objects, and the raw microsecond text survives end to end. See
 * {@link normalizeTimestamptz} for the one transform applied to it.
 */

/**
 * OIDs of the temporal types whose text form we control.
 *
 * - 1184 `timestamptz`
 * - 1114 `timestamp`
 * - 1083 `time`   (present only to keep drizzle's own identity patch aligned)
 * - 1186 `interval` is deliberately NOT listed: it has no timestamp precision.
 */
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;

/**
 * Matches Postgres' `DateStyle = ISO, MDY` text output, e.g.
 * `2026-10-21 03:16:59.138144+00`. Fractional seconds and the zone offset are
 * both optional because Postgres trims trailing zeros: `.100000` arrives as
 * `.1` and `.000000` arrives with no fraction at all.
 */
const PG_TIMESTAMP_TEXT_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:([+-]\d{2})(?::?(\d{2}))?|Z)?$/;

/**
 * Rewrites Postgres' text timestamp into the exact form the Python oracle
 * emits, without ever constructing a `Date` from the value.
 *
 * Observed raw wire text (postgres-js, `TimeZone=UTC`):
 *   `2026-10-21 03:28:09.262117+00`
 *
 * Observed oracle output (FastAPI + Pydantic, `GET /stacks`):
 *   `2026-10-21T03:28:09.262117Z`
 *
 * The two differ in three ways — `T` vs space separator, `Z` vs `+00` suffix,
 * and Postgres' trailing-zero trimming vs Pydantic's fixed six digits. Naive
 * pass-through would satisfy "microseconds survive" but fail the response
 * contract, so the text is normalized here while it is still a string.
 *
 * This is *not* the anti-pattern the finding warns about. That warning is about
 * formatting a `Date` after precision is already lost. Here the microsecond
 * digits are carried as characters the whole way; nothing is parsed into a
 * millisecond-resolution type at any point.
 *
 * Non-UTC offsets are converted by applying the offset to the wall clock and
 * keeping the (already microsecond-precise) fractional digits verbatim. The
 * connection pins `TimeZone=UTC`, so this branch is a defensive path that
 * should never fire in practice.
 *
 * @throws {TypeError} if `raw` is not a timestamp string in the expected shape.
 *   Failing loudly is intentional: a silent fallback here would reintroduce the
 *   precision bug this module exists to prevent.
 */
export function normalizeTimestamptz(raw: string): string {
  const match = PG_TIMESTAMP_TEXT_RE.exec(raw);
  if (match === null) {
    throw new TypeError(
      `Unrecognized Postgres timestamp text: ${JSON.stringify(raw)}`,
    );
  }

  const [, date, time, fraction, offsetHours, offsetMinutes] = match;

  // `date` and `time` are present whenever the regex matched, but
  // noUncheckedIndexedAccess types them as optional, so narrow explicitly.
  if (date === undefined || time === undefined) {
    throw new TypeError(
      `Unrecognized Postgres timestamp text: ${JSON.stringify(raw)}`,
    );
  }

  // Postgres trimmed trailing zeros; Pydantic always emits six digits.
  const microseconds = (fraction ?? "").padEnd(6, "0");

  const isUtc =
    offsetHours === undefined ||
    offsetHours === "+00" ||
    offsetHours === "-00";

  if (isUtc) {
    return `${date}T${time}.${microseconds}Z`;
  }

  // Defensive: shift a non-UTC wall clock into UTC. Integer offset arithmetic
  // only; the sub-second digits are never touched.
  const sign = offsetHours.startsWith("-") ? -1 : 1;
  const hours = Number.parseInt(offsetHours.slice(1), 10);
  const minutes =
    offsetMinutes === undefined ? 0 : Number.parseInt(offsetMinutes, 10);
  const shiftMs = sign * (hours * 60 + minutes) * 60_000;

  const shifted = new Date(
    Date.parse(`${date}T${time}Z`) - shiftMs,
  ).toISOString();

  return `${shifted.slice(0, 19)}.${microseconds}Z`;
}

/**
 * The `types` entry that makes postgres-js deliver temporals as normalized
 * strings.
 *
 * `serialize` is the identity function because every timestamp this app writes
 * is already an ISO-8601 string; postgres-js would otherwise wrap it in
 * `new Date(...)` and truncate it to milliseconds on the way *in*, which is the
 * same bug in the other direction.
 */
const timestamptzType: PostgresType<string> = {
  to: TIMESTAMPTZ_OID,
  from: [TIMESTAMPTZ_OID, TIMESTAMP_OID],
  serialize: (value: string): string => value,
  parse: (raw: unknown): string => normalizeTimestamptz(String(raw)),
};

/**
 * Builds a postgres-js client for `url`.
 *
 * The client is created eagerly but does not connect: postgres-js opens
 * connections lazily on first query. Importing this module therefore never
 * throws when Postgres is down, which keeps unit tests that never touch the DB
 * working without Docker.
 *
 * `TimeZone` is pinned to UTC so the text form is `+00` rather than a named
 * offset, and `DateStyle` is pinned to ISO so the date component is
 * unambiguous. {@link normalizeTimestamptz} depends on both.
 *
 * @param url Postgres connection string.
 * @param connectTimeoutSeconds Fail-fast bound for the initial handshake.
 *   Defaults to postgres-js's own default; tests pass a small value so an
 *   unreachable host does not stall the suite.
 */
export function createClient(
  url: string,
  connectTimeoutSeconds?: number,
): Sql {
  return postgres(url, {
    connection: { TimeZone: "UTC", DateStyle: "ISO, MDY" },
    types: { timestamptz: timestamptzType },
    ...(connectTimeoutSeconds === undefined
      ? {}
      : { connect_timeout: connectTimeoutSeconds }),
  });
}

/** Re-exported for callers that need the drizzle handle type by name. */
export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Builds the drizzle handle around `client` and re-installs the timestamp
 * parser.
 *
 * Why re-install: `drizzle(client)` unconditionally overwrites the driver's
 * parser for OID 1184 (and 1114, 1082, 1083, ...) with an identity parser,
 * discarding whatever the `types` option registered. Without this step the
 * `types` option would be silently ignored and a future maintainer would see
 * Date objects again. Verified against drizzle-orm 0.45.4.
 */
export function createDatabase(client: Sql): Database {
  const db = drizzle(client, { schema });
  client.options.parsers[TIMESTAMPTZ_OID] = timestamptzType.parse;
  client.options.parsers[TIMESTAMP_OID] = timestamptzType.parse;
  return db;
}

/**
 * Process-wide pool and drizzle handle.
 *
 * Importing this module must not connect, so neither of these touches the
 * network. `config.DATABASE_URL` is read here for the same reason Python reads
 * it once in `app/core/config.py`.
 */
export const client: Sql = createClient(config.DATABASE_URL);

export const db: Database = createDatabase(client);

/** Signature of a transaction runner bound to one database handle. */
export type TransactionRunner = <T>(
  fn: (tx: Database) => Promise<T>,
) => Promise<T>;

/**
 * Binds the transaction contract to a specific database handle.
 *
 * Reproduces the Python dependency's commit/rollback/release semantics:
 *
 * - `fn` resolves → COMMIT, and its value is returned.
 * - `fn` throws   → ROLLBACK, and the error propagates unchanged.
 * - either way    → the connection is released back to the pool.
 *
 * postgres-js's `begin()` already issues BEGIN/COMMIT/ROLLBACK and returns the
 * connection to the pool on every exit path, including a rejected callback, so
 * no connection leaks when a handler throws. Nested calls map to savepoints.
 *
 * Do not capture `db` inside `fn`; use the provided `tx`, or reads and writes
 * escape the transaction.
 *
 * Exposed as a factory rather than only as a module-level function so tests can
 * bind it to their own pool without mutating process-wide state.
 */
export function createTransactionRunner(database: Database): TransactionRunner {
  return async function run<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return database.transaction(async (tx) => fn(tx));
  };
}

/**
 * Runs `fn` inside a single transaction on the process-wide pool.
 * See {@link createTransactionRunner} for the exact guarantees.
 */
export const withTransaction: TransactionRunner = createTransactionRunner(db);

/** An Express handler that receives its request-scoped transaction. */
export type TransactionalHandler = (
  req: Request,
  res: Response,
  tx: Database,
) => Promise<void>;

/**
 * Wraps a route handler so it runs inside one transaction, reproducing the
 * Python `Depends(get_db)` commit/rollback/close contract exactly.
 *
 * - handler resolves -> COMMIT.
 * - handler throws   -> ROLLBACK, then the error is forwarded to Express's
 *   error handler unchanged (matching Python's `raise` after `rollback()`).
 * - either way       -> the connection is released back to the pool, including
 *   when the client aborts and makes the handler throw.
 *
 * Usage:
 *
 *   app.get("/stacks", withRequestTransaction(async (req, res, tx) => {
 *     const rows = await tx.select().from(stacks);
 *     res.json(rows);
 *   }));
 *
 * ## Why a route wrapper and not `app.use` middleware
 *
 * A transaction-owning *middleware* cannot be implemented correctly on
 * Express 5. `next()` returns `void`, so a middleware cannot observe a
 * downstream handler's rejection: the middleware's view of the chain resolves
 * as soon as `next()` returns, while the handler's promise is still pending.
 * Verified experimentally -- with `app.use` the middleware saw a resolved chain
 * even though the handler threw and Express answered 500. Such a middleware
 * would therefore COMMIT a transaction whose handler failed.
 *
 * Inferring the outcome from `res.statusCode` is not equivalent either: a
 * handler that writes and then deliberately returns 404 must still COMMIT, as
 * it would in Python, so a status-code heuristic would silently diverge.
 *
 * Awaiting the handler is the only form that observes the real outcome, so the
 * transaction is scoped by a wrapper the handler is passed through.
 */
export function createRequestTransactionWrapper(
  database: Database,
): (handler: TransactionalHandler) => RequestHandler {
  return (handler: TransactionalHandler): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
      void database
        .transaction(async (tx) => handler(req, res, tx))
        .catch((error: unknown) => {
          // A handler that already sent a response cannot be re-reported:
          // deferring to Express here would raise "headers already sent".
          if (res.headersSent) {
            return;
          }
          next(error);
        });
    };
  };
}

/**
 * Request-scoped transaction wrapper bound to the process-wide pool.
 * See {@link createRequestTransactionWrapper}.
 */
export const withRequestTransaction: (
  handler: TransactionalHandler,
) => RequestHandler = createRequestTransactionWrapper(db);

/**
 * Closes the pool. Call once on shutdown, after the HTTP server has stopped.
 *
 * A bounded `timeout` is passed so a wedged connection cannot hang the process
 * forever; postgres-js waits for in-flight queries up to that limit.
 */
export async function closeDatabase(timeoutSeconds = 5): Promise<void> {
  await client.end({ timeout: timeoutSeconds });
}

/**
 * Liveness probe for the database, used by tests and by startup checks.
 *
 * Returns `false` rather than throwing, so callers can decide whether an
 * unreachable database is fatal (startup) or merely a skip condition (tests).
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  }
}
