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
 */

import { randomUUID } from "node:crypto";
import { createClient, createDatabase } from "llmwiki-kg";

/** Connection string; defaults to the documented local stack container. */
export const DATABASE_URL =
  process.env.LLMWIKI_TEST_DATABASE_URL ?? "postgresql://aks:aks@localhost:5434/aks";

/** One suite's private slice of the database. */
export interface KgPostgresHarness {
  /** Stack this suite owns; cleanup cascades from it. */
  readonly stackId: string;
  /** Drizzle handle bound to the shared client. */
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
    db,
    reachable,
    cleanup: async () => {
      if (reachable) {
        // `stack_documents` and `entity_source_documents` cascade from `stacks`.
        await db.execute(`delete from stacks where id = '${stackId}'`).catch(() => undefined);
      }
      await client.end({ timeout: 10 });
    },
  };
}
