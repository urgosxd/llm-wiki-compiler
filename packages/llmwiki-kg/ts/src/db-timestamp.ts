/**
 * Postgres temporal text handling.
 *
 * The single place where this package decides how a `timestamp with time zone`
 * crosses the wire. Everything here exists to keep microsecond precision intact
 * from Postgres to the response body, which is a response-contract requirement
 * rather than a preference: see `odd/findings/timestamp-precision.md`.
 *
 * ## Why the driver is configured, not merely formatted
 *
 * Postgres `timestamptz` carries microsecond precision and
 * `Date.prototype.toISOString()` emits exactly three fractional digits, so
 * round-tripping a value through `Date` destroys the last three digits and
 * mismatches the oracle on roughly 999 of every 1000 rows. The driver is
 * therefore told never to build a `Date` for OIDs 1184/1114:
 * {@link timestamptzType} is registered as their parser, and the raw text is the
 * only representation that leaves this module.
 *
 * Drizzle re-registers its own identity parser for those OIDs when the handle is
 * built, which is why the caller has to re-install this parser afterwards. That
 * wiring is `createDatabase` in `./db.ts` and deliberately stays there.
 *
 * ## Contract with `./db.ts`
 *
 * `db.ts` imports {@link TIMESTAMPTZ_OID}, {@link TIMESTAMP_OID} and
 * {@link timestamptzType} to configure the client and to patch drizzle's
 * parsers, and re-exports {@link normalizeTimestamptz} so existing `./db.js`
 * import paths keep working unchanged.
 *
 * Nothing here runs at import time and nothing here touches a connection, so
 * importing this module is always safe, and it holds no state.
 */

import type { PostgresType } from "postgres";

/**
 * OIDs of the temporal types whose text form we control.
 *
 * - 1184 `timestamptz`
 * - 1114 `timestamp`
 * - 1083 `time`   (present only to keep drizzle's own identity patch aligned)
 * - 1186 `interval` is deliberately NOT listed: it has no timestamp precision.
 */
export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMP_OID = 1114;

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
export const timestamptzType: PostgresType<string> = {
  to: TIMESTAMPTZ_OID,
  from: [TIMESTAMPTZ_OID, TIMESTAMP_OID],
  serialize: (value: string): string => value,
  parse: (raw: unknown): string => normalizeTimestamptz(String(raw)),
};
