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
      await db.execute("select 1");
      await db.execute(
        `insert into stacks (id, name, domain) values ('${stackId}', '${name}', '${domain}')`,
      );
      return true;
    } catch (error) {
      // Loud, not silent: a suite that cannot provision must not look like a pass.
      console.warn(`${name}: no usable Postgres at ${DATABASE_URL} — ${(error as Error).message}`);
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
