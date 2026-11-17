/**
 * @file test/fixtures/adopted-container-schema.test.ts
 * @description Pins the adoption gate: a container this run did not create serves this run only
 * when its default database carries the schema this repository declares.
 *
 * ## The measured defect this file is written against
 *
 * `containerBuilder()` in `testcontainers-postgres.ts` calls `.withReuse()`, so a container an
 * earlier run left behind is ADOPTED, and `prepareContainerDatabase` skipped the schema replay for
 * any database that already held the two sentinel tables. Measured on this machine: a seven-day-old
 * labelled container was adopted and served a whole gate run while its default database was missing
 * `wiki.embedding_store_meta.backend` and `wiki.embedding_store_meta.endpoint`, and while
 * `public.stacks` still carried a row from that earlier run.
 *
 * ## Why a real container, and why this suite owns it
 *
 * The comparison is only worth something against a real catalogue, so every case below runs against
 * a database on a container this file starts and removes itself. `startEphemeralPostgres` is used
 * rather than the shared fixture on purpose: it labels its container `llmwiki-probe=1`, so it is
 * never adopted by anything, and driving it cannot touch a container another session owns. The
 * matching case and the two drifted ones are produced honestly from it — replay the schema, then
 * drop a declared column, then a declared table.
 *
 * ## Why the returned detail is asserted, and not treated as decoration
 *
 * Whether the run REPLAYED the schema is the whole difference between a ~120 ms adoption and a
 * ~1.5 s create, and an idempotent replay leaves no other trace in the database. The `detail` on the
 * outcome is the run's only record of which of the two happened — it is the text the run prints —
 * so it is the observable here.
 */
import { randomBytes } from "node:crypto";

import postgres from "postgres";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareContainerDatabase } from "./container-server-primitives.js";
import { type EphemeralPostgres, startEphemeralPostgres } from "./ephemeral-postgres.js";
import { TEST_DATABASE_URL_ENV_VAR } from "./test-database.js";
import { adoptedContainerRefusal } from "./testcontainers-postgres.js";

/** The declared column dropped to stand for a container built by an older image. */
const DRIFTED_COLUMN = "wiki.embedding_store_meta.backend";

/** The declared table dropped to prove a missing TABLE is named as well as a missing column. */
const DRIFTED_TABLE = "wiki.categories";

/** A database on the suite's own container. */
interface Scratch {
  readonly name: string;
  readonly url: string;
}

let server: EphemeralPostgres;

/** Open one single-connection client with server NOTICEs silenced. */
function openClient(url: string): Sql {
  return postgres(url, { max: 1, connect_timeout: 5, onnotice: () => undefined });
}

/** Run `work` against `url`, always closing the client. */
async function withClient<T>(url: string, work: (client: Sql) => Promise<T>): Promise<T> {
  const client = openClient(url);
  try {
    return await work(client);
  } finally {
    await client.end({ timeout: 10 });
  }
}

/** Every `public`/`wiki` column the database behind `url` reports. */
async function columnNames(url: string): Promise<string[]> {
  const rows = await withClient(url, client =>
    client<{ name: string }[]>`
      select table_schema || '.' || table_name || '.' || column_name as name
      from information_schema.columns where table_schema in ('public', 'wiki')
    `,
  );
  return rows.map(row => row.name);
}

/** Run one statement against `url`. */
async function runSql(url: string, statement: string): Promise<void> {
  await withClient(url, client => client.unsafe(statement));
}

/** Create an empty database on the suite's container and return its URL. */
async function createScratch(label: string): Promise<Scratch> {
  const name = `adoption_${label}_${randomBytes(3).toString("hex")}`;
  await runSql(server.url, `create database "${name}"`);
  const url = new URL(server.url);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** An empty database with the declared schema replayed into it by the code under test. */
async function replayedScratch(label: string): Promise<Scratch> {
  const scratch = await createScratch(label);
  const prepared = await prepareContainerDatabase(scratch.url);
  expect(prepared.ok, `building the ${label} database must succeed: ${prepared.detail}`).toBe(true);
  return scratch;
}

beforeAll(async () => {
  server = await startEphemeralPostgres("adoption-schema");
}, 120_000);

afterAll(async () => {
  // Removing the container removes every database this file created on it; no name is dropped.
  await server?.stop();
}, 60_000);

describe("preparing a container database this run owns", () => {
  it("replays the declared schema into a database that has none, and says it did", async () => {
    const scratch = await createScratch("empty");
    const prepared = await prepareContainerDatabase(scratch.url);
    expect(prepared.ok, prepared.detail).toBe(true);
    expect(prepared.detail).toContain("schema replayed");
    expect(await columnNames(scratch.url)).toContain(DRIFTED_COLUMN);
  });

  it("accepts a database that already carries the declared schema without replaying it", async () => {
    const scratch = await replayedScratch("complete");
    const prepared = await prepareContainerDatabase(scratch.url);
    expect(prepared.ok, prepared.detail).toBe(true);
    expect(prepared.detail).toContain("schema matches");
    expect(prepared.detail).toContain("not replayed");
  });
});

describe("preparing a database that does not match the declared schema", () => {
  it("refuses one that lost a declared column, naming the column", async () => {
    const scratch = await replayedScratch("column");
    await runSql(scratch.url, `alter table wiki.embedding_store_meta drop column backend`);
    const prepared = await prepareContainerDatabase(scratch.url);
    expect(prepared.ok, "a database missing a declared column was reported as usable").toBe(false);
    expect(prepared.detail).toContain(DRIFTED_COLUMN);
  });

  it("refuses one that lost a declared table, naming the table", async () => {
    const scratch = await replayedScratch("table");
    await runSql(scratch.url, `drop table ${DRIFTED_TABLE} cascade`);
    const prepared = await prepareContainerDatabase(scratch.url);
    expect(prepared.ok, "a database missing a declared table was reported as usable").toBe(false);
    expect(prepared.detail).toContain(DRIFTED_TABLE);
  });
});

describe("the record a refused adoption publishes", () => {
  it("names the container, the drift and both ways out, and stops nothing", () => {
    const reason = adoptedContainerRefusal(
      "stale_container",
      `does not match the schema this repository declares: missing columns: ${DRIFTED_COLUMN}`,
    );
    expect(reason, "the reader must be able to find the container").toContain(
      "the adopted container stale_container",
    );
    expect(reason, "the refusal must name what is missing").toContain(DRIFTED_COLUMN);
    expect(reason, "the reason must say how to get an owned container").toContain(
      "docker rm -f stale_container",
    );
    expect(reason, "the reason must name the explicit override").toContain(
      TEST_DATABASE_URL_ENV_VAR,
    );
  });
});
