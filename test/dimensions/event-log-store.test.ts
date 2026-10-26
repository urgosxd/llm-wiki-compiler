/**
 * @file test/dimensions/event-log-store.test.ts
 * @description The hash-chained event log over rows.
 *
 * The property that matters is not "events round-trip". It is that the chain stays
 * TAMPER-EVIDENT without the file's line order, and that concurrent appenders cannot
 * fork it — the two things moving from a file to a table could quietly lose.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEventRow, readEventLog } from "../../src/dimensions/wiki/event-log-store.js";
import { eventPrevHash } from "../../src/events/event-digest.js";
import { GENESIS_PREV_HASH } from "../../src/events/types.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { createProbeStack } from "./harness-lifecycle.js";

let harness: KgPostgresHarness;

beforeEach(async () => {
  harness = (await createProbeStack("evt")).harness;
});

afterEach(async () => {
  await harness.cleanup();
});

/** Append one event of a given type, with a distinguishing payload. */
async function append(type: string): Promise<void> {
  await appendEventRow(harness.db, harness.stackId, {
    type: type as never, origin: "test", payload: { marker: type },
  });
}

describe("event log as rows", () => {
  it("starts empty, with no genesis anchor written", async () => {
    expect(await readEventLog(harness.db, harness.stackId)).toEqual([]);
  });

  it("chains each record to the previous one's CHAIN DIGEST", async () => {
    await append("a");
    await append("b");
    await append("c");

    const log = await readEventLog(harness.db, harness.stackId);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log[0]?.prevHash).toBe(GENESIS_PREV_HASH);
    // The link is `eventPrevHash` of the previous record's CONTENT, which is exactly
    // what `verifyEventChain` recomputes and what the file backend writes. It is NOT
    // the stored `checksum`: the checksum also covers `prevHash`, so chaining on it
    // produces links no verifier can reproduce.
    expect(log[1]?.prevHash).toBe(eventPrevHash(log[0]!));
    expect(log[2]?.prevHash).toBe(eventPrevHash(log[1]!));
  });

  it("gives every record its own checksum", async () => {
    await append("same");
    await append("same");

    const log = await readEventLog(harness.db, harness.stackId);
    // Identical content still differs, because `prevHash` and `id` differ.
    expect(log[0]?.checksum).not.toBe(log[1]?.checksum);
  });

  it("detects a tampered payload by breaking the checksum", async () => {
    await append("a");
    await append("b");

    // Rewrite the first record's payload behind the store's back — the exact attack
    // a hash chain exists to make visible.
    await harness.db.execute(sql`
      update wiki.event_log set payload = '{"marker":"forged"}'::jsonb
      where stack_id = ${harness.stackId} and seq = 1
    `);

    const log = await readEventLog(harness.db, harness.stackId);
    // The stored checksum no longer describes the row, and the NEXT record's link
    // points at a digest that no longer matches either.
    const { eventChecksum } = await import("../../src/events/store-record.js");
    const recomputed = eventChecksum({
      id: log[0]!.id, type: log[0]!.type, origin: log[0]!.origin,
      payload: log[0]!.payload, at: log[0]!.at, prevHash: log[0]!.prevHash,
    });
    expect(recomputed).not.toBe(log[0]?.checksum);
  });

  it("serializes concurrent appends so the chain cannot fork", async () => {
    // Two appends racing is what a file store gets wrong on two hosts: each reads
    // the same tail and both write the same `prevHash`.
    await Promise.all([append("x"), append("y"), append("z")]);

    const log = await readEventLog(harness.db, harness.stackId);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (let i = 1; i < log.length; i += 1) {
      expect(log[i]?.prevHash).toBe(eventPrevHash(log[i - 1]!));
    }
  });
});
