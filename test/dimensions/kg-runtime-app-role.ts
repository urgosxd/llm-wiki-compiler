/**
 * @file test/dimensions/kg-runtime-app-role.ts
 * @description The safe way to exercise row-level security from a test, and a
 * guard that refuses the unsafe way loudly.
 *
 * ## The trap this exists to close
 *
 * `test/fixtures/kg-postgres.ts` connects with `DATABASE_URL`, whose default is
 * `postgresql://aks:aks@localhost:5434/aks`. Measured on that container: `aks` is
 * a **SUPERUSER with BYPASSRLS**. Row-level security is therefore INERT for every
 * suite built on the shared fixture.
 *
 * The consequence is not a slow test or a flaky one. It is a suite that asserts
 * the opposite of what it claims: a cross-tenant read "succeeds" because the
 * policy never ran, and the green result reads as proof of isolation. That is the
 * one failure mode RLS tests exist to prevent.
 *
 * ## Why this is a separate module rather than an edit to the fixture
 *
 * The fixture is `shared-read-only` in `contract-cordination.json` for this role,
 * and the coordination hook refuses the write. Rather than work around it, this
 * module supplies the safe path inside the scope this role does own
 * (`test/dimensions/kg-runtime-*`) and pins the invariant with a test. The
 * fixture itself should still gain an equivalent helper; that request has been
 * sent to the integration role.
 *
 * ## What "safe" means here
 *
 * `set local role llmwiki_app` is transaction-scoped, so dropping to the
 * application role cannot leak onto the pooled connection afterward — a leaked
 * role change would silently alter every later statement in the same suite.
 */

import { sql } from "drizzle-orm";

/** The non-superuser role every production query runs as. */
export const APP_ROLE = "llmwiki_app";

/**
 * The minimal statement surface an app-role callback receives.
 *
 * Deliberately narrow: a caller that needs a full drizzle handle should narrow
 * this itself rather than have this module leak a concrete driver type into every
 * importing suite.
 */
export interface AppRoleExecutor {
  /** Run one parameterized statement inside the ambient transaction. */
  execute<T = unknown>(query: ReturnType<typeof sql>): Promise<T[]>;
}

/** The subset of a harness this module needs, so callers need no import cycle. */
export interface AppRoleCapable {
  /** Drizzle handle bound to the harness's own connection. */
  readonly db: { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> };
}

/**
 * Run `work` as {@link APP_ROLE} inside ONE transaction.
 *
 * @param harness - Anything exposing a `db.transaction`, normally the shared
 *   Postgres harness.
 * @param work - Statements to run under the application role.
 * @returns Whatever `work` produced, after COMMIT.
 */
export function asAppRole<T>(
  harness: AppRoleCapable,
  work: (tx: AppRoleExecutor) => Promise<T>,
): Promise<T> {
  return harness.db.transaction(async (tx) => {
    const executor = tx as AppRoleExecutor;
    await executor.execute(sql`set local role llmwiki_app`);
    return work(executor);
  });
}

/**
 * Walk an error's `cause` chain looking for a Postgres SQLSTATE code.
 *
 * Drizzle re-throws driver failures as a generic "Failed query" wrapper and keeps
 * the actionable information on `cause`, so matching the outer message can never
 * distinguish a policy refusal (42501) from a foreign key (23503) or a check
 * constraint (23514) — all three can refuse the same statement. The code can.
 *
 * Returns `undefined` rather than throwing, so a caller can assert the ABSENCE of
 * a code as clearly as its presence.
 *
 * @param error - Whatever a rejected statement produced.
 * @returns The SQLSTATE (e.g. `"42501"`), or `undefined` when none is present.
 */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Report whether the harness's connection can bypass row-level security.
 *
 * A caller uses this to SKIP a security assertion rather than run it vacuously.
 * Checking the connection's own `rolbypassrls` is the only honest probe: it
 * answers the question that matters ("will the policy run?") without depending on
 * a username, and it stays correct if the DSN changes.
 *
 * @param harness - Harness whose `db` can execute statements.
 * @returns `true` when the connected role bypasses RLS (superuser or BYPASSRLS).
 */
export async function connectionBypassesRls(harness: AppRoleCapable): Promise<boolean> {
  const rows = await harness.db.transaction((tx) =>
    (tx as AppRoleExecutor).execute<{ bypass: boolean }>(sql`
      select rolbypassrls or rolsuper as bypass
      from pg_roles where rolname = current_user
    `),
  );
  return rows[0]?.bypass === true;
}
