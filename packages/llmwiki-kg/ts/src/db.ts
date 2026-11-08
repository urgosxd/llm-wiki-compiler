import type { NextFunction, Request, RequestHandler, Response } from "express";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Sql } from "postgres";

import { config } from "./config.js";
import {
  TIMESTAMPTZ_OID,
  TIMESTAMP_OID,
  timestamptzType,
} from "./db-timestamp.js";
import { ResponseRecorder } from "./request-transaction-response.js";
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
 * This module never turns a `timestamptz` into a `Date`: the driver is
 * configured so OIDs 1184/1114 arrive as the raw text Postgres sent, and the
 * microsecond digits survive end to end. That parser and its rationale live in
 * `./db-timestamp.ts`, which this file only wires up — `createClient` registers
 * it and `createDatabase` re-installs it after drizzle overwrites it — and whose
 * `normalizeTimestamptz` is re-exported here. Background:
 * `odd/findings/timestamp-precision.md`.
 */

/**
 * Re-exported so the timestamp contract still arrives through this module and
 * every existing `./db.js` import path keeps working unchanged. The
 * implementation and its full rationale live in `./db-timestamp.ts`.
 */
export { normalizeTimestamptz } from "./db-timestamp.js";

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
 * unambiguous. The parser in `./db-timestamp.ts` depends on both.
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
 * Process-wide pool and drizzle handle, built on FIRST USE.
 *
 * NOTHING HERE MAY RUN AT IMPORT TIME. `config.DATABASE_URL` is itself resolved
 * lazily (see `config.ts`), and importing this module happens while llmwiki's
 * module graph is still being evaluated — before the project `.env` exists in
 * `process.env`. Reading the DSN here would snapshot the environment one step
 * too early. Importing still connects nothing: the pool is created by the first
 * caller that needs it, exactly as Python reads the DSN once at its own startup.
 */
let resolvedClient: Sql | undefined;

/** The process-wide pool, created on first use. */
function getClient(): Sql {
  resolvedClient ??= createClient(config.DATABASE_URL);
  return resolvedClient;
}

/** The process-wide drizzle handle, created on first use. */
let resolvedDatabase: Database | undefined;

function getDatabase(): Database {
  resolvedDatabase ??= createDatabase(getClient());
  return resolvedDatabase;
}

/**
 * A stand-in for a value that must not be built while this module is imported.
 *
 * Forwarding rather than a plain accessor keeps the exported names usable
 * exactly as before: `client` still works as a tagged template (`client\`…\``),
 * `db` still works as a drizzle handle, and neither builds anything until it is
 * used. The builder runs at most once, because {@link getClient} and
 * {@link getDatabase} memoize their result.
 *
 * @param build - Produces the real value the first time it is needed.
 * @returns A proxy that behaves like that value.
 */
function lazyValue<T extends object>(build: () => T): T {
  return new Proxy(function lazyPlaceholder() {} as unknown as T, {
    apply: (_target, thisArg, args: unknown[]) =>
      Reflect.apply(build() as unknown as (...a: unknown[]) => unknown, thisArg, args),
    get: (_target, property) => {
      const value = build();
      return Reflect.get(value as object, property, value);
    },
    has: (_target, property) => Reflect.has(build() as object, property),
    ownKeys: () => Reflect.ownKeys(build() as object),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(build() as object, property),
  });
}

/** Process-wide pool, resolved on first use. */
export const client: Sql = lazyValue(getClient);

/** Process-wide drizzle handle, resolved on first use. */
export const db: Database = lazyValue(getDatabase);

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
 *
 * The pool is created on the first call, not when this module is imported.
 */
export const withTransaction: TransactionRunner = (fn) =>
  createTransactionRunner(getDatabase())(fn);

/** An Express handler that receives its request-scoped transaction. */
export type TransactionalHandler = (
  req: Request,
  res: Response,
  tx: Database,
) => Promise<void>;

/**
 * Wraps a route handler so it runs inside one transaction, and so the client
 * receives nothing until that transaction has COMMITTED.
 *
 * ## Contract, deliberately a behaviour change
 *
 * - handler resolves -> COMMIT, then replay: COMMIT lands BEFORE the answer.
 * - handler throws -> ROLLBACK, then the error reaches Express unchanged
 *   (`raise` after `rollback()`), with the same shape as before.
 * - handler answers and THEN throws -> nothing commits; the client gets that
 *   error instead of a stale success.
 * - COMMIT fails -> nothing is replayed; the error is forwarded, so `handleError`
 *   answers 500 `text/plain` `Internal Server Error`. A caller that used to get a
 *   success for a rolled-back write now gets an error: the point of this change.
 * - On the two endpoints that hold their transaction across a provider call
 *   (`POST /aks/v1/context`, `POST /stacks/:stackId/synthesize-descriptions`), the
 *   client now waits for a COMMIT that follows that call: the boundary move makes the
 *   cost of S44 felt, not created.
 * - either way -> the connection returns to the pool, even on client abort.
 *
 * ## Why record instead of flushing
 *
 * A handler cannot know its final status before the COMMIT, so it cannot flush -- flushing
 * puts the answer ahead of it. It gets a {@link ResponseRecorder} typed as `Response` that
 * captures every call and replays it after the transaction resolves, so the body comes from
 * the same Express path, only ordered after the COMMIT. `finish`/`close` fire after it.
 *
 * ## Why a route wrapper and not `app.use` middleware
 *
 * Express 5 `next()` returns `void`, so a transaction-owning *middleware* cannot observe
 * a downstream rejection -- it sees the chain resolve while the handler's promise is
 * pending. Verified: with `app.use`, an experimental run saw a resolved chain even though
 * the handler threw and Express answered 500, so it would COMMIT a failed transaction.
 * `res.statusCode` is no substitute either: write-then-404 must still COMMIT. Only
 * awaiting the handler observes the real outcome, hence this wrapper.
 */
export function createRequestTransactionWrapper(
  database: Database,
): (handler: TransactionalHandler) => RequestHandler {
  return (handler: TransactionalHandler): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const recorder = new ResponseRecorder(res);
      const recorded: Response = recorder.response;
      void database
        .transaction(async (tx) => handler(req, recorded, tx))
        .then(() => recorder.replay())
        .catch((error: unknown) => {
          // Nothing replayed on failure: a response `next` already sent stands.
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
 *
 * Bound through the lazy handle, so mounting routes never builds the pool.
 */
export const withRequestTransaction: (
  handler: TransactionalHandler,
) => RequestHandler = (handler) => createRequestTransactionWrapper(getDatabase())(handler);

/**
 * Closes the pool. Call once on shutdown, after the HTTP server has stopped.
 *
 * A bounded `timeout` is passed so a wedged connection cannot hang the process
 * forever; postgres-js waits for in-flight queries up to that limit. A pool that
 * was never needed is not created just to be closed.
 */
export async function closeDatabase(timeoutSeconds = 5): Promise<void> {
  await resolvedClient?.end({ timeout: timeoutSeconds });
}

/**
 * Liveness probe for the database, used by tests and by startup checks.
 *
 * Returns `false` rather than throwing, so callers can decide whether an
 * unreachable database is fatal (startup) or merely a skip condition (tests).
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await getClient()`select 1`;
    return true;
  } catch {
    return false;
  }
}
