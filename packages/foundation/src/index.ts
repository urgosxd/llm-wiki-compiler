/**
 * @file packages/foundation/src/index.ts
 * @description The bottom layer of the package split: the one workspace package
 * `@repo/wiki`, `@repo/kg` and `@repo/api` are all allowed to import, and the
 * only one that may not import any of them.
 *
 * ## What this package exports
 *
 * Three things, each in its own module and each re-exported here so a consumer
 * writes one specifier — `@repo/foundation` — wherever it stands in the topology:
 *
 * - {@link DatabaseHandle}, the seam below, declared in this file because it is the
 *   one the wiki side holds everywhere;
 * - the Stack-id rule in `stack-id.ts`, which is pure and imports nothing at all;
 * - the two injection seams in `providers.ts` — an advisory lock and one Stack's
 *   config — implemented by `@repo/api` and received by the owning dimension.
 *
 * None of them names a wiki, KG or api type, which is what keeps this file the
 * bottom layer rather than the first step back up it.
 *
 * ## The edge this package replaces
 *
 * The target topology permits `api → wiki`, `api → kg` and `{wiki,kg,api} →
 * foundation`, and forbids `wiki ↔ kg` in both directions. Before this package
 * existed the wiki side held its database handle by naming `@repo/kg`'s
 * `Database` type: 37 `Database` bindings across `src/` and `test/` — the wiki
 * stores, the coordinator, the stack services, the embeddings utilities and every
 * fixture that builds a handle. Each of those is a `wiki → kg` reach that the
 * dimension boundary gate counts and the topology forbids. Type-only does not make
 * it not-an-edge: a type import still means the wiki side cannot be compiled
 * without the KG package, which is precisely the coupling the split exists to end.
 *
 * The fix is not "relax the boundary for types"; it is a bottom layer. Anything may
 * depend on this package, it depends on none of the three, so it can never become
 * the edge it exists to remove and no cycle can route through it.
 *
 * ## What the seam is, and what it is not
 *
 * {@link DatabaseHandle} is a structural description of the handle the wiki side
 * actually operates: run a statement, run a transaction. A real
 * `createDatabase(createClient(url))` value satisfies it with no cast, so a holder
 * of a `DatabaseHandle` holds a working handle — the type is narrow, not a facade
 * over something weaker.
 *
 * It is deliberately a SUBSET. A caller that needs a drizzle capability the seam
 * does not describe (the query builder, the relational `query` map, the typed
 * `schema`) has not been decoupled yet, and must keep naming the concrete type at
 * its own layer rather than widening this interface to launder it.
 *
 * ## Why the member set is what it is
 *
 * Every property access on a `Database`-typed value in `src/`, `test/`,
 * `scripts/` and `packages/llmwiki-kg/ts/src` was resolved through the TypeScript
 * checker and counted, and `execute` and `transaction` are the only two members
 * that appear at all. `insert`, `select`, `update` and `delete` were expected to be
 * part of this seam and were measured to be called nowhere — every statement in the
 * tree is a `sql` template handed to `execute`, because the drizzle `schema` object
 * describes `public` only and the wiki's own tables are raw SQL by design. So they
 * are not here: four methods every layer must satisfy and nobody calls are the same
 * dead-configuration class as an unused setting.
 *
 * The reach counts are deliberately not written down. They move with every new
 * store that touches a handle, and a number in a comment rots the first time the
 * tree does — which is what happened to the pair this paragraph used to carry.
 *
 * ## Why this package names `drizzle-orm` instead of describing it structurally
 *
 * The tested alternative — `execute<TRow>(statement): Promise<readonly TRow[]>` —
 * does not work, and the failure is not cosmetic. The concrete driver returns
 * `PgRaw<RowList<Assume<TRow, Row>[]>>`, and `Assume<TRow, Row>` stays a deferred
 * conditional while `TRow` is a type parameter, so no hand-written row container is
 * assignable to it: `TS2322 … Types of property 'concat' are incompatible … Type
 * 'Record<string, unknown>' is not assignable to type 'Assume<TRow, Row>'`. The row
 * type can only be described by writing the same type expression the driver writes,
 * which means naming `PgQueryResultKind` and the driver's result kind.
 *
 * That is a type-only dependency: `import type` is erased, this package emits
 * nothing, and the two symbols it borrows describe the driver the seam is a subset
 * of. Writing them out by hand would not remove the coupling — it would replace one
 * named import with a copy that drifts.
 */
import type { SQLWrapper } from "drizzle-orm";
import type { PgQueryResultKind } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

/**
 * The rows one statement returned, as the postgres-js driver shapes them.
 *
 * `RowList<…>` rather than a plain array: it keeps the driver's `count` and
 * `command` alongside the rows, and it is the exact type the concrete handle
 * returns, which is what lets a real handle satisfy {@link DatabaseHandle} without
 * a cast.
 *
 * @typeParam TRow - The shape the caller asserts for one row.
 */
type DatabaseRows<TRow extends Record<string, unknown>> = PgQueryResultKind<
  PostgresJsQueryResultHKT,
  TRow
>;

/**
 * A database handle, as this repository uses one.
 *
 * Satisfied by `createDatabase(createClient(url))` with no cast; see
 * `packages/llmwiki-kg/ts/src/foundation-database-handle.test.ts`, which is where
 * that claim is held to. The test lives beside the concrete handle it exercises
 * rather than here: reaching `createDatabase` from this package would make the
 * bottom layer import the dimension it exists to decouple.
 */
export interface DatabaseHandle {
  /**
   * Run one statement and read its rows.
   *
   * The row type is the caller's assertion about the columns, exactly as with the
   * concrete handle: `execute` forwards the statement to the driver, which does not
   * know the shape.
   *
   * @param statement - A drizzle `sql` fragment, or a plain SQL string.
   * @returns The rows the driver returned, in driver order.
   */
  execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: SQLWrapper | string,
  ): Promise<DatabaseRows<TRow>>;

  /**
   * Run `run` inside one transaction and commit it when it resolves.
   *
   * The callback receives the transaction's own handle rather than the outer one,
   * which is the property that makes joining safe: statements issued on `tx` commit
   * or roll back together, while statements issued on the outer handle do not. A
   * rejection rolls the whole unit back.
   *
   * No isolation-level argument is described because no caller in this tree passes
   * one: a second parameter nobody uses would be a capability the seam advertises
   * and no layer can rely on.
   *
   * @param run - The unit of work, given the transaction's handle.
   * @returns Whatever `run` returned, after the commit.
   */
  transaction<T>(run: (tx: DatabaseHandle) => Promise<T>): Promise<T>;
}

/**
 * The Stack-id rule both dimensions validate against.
 *
 * Re-exported rather than restated: the implementation lives in `stack-id.ts` with
 * the documentation that says why the canonical 8-4-4-4-12 form is the contract and
 * why the three permissive UUID shapes are refused.
 */
export { STACK_ID_PATTERN, isStackId, stackIdProblem } from "./stack-id.js";

/**
 * The two provider seams. Interfaces only — the implementation is `@repo/api`'s, and
 * the receiving dimension takes it by injection; see `providers.ts`.
 */
export type { AdvisoryLock, AdvisoryLockProvider, ProjectConfigProvider } from "./providers.js";
