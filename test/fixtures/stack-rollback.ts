/**
 * @file test/fixtures/stack-rollback.ts
 * @description The isolated-transaction case runner for suites that exercise the DEFAULT Stack.
 *
 * ## What it isolates, and why a transaction is the only way
 *
 * The default Stack is identified by its `domain`, and `stacks.domain` is globally unique.
 * "Does this call reuse the row or create a second one" therefore has no per-suite slice to
 * own the way a random Stack id owns one: a leftover row from an earlier run, or a sibling
 * suite, would decide the assertion instead of the code under test. So each case deletes the
 * `default` domain row, runs, and rolls everything back -- nothing it does reaches the
 * database in either direction.
 *
 * ## Why one shared runner instead of a copy in each suite
 *
 * Two suites pin the default-Stack behaviour and each carried its own copy of this shape,
 * which `fallow` reported as a clone against the repository's own duplication gate. The
 * rollback is the safety property of those suites, so it belongs in ONE place: a copy that
 * drifted, or one that forgot the delete, would make a case pass against whatever row the
 * environment happened to hold. Sharing it fixes what the gate found.
 *
 * ## Why the handle is bound once, and the returned runner takes only the body
 *
 * The transaction has to be opened on the pool the SUITE owns -- the same handle its other
 * reads use -- so the handle cannot be reached from inside this module. Binding it once per
 * suite keeps every case's call site exactly as it was, `isolated(async (tx) => ...)`, and
 * leaves the assertions untouched: only the runner's home changed.
 */
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";

import { DEFAULT_STACK_DOMAIN } from "../../packages/wiki/src/dimensions/stack-selection.js";

/** Thrown to abandon a case's transaction; it never surfaces from a case. */
class DiscardCase extends Error {}

/**
 * Build the isolated-transaction case runner for one database handle.
 *
 * The returned function deletes every row claiming the default domain, runs the case's body
 * on that same transaction, and then rolls the whole thing back by throwing a sentinel the
 * wrapper swallows. A failure from the body is NOT swallowed: only {@link DiscardCase} is,
 * so a real error reaches the case instead of being read as a rolled-back pass.
 *
 * @param db - The handle whose pool the case's transaction is opened on.
 * @returns `(body) => Promise<what body returned>`, on a handle where the default domain is
 *   free and whose work is always discarded.
 */
export function isolatedCases(
  db: DatabaseHandle,
): <T>(body: (tx: DatabaseHandle) => Promise<T>) => Promise<T> {
  return async function isolated<T>(body: (tx: DatabaseHandle) => Promise<T>): Promise<T> {
    const observed: { value?: T } = {};
    const run = async (tx: DatabaseHandle): Promise<void> => {
      await tx.execute(sql`delete from stacks where domain = ${DEFAULT_STACK_DOMAIN}`);
      observed.value = await body(tx);
      throw new DiscardCase("roll the case's work back");
    };
    await db.transaction((tx) => run(tx as unknown as DatabaseHandle)).catch((error: unknown) => {
      if (error instanceof DiscardCase) return;
      throw error;
    });
    return observed.value as T;
  };
}
