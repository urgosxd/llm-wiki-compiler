/**
 * @file src/dimensions/kg/ontology-store.ts
 * @description Reading a Stack's stored ontology declaration out of Postgres.
 *
 * ## Why this is a database concern and not the dimension's own
 *
 * `createKgDimension` knows how to *enforce* an ontology, not how to fetch one.
 * Keeping the query here means the dimension stays testable without a database
 * (its `loadOntology` option is injected), and there is still exactly one place
 * that knows the column name.
 *
 * ## Why raw SQL instead of the vendored drizzle schema
 *
 * The KG package's `schema` object is the authority for `public` tables, but the
 * single fact this module needs is one column name. A `sql` tag against
 * `stacks.ontology` keeps that visible in one line instead of scattering a second
 * table definition; the package's own reader and the wiki page store are written
 * the same way for the same reason.
 *
 * ## Why the column is returned raw
 *
 * This function is a fetch, not a validator. Turning `null` into `undefined` and
 * a stored document into an `Ontology` is `readStackOntology`'s job, and it lives
 * in the vendored core so the HTTP ingest path and this one cannot disagree about
 * what `null` means.
 */

import { sql } from "drizzle-orm";

import { createClient, createDatabase, kgConfig } from "llmwiki-kg";

/** Seconds to wait for the graph database before giving up. */
const DB_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Read the raw `stacks.ontology` value for one Stack.
 *
 * @param stackId - The Stack whose declaration is wanted.
 * @param databaseUrl - Connection override; defaults to the vendored config.
 * @returns The stored document, or `null` when the Stack has no declaration.
 * @throws {Error} When the Stack does not exist or the query fails.
 */
export async function loadStoredOntology(
  stackId: string,
  databaseUrl?: string,
): Promise<unknown> {
  const client = createClient(
    databaseUrl ?? kgConfig.DATABASE_URL,
    DB_CONNECT_TIMEOUT_SECONDS,
  );
  try {
    const db = createDatabase(client);
    const rows = await db.transaction((tx) =>
      tx.execute<{ ontology: unknown }>(
        sql`select ontology from stacks where id = ${stackId}`,
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      // A silent `null` here would mean "unconfigured", which is a behaviour the
      // caller would then trust. An unknown Stack is a configuration error and
      // has to read as one.
      throw new Error(`Stack '${stackId}' not found; cannot read its ontology`);
    }
    return row.ontology;
  } finally {
    await client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
  }
}
