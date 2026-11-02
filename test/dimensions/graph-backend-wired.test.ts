/**
 * @file test/dimensions/graph-backend-wired.test.ts
 * @description With a Stack configured, the EVENT chain writes and reads ROWS.
 *
 * This file used to also prove that a relation recorded in rows while its event
 * went to a file would leave the audit trail describing a store nothing reads.
 * Relations were removed with the profile system, so that half is gone; the
 * event half is what survives and it is the half that matters most now.
 *
 * `migration_wiki_graph.sql` is the one file that carries `wiki.event_log`, and
 * it was edited when `relation_edges` came out. These tests are the reason that
 * edit has to stay honest: they assert that rows are written, that the chain
 * reads back intact, that tampering over rows is DETECTED, and that no
 * `wiki/graph/` directory appears — a file-backed store would create one.
 *
 * When this file was deleted along with the relation suite, the only remaining
 * coverage of `appendEventLocked` was timestamp fidelity via the FILE path. The
 * row backend, the "no `wiki/graph/` directory" property and row tamper
 * detection were uncovered. That gap is why this file is restored.
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEvents } from "../../src/events/store-read.js";
import { appendEventLocked } from "../../src/events/store.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

let harness: KgPostgresHarness;
let root: string;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`wired-${randomUUID().slice(0, 8)}`);
  root = await mkdtemp(path.join(os.tmpdir(), "graph-wired-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/** Environment naming this harness's Stack. */
function applyStackEnv(): void {
  process.env.AKS_STACK_ID = harness.stackId;
  process.env.AKS_DATABASE_URL = testDatabaseUrl();
}

/** Restore the environment so other suites are not affected. */
function clearStackEnv(): void {
  delete process.env.AKS_STACK_ID;
  delete process.env.AKS_DATABASE_URL;
}

/** True when the project has a `wiki/graph/` directory. */
async function hasGraphDir(): Promise<boolean> {
  const entries = await readdir(path.join(root, "wiki")).catch(() => [] as string[]);
  return entries.includes("graph");
}

/** Count the event rows this harness's Stack holds. */
async function countEventRows(): Promise<number> {
  const rows = await harness.db.execute<{ n: number }>(sql`
    select count(*)::int as n from wiki.event_log where stack_id = ${harness.stackId}
  `);
  return rows[0]?.n ?? 0;
}

describe("the event backend when a Stack is configured", () => {
  it("writes events to rows and creates no wiki/graph/ directory", async () => {
    applyStackEnv();
    try {
      await appendEventLocked(root, {
        type: "artifact-write" as never, origin: "test", payload: { marker: "x" },
      } as never);
    } finally {
      clearStackEnv();
    }

    expect(await countEventRows()).toBe(1);
    expect(await hasGraphDir()).toBe(false);
  });

  it("reads those events back with an intact chain", async () => {
    applyStackEnv();
    try {
      await appendEventLocked(root, { type: "a" as never, origin: "t", payload: {} } as never);
      await appendEventLocked(root, { type: "b" as never, origin: "t", payload: {} } as never);

      const { events, problems } = await readEvents(root);
      expect(events).toHaveLength(2);
      expect(problems).toEqual([]);
    } finally {
      clearStackEnv();
    }
  });

  it("reports a tampered row as a problem, not as a healthy chain", async () => {
    applyStackEnv();
    try {
      await appendEventLocked(root, { type: "a" as never, origin: "t", payload: { v: 1 } } as never);
      await harness.db.execute(sql`
        update wiki.event_log set payload = '{"v":2}'::jsonb
        where stack_id = ${harness.stackId}
      `);

      const { problems } = await readEvents(root);
      expect(problems.some((p) => p.includes("checksum mismatch"))).toBe(true);
    } finally {
      clearStackEnv();
    }
  });
});
