/**
 * @file test/fixtures/kg-postgres.ts
 * @description Shared Postgres harness for the graph-dimension suites that must
 * run against a REAL database.
 *
 * WHY A SHARED HARNESS. Two suites need the same three things: a reachability
 * probe that cannot lie, a stack they own end to end, and a cleanup that cannot
 * reach operator data. Duplicating that setup lets the two drift, and the version
 * that drifts silently is the one that stops running.
 *
 * ## Reachability must never be swallowed
 *
 * An earlier suite caught every provisioning error and flipped a `reachable` flag.
 * Its setup insert was invalid, so every test returned early while vitest still
 * reported them as passed — a green suite proving nothing. So provisioning failure
 * here WARNS LOUDLY and the flag is only false when the database is genuinely
 * unreachable. Callers still decide how to skip; this module refuses to hide why.
 *
 * ## Two failure conditions, and only one of them may skip
 *
 * A `reachable === false` harness is the gate 113 `skipIf` call sites read, so every
 * way of setting it to false is a way for a suite to report green with no database.
 * The two conditions that produce it are NOT the same:
 *
 *  - the database cannot be obtained at all — nothing answers `select 1` — which
 *    THROWS the actionable "no database" failure, because skipping there is the
 *    false green this feature exists to remove;
 *  - the database answers but an object the fixtures need is genuinely absent (the
 *    `stacks` table, a schema), which keeps the old skip.
 *
 * `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is the single documented opt-out and restores the
 * old skip for the first condition too. The throw happens HERE, before any `skipIf` is
 * evaluated, which is why the gate call sites do not need to change.
 *
 * ## Why the harness no longer relies on `cleanup()` for isolation
 *
 * It used to be the isolation mechanism: every Stack lived in the ONE database every
 * suite shared, and `cleanup()` deleted this suite's rows so the next file would not
 * see them. That only isolates suites that finish, and only if no suite deletes by
 * pattern — `db.test.ts`'s `delete from stacks where domain like 't04-route-%'` ran
 * in `afterAll` and removed a parallel worker's rows mid-run, which is what
 * `expected +0 to be 1` was. So the database itself is now per process
 * (`test/fixtures/per-run-database.ts`), and `cleanup()` is hygiene, not isolation.
 */

import { randomUUID } from "node:crypto";
import { createClient, createDatabase } from "llmwiki-kg";
import { perRunDatabase } from "./per-run-database.js";
import { missingTestDatabase } from "./test-database-handoff.js";
import { testDatabaseUrl } from "./test-database.js";

/**
 * This process's private database, or `undefined` when it cannot be provisioned.
 *
 * Guaranteed at import rather than in a hook because `DATABASE_URL` below is a
 * string: the suites that read it build an environment at module scope, so the value
 * has to be known before any test is collected.
 */
const SUITE = await perRunDatabase().catch((error: unknown) => {
  // Not fatal: an absent or unreachable server must still produce the loud
  // `reachable === false` failure below, not a module-load crash with no context.
  console.warn(
    `kg-postgres: per-run database unavailable — ${(error as Error).message}. ` +
      `Falling back to the shared database ${testDatabaseUrl()}.`,
  );
  return undefined;
});

/**
 * Connection string every fixture connects to: this process's OWN database.
 *
 * Resolved through {@link testDatabaseUrl} when the per-run database cannot be
 * created, so an outage still names the server someone should start rather than
 * silently pointing at the vendored production port.
 */
export const DATABASE_URL = SUITE?.url ?? testDatabaseUrl();

/** One suite's private slice of the database. */
export interface KgPostgresHarness {
  /** Stack this suite owns; cleanup cascades from it. */
  readonly stackId: string;
  /** Connection string of the database this Stack lives in. */
  readonly url: string;
  /** Drizzle handle bound to the suite database. */
  readonly db: ReturnType<typeof createDatabase>;
  /** True only when the database is reachable AND the stack was provisioned. */
  readonly reachable: boolean;
  /** Drop the owned stack and close the client. */
  cleanup(): Promise<void>;
}

/**
 * Coerce a suite label into a value `stacks.domain` will accept.
 *
 * The schema constrains `domain` to `^[a-z0-9-]+$`, but suite labels are written for
 * HUMANS and routinely carry capitals -- `useStackEnv("classA")` is the natural thing
 * to type. Passing the label straight through made provisioning fail on the CHECK,
 * and because a failed provision only warns on stderr, every affected suite looked
 * like a "missing Stack" failure instead of a fixture bug. That poisoned recovery
 * measurements before it was found.
 *
 * @param label - The human-facing suite label.
 * @returns A domain-safe slug derived from it.
 */
function domainFor(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  // A label of pure punctuation would slugify to empty, and `domain` is NOT NULL with
  // no default, so fall back to a fixed stem rather than insert an invalid row.
  return slug === "" ? "stack" : slug;
}

/** A message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report that this suite has no database: throw, unless the documented opt-out is set.
 *
 * @param context - What needed the database, phrased for whoever reads the failure.
 * @param detail - The observed failure.
 * @returns `false`, so a caller can `return` it as the unreachable flag.
 * @throws When no database can be obtained and `LLMWIKI_TEST_ALLOW_NO_DATABASE` is not `1`.
 */
function unreachableOrThrow(context: string, detail: string): false {
  const missing = missingTestDatabase(context, detail);
  if (missing.error !== undefined) throw missing.error;
  console.warn(`${context}: every case in this file will be skipped.\n${missing.message}`);
  return false;
}

/**
 * Provision a private stack and hand back a bound database handle.
 *
 * `stacks.domain` is supplied explicitly because it is NOT NULL with no default --
 * omitting it was exactly the invalid insert that produced the silent green. It is
 * DERIVED from the label rather than copied, because the label is not domain-safe.
 *
 * @param name - Short label recorded as the stack name, for debuggability.
 * @returns The harness; check `reachable` before asserting anything.
 */
export async function createKgPostgresHarness(name: string): Promise<KgPostgresHarness> {
  const stackId = randomUUID();
  const client = createClient(DATABASE_URL, 10);
  const db = createDatabase(client);
  const domain = domainFor(name);

  const reachable = await (async (): Promise<boolean> => {
    try {
      // The liveness probe is SEPARATE from the provisioning insert on purpose: this one
      // failing means there is no database, which must never become a skip; the insert
      // failing means the database is up but the object is missing, which still may.
      await db.execute("select 1");
    } catch (error) {
      return unreachableOrThrow(
        `${name}: the kg harness`,
        `select 1 against ${DATABASE_URL} failed — ${describe(error)}`,
      );
    }
    try {
      await db.execute(
        `insert into stacks (id, name, domain) values ('${stackId}', '${name}', '${domain}')`,
      );
      return true;
    } catch (error) {
      // Loud, not silent: a suite that cannot provision must not look like a pass. Still a
      // skip when the opt-out allows it, because the server itself answered.
      console.warn(`${name}: no usable Postgres at ${DATABASE_URL} — ${describe(error)}`);
      return false;
    }
  })();

  return {
    stackId,
    url: DATABASE_URL,
    db,
    reachable,
    cleanup: async () => {
      if (reachable) {
        // Hygiene, not isolation: the whole database goes away with the process, but
        // a suite that re-provisions against the same database must not read this
        // Stack's rows as its own. `stack_documents` and `entity_source_documents`
        // cascade from `stacks`.
        await db.execute(`delete from stacks where id = '${stackId}'`).catch(() => undefined);
      }
      await client.end({ timeout: 10 });
    },
  };
}
