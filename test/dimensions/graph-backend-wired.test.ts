/**
 * @file test/dimensions/graph-backend-wired.test.ts
 * @description With a Stack configured, the graph stores write and read ROWS.
 *
 * The property that matters is that the two halves agree: a relation recorded in
 * rows while its event went to a file would leave the audit trail describing a store
 * nothing reads. So this asserts both, and asserts no `wiki/graph/` directory
 * appears — a file-backed store would create one.
 *
 * It also proves the chain still detects tampering over rows, using the SAME
 * `recordChecksum`/`eventPrevHash` the file path uses.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEvents } from "../../src/events/store-read.js";
import { appendEventLocked } from "../../src/events/store.js";
import { readRelations } from "../../src/relations/store-read.js";
import { appendRelationLocked } from "../../src/relations/store.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

const PROFILE = {
  relations: { SUPPLIES: { from: ["concepts"], to: ["concepts"], direction: "directed" } },
  entities: { concepts: {} },
} as unknown as ProfilePack;

let harness: KgPostgresHarness;
let root: string;

beforeEach(async () => {
  harness = await createKgPostgresHarness(`wired-${randomUUID().slice(0, 8)}`);
  root = await mkdtemp(path.join(os.tmpdir(), "graph-wired-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  // The profile loader reads a project file; a non-default profile is needed for
  // relation validation, so it is written here rather than mocked.
  await writeFile(
    path.join(root, ".llmwiki-probe-profile.json"),
    JSON.stringify(PROFILE),
    "utf-8",
  ).catch(() => undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await harness.cleanup();
});

/** Environment naming this harness's Stack. */
function applyStackEnv(): void {
  process.env.AKS_STACK_ID = harness.stackId;
  process.env.AKS_DATABASE_URL = process.env.LLMWIKI_TEST_DATABASE_URL ?? "";
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

describe("the graph backend when a Stack is configured", () => {
  it("writes events to rows and creates no wiki/graph/ directory", async () => {
    applyStackEnv();
    try {
      await appendEventLocked(root, {
        type: "artifact-write" as never, origin: "test", payload: { marker: "x" },
      } as never);
    } finally {
      clearStackEnv();
    }

    const rows = await harness.db.execute<{ n: number }>(sql`
      select count(*)::int as n from wiki.event_log where stack_id = ${harness.stackId}
    `);
    expect(rows[0]?.n).toBe(1);
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

  it("records a relation and its event in rows, both", async () => {
    applyStackEnv();
    try {
      await appendRelationLocked(root, PROFILE, {
        type: "SUPPLIES",
        from: "concepts/alpha" as never,
        to: "concepts/beta" as never,
        attributes: {},
      } as never);

      const relations = await readRelations(root);
      expect(relations.relations).toHaveLength(1);

      // The event moved with it: a relation whose audit event stayed in a file would
      // leave the trail describing a store nothing reads.
      const events = await harness.db.execute<{ n: number }>(sql`
        select count(*)::int as n from wiki.event_log where stack_id = ${harness.stackId}
      `);
      expect(events[0]?.n).toBe(1);
      expect(await hasGraphDir()).toBe(false);
    } finally {
      clearStackEnv();
    }
  });
});
