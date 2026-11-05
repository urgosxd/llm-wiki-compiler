/**
 * @file test/fixtures/per-run-database.test.ts
 * @description Pins the isolation contract of the per-run database fixture.
 *
 * ## What this suite is about
 *
 * `packages/llmwiki-kg/ts/src/db.test.ts:413` failed intermittently under parallel
 * load with `expected +0 to be 1`, and was green 15/15 isolated. The mechanism was
 * never assertion flakiness: `afterAll` ran
 * `delete from stacks where domain like 't04-route-%'` against a database every suite
 * shared, so a parallel worker's rows disappeared mid-run and a teardown looked like
 * a vanishing Stack.
 *
 * The fixture under test gives each caller its own database so that class cannot
 * happen. These cases assert exactly that, and nothing about the fixture's internals:
 * every observation is a connection string, a row count, or a catalog query against
 * the real server.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "llmwiki-kg";
import { afterAll, describe, expect, it } from "vitest";

import { firstJsonReport } from "./child-report.js";
import {
  PER_RUN_DATABASE_PREFIX,
  createSuiteDatabase,
  isPerRunDatabaseName,
  listPerRunDatabases,
  perRunDatabase,
  reapStalePerRunDatabases,
} from "./per-run-database.js";
import type { SuiteDatabase } from "./per-run-database.js";

/** Tables the KG suites cannot run without, listed independently of the fixture. */
const REQUIRED_TABLES = [
  "public.stacks",
  "public.stack_documents",
  "public.document_chunks",
  "public.ontology_entities",
  "public.ontology_relationships",
  "public.entity_source_documents",
  "public.entity_pages",
  "wiki.pages",
  "wiki.source_documents",
];

/** This file's own suite database; the scratch ones below are dropped in teardown. */
const own = await perRunDatabase();
const created: SuiteDatabase[] = [];

afterAll(async () => {
  await Promise.all(created.splice(0).map((suite) => suite.drop()));
  for (const name of external.splice(0)) await dropForeign(name);
});

/** The `Sql` handle `createClient` returns, named without reaching into the driver. */
type Client = ReturnType<typeof createClient>;

/** Open a client, run `work`, always close it. */
async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient(url, 10);
  try {
    return await work(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Write one `stacks` row into the database at `url`. */
async function insertStack(url: string, domain: string): Promise<void> {
  await withClient(url, async (client) => {
    await client`insert into stacks (id, name, domain)
      values (${randomUUID()}, 'Per-run probe', ${domain})`;
  });
}

/** How many `stacks` rows carry `domain` in the database at `url`. */
async function countDomain(url: string, domain: string): Promise<number> {
  return withClient(url, async (client) => {
    const rows = await client<{ total: number }[]>`
      select count(*)::int as total from stacks where domain = ${domain}
    `;
    return rows[0]?.total ?? -1;
  });
}

/** The `schema.table` names of every table the database at `url` exposes. */
async function tablesIn(url: string): Promise<Set<string>> {
  return withClient(url, async (client) => {
    const rows = await client<{ name: string }[]>`
      select table_schema || '.' || table_name as name
      from information_schema.tables where table_schema in ('public', 'wiki')
    `;
    return new Set(rows.map((row) => row.name));
  });
}

/** Create a suite database and remember it, so teardown cannot leak it. */
async function scratchDatabase(label: string): Promise<SuiteDatabase> {
  const suite = await createSuiteDatabase(label);
  created.push(suite);
  return suite;
}

/** Databases this file creates under names the fixture did not mint; dropped in teardown. */
const external: string[] = [];

/** Run `work` against the server's always-present `postgres` database. */
async function withAdminClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(own.url);
  url.pathname = "/postgres";
  return withClient(url.toString(), work);
}

/** Create a database under a name the fixture did not mint, and remember it for teardown. */
async function createForeignDatabase(name: string): Promise<string> {
  await withAdminClient((client) => client.unsafe(`create database "${name}"`));
  external.push(name);
  return name;
}

/** Does a database with exactly this name exist on the server? */
async function databaseExists(name: string): Promise<boolean> {
  return withAdminClient(async (client) => {
    const rows = await client<{ total: number }[]>`
      select count(*)::int as total from pg_database where datname = ${name}
    `;
    return (rows[0]?.total ?? 0) === 1;
  });
}

/** Drop a database this file created outside the fixture's mint, if it is still there. */
async function dropForeign(name: string): Promise<void> {
  // Not `drop database if exists`: the reaper may already have taken a stale one, and
  // the driver prints that NOTICE as an object into the transcript, where it buries
  // whatever a genuinely failing test had to say.
  if (!(await databaseExists(name))) return;
  await withAdminClient((client) => client.unsafe(`drop database if exists "${name}" with (force)`));
}

describe("per-run database isolation", () => {
  it("gives two independent callers different databases", async () => {
    const first = await scratchDatabase("isolation-a");
    const second = await scratchDatabase("isolation-b");

    expect(first.name).not.toBe(second.name);
    expect(first.url).not.toBe(second.url);
    expect(isPerRunDatabaseName(first.name)).toBe(true);
    expect(first.name.startsWith(PER_RUN_DATABASE_PREFIX)).toBe(true);
    // The URL must point AT that database, not merely carry its name.
    expect(new URL(first.url).pathname).toBe(`/${first.name}`);
  });

  it("keeps a row written by one caller invisible to another", async () => {
    const first = await scratchDatabase("isolation-write");
    const second = await scratchDatabase("isolation-read");
    const domain = `per-run-${randomUUID().slice(0, 8)}`;

    await insertStack(first.url, domain);

    expect(await countDomain(first.url, domain)).toBe(1);
    expect(await countDomain(second.url, domain)).toBe(0);
  });

  it("leaves the surviving caller's rows and counts intact when another is torn down", async () => {
    // The exact shape of `db.test.ts:413`: a teardown removes rows from a shared
    // database and an unrelated suite's count drops from 1 to 0.
    const doomed = await scratchDatabase("isolation-doomed");
    const survivor = await scratchDatabase("isolation-survivor");
    const doomedDomain = `per-run-doomed-${randomUUID().slice(0, 8)}`;
    const survivorDomain = `per-run-survivor-${randomUUID().slice(0, 8)}`;

    await insertStack(doomed.url, doomedDomain);
    await insertStack(survivor.url, survivorDomain);
    expect(await countDomain(survivor.url, survivorDomain)).toBe(1);

    await doomed.drop();

    expect(await listPerRunDatabases()).not.toContain(doomed.name);
    expect(await countDomain(survivor.url, survivorDomain)).toBe(1);
    expect(await countDomain(survivor.url, doomedDomain)).toBe(0);
  });

  it("provisions every table the KG suites need", async () => {
    const suite = await scratchDatabase("isolation-schema");
    const present = await tablesIn(suite.url);

    for (const table of REQUIRED_TABLES) {
      expect(present.has(table)).toBe(true);
    }
  });

  it("gives a second, concurrent process its own database", async () => {
    const child = runChildSuiteDatabase();

    expect(child.name).not.toBe(own.name);
    expect(isPerRunDatabaseName(child.name)).toBe(true);
    expect(child.url).not.toBe(own.url);
    expect(child.pid).not.toBe(process.pid);
  });

  it("removes the database of a finished process, leaving no debris", async () => {
    const child = runChildSuiteDatabase();

    expect(await listPerRunDatabases()).not.toContain(child.name);
  });

  it("leaves a live sibling created by another process intact through a reap", async () => {
    // The reaper is age-based for exactly this reason: dropping every sibling on sight
    // would delete a LIVE parallel worker's database. This sibling belongs to a different
    // process, was created seconds ago, and is still running when the reap happens.
    const sibling = await startLiveSibling();
    const domain = `per-run-live-${randomUUID().slice(0, 8)}`;
    try {
      await insertStack(sibling.url, domain);
      const reaped = await reapStalePerRunDatabases();

      expect(reaped).not.toContain(sibling.name);
      expect(await listPerRunDatabases()).toContain(sibling.name);
      expect(await databaseExists(sibling.name)).toBe(true);
      expect(await countDomain(sibling.url, domain)).toBe(1);
    } finally {
      await sibling.stop();
    }
  }, 180_000);

  it("never treats a database outside its naming pattern as a reaper candidate", async () => {
    // The lookalike carries the prefix AND a 45-minute-old stamp in its name, so a reaper
    // that classified by prefix and age alone would drop it. It survives because the name
    // pattern is the gate: a name the fixture did not mint is never a candidate.
    const oldStamp = (Date.now() - 45 * 60_000).toString(36);
    const lookalike = await createForeignDatabase(`llmwiki_suite_${oldStamp}_not-a-run-token`);
    const foreign = await createForeignDatabase(`llmwiki_probe_shared_${randomUUID().slice(0, 8)}`);
    expect(isPerRunDatabaseName(lookalike)).toBe(false);

    const reaped = await reapStalePerRunDatabases();

    expect(reaped).not.toContain(lookalike);
    expect(reaped).not.toContain(foreign);
    expect(await databaseExists(lookalike)).toBe(true);
    expect(await databaseExists(foreign)).toBe(true);
  }, 120_000);

  it("still reaps a stale run token, so the safety above is not a no-op", async () => {
    // Without this, a reaper that never reaps anything would pass both cases above.
    // The name is minted with an old stamp but no process is behind it, which is exactly
    // the debris the reaper exists for. Every other per-run database on the server was
    // created seconds ago, so nothing live is stale at this clock.
    const oldStamp = (Date.now() - 45 * 60_000).toString(36);
    const debris = `llmwiki_suite_${oldStamp}_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    expect(isPerRunDatabaseName(debris)).toBe(true);
    await createForeignDatabase(debris);

    const reaped = await reapStalePerRunDatabases();

    expect(reaped).toContain(debris);
    expect(await databaseExists(debris)).toBe(false);
  }, 120_000);
});

/** What the spawned process reports about the database it provisioned for itself. */
interface ChildReport {
  readonly name: string;
  readonly url: string;
  readonly pid: number;
}

/** The program the child runs: provision a suite database, report it, exit. */
const CHILD_SOURCE = [
  'import { perRunDatabase } from "__FIXTURE__";',
  "const suite = await perRunDatabase();",
  "console.log(JSON.stringify({ name: suite.name, url: suite.url, pid: process.pid }));",
].join("\n");

/** A live sibling: a separate process holding its own database open while we reap. */
interface LiveSibling {
  readonly name: string;
  readonly url: string;
  readonly pid: number;
  /** Signal the sibling; its own exit hook drops its database. */
  stop(): Promise<void>;
}

/** The program a live sibling runs: provision a database, report it, then hold it open. */
const LIVE_SIBLING_SOURCE = [
  'import { perRunDatabase } from "__FIXTURE__";',
  "const suite = await perRunDatabase();",
  'console.log(JSON.stringify({ name: suite.name, url: suite.url, pid: process.pid }));',
  "setInterval(() => undefined, 1_000);",
].join("\n");

/** Interpreter and fixture path every spawned suite database runs with. */
function childPaths(): { tsx: string; fixture: string } {
  return {
    tsx: fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
    fixture: fileURLToPath(new URL("./per-run-database.ts", import.meta.url)),
  };
}

/**
 * Start a real `node` process that provisions a suite database and KEEPS RUNNING.
 *
 * `spawn`, not `spawnSync`: the sibling must still be alive at the moment this
 * process reaps, which is the entire point of the case.
 */
async function startLiveSibling(): Promise<LiveSibling> {
  const { tsx, fixture } = childPaths();
  const directory = mkdtempSync(path.join(tmpdir(), "per-run-live-"));
  const script = path.join(directory, "live.mts");
  writeFileSync(script, LIVE_SIBLING_SOURCE.replace("__FIXTURE__", fixture));
  const child = spawn(tsx, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const report = await firstJsonReport<ChildReport>(child, "sibling");
  return { ...report, stop: () => stopChild(child, directory) };
}

/** Signal the sibling, wait for it to go, and remove its script directory. */
async function stopChild(child: ChildProcess, directory: string): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
  rmSync(directory, { recursive: true, force: true });
}

/**
 * Spawn a real `node` process that provisions its own suite database and prints it.
 *
 * A second PROCESS, not a second call: the fixture memoises per process, so only a
 * separate process can show that two suites running at once never share a database.
 * The child drops its database from its own exit hook, which is what the debris case
 * observes.
 */
function runChildSuiteDatabase(): ChildReport {
  const { tsx, fixture } = childPaths();
  const directory = mkdtempSync(path.join(tmpdir(), "per-run-child-"));
  try {
    const script = path.join(directory, "child.mts");
    writeFileSync(script, CHILD_SOURCE.replace("__FIXTURE__", fixture));
    const result = spawnSync(tsx, [script], { encoding: "utf-8", timeout: 120_000 });
    const last = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
    if (last === undefined) {
      throw new Error(`child reported no database (status ${String(result.status)}): ${result.stderr ?? ""}`);
    }
    return JSON.parse(last) as ChildReport;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
