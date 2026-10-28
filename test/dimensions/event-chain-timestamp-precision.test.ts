/**
 * @file test/dimensions/event-chain-timestamp-precision.test.ts
 * @description A chained event must survive the round trip through Postgres intact.
 *
 * ## The defect this pins
 *
 * The event store is a HASH CHAIN: each record's `checksum` is computed over its
 * content, and the next record carries that checksum as `prevHash`. `verifyEventChain`
 * recomputes each digest and compares. So the `at` value that goes IN must be the
 * exact value that comes OUT — a single differing character breaks the link.
 *
 * `at` is an ISO-8601 string. Postgres stores it in a `timestamptz`, which keeps
 * MICROSECOND precision. Reading it back through a JS `Date` and calling
 * `toISOString()` truncates to MILLISECONDS:
 *
 * ```
 * in : 2026-10-26T17:49:11.123456Z
 * out: 2026-10-26T17:49:11.123Z      ← digest differs, chain "broken"
 * ```
 *
 * The chain is not actually tampered with; it is re-serialized. That distinction
 * matters because the failure surfaces as `chain link broken at event 1`, which reads
 * as corruption and sends you looking for a writer bug instead of a format one.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withProjectRoot, withStackEnv } from "../fixtures/stack-env.js";
import { appendEventLocked } from "../../src/events/store.js";
import { readEvents, verifyEventChain } from "../../src/events/store-read.js";

/** A timestamp with MICROSECOND precision, which is what Postgres preserves. */
const MICRO_AT = "2026-10-26T17:49:11.123456Z";

describe("event chain across a timestamp round trip", () => {
  it("round-trips a microsecond timestamp without changing it", () =>
    withProjectRoot("chain-precision", async (dir) => {
      await appendEventLocked(dir, {
        type: "page-create",
        origin: "compile",
        payload: { pageId: "concepts/a" },
        at: MICRO_AT,
      } as never);

      const { events } = await readEvents(dir);
      expect(events[0]?.at).toBe(MICRO_AT);
    }));

  it("keeps the chain verifiable when a timestamp has microseconds", () =>
    withProjectRoot("chain-verifies", async (dir) => {
      await appendEventLocked(dir, {
        type: "page-create",
        origin: "compile",
        payload: { pageId: "concepts/a" },
        at: MICRO_AT,
      } as never);
      await appendEventLocked(dir, {
        type: "page-create",
        origin: "compile",
        payload: { pageId: "concepts/b" },
        at: "2026-10-26T17:49:12.654321Z",
      } as never);

      const { events } = await readEvents(dir);
      expect(verifyEventChain(events)).toEqual({ ok: true });
    }));
});
