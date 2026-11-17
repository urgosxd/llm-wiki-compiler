/**
 * @file packages/foundation/src/stack-migration.ts
 * @description The ONE refusal for a database that predates
 * `db/migration_stack_active.sql`, the error that carries it, and the matcher that
 * recognises the driver error it replaces.
 *
 * ## Why the sentence lives in THIS package
 *
 * `stacks.active` is selected by two packages that may not import each other: the wiki
 * side's Stack store (`stackResolution`, the lookup every Stack-scoped request reaches)
 * and the KG side's `/stacks` router, whose `STACK_COLUMNS` selects the column on every
 * listing, read and create — the routes an operator consults precisely when an upgrade
 * misbehaves. Both must name the same file, in the same words, or an operator meeting the
 * two surfaces reads two different instructions for one missing migration.
 *
 * A second literal in the second package is the defect this repository already paid for
 * once: `isDatabaseConfigured` was deduplicated for exactly this reason. `@repo/wiki` and
 * `@repo/kg` may both depend on `@repo/foundation` and may not depend on each other, so
 * the bottom layer is the only placement both sides reach without the edge the package
 * split exists to forbid. `stack-id.ts` sits here for the same reason, and this module
 * follows its shape: it imports nothing at all, which is what keeps the bottom layer the
 * bottom layer.
 *
 * ## Why the column is not optional
 *
 * No code path reads around it: the column is in every projection of the table, so a
 * database without it cannot answer "which Stack" at all. Degrading to `active = true`
 * whenever the column is absent would turn a schema that predates a contract into a
 * deployment that silently ignores it — retirement of a Stack would become invisible
 * rather than refused. The only useful thing to say is which file to apply.
 *
 * ## What is NOT here
 *
 * The guard itself. Where a query runs and how a surface reports the failure is each
 * package's business: the wiki store throws {@link MissingStackColumnError} from its one
 * read, and the KG router answers 503 with {@link missingActiveColumnRefusal} in the
 * `{"detail": "<string>"}` envelope it is a port of. Sharing the sentence and the
 * recognition is the whole contract; sharing a policy would force one surface's status
 * code onto the other.
 *
 * ## The specifier a consumer must use
 *
 * `@repo/foundation/stack-migration`, not the package root. The root entry re-exports this
 * module for consumers that are bundled, but its own relative specifiers are written
 * `./stack-id.js` (the TypeScript convention) and no such file exists on disk — so a BUILT
 * consumer whose output Node loads directly resolves that import and fails on it. The
 * subpath maps straight at the `.ts` file, which is why `stack-id` is consumed the same
 * way: `packages/llmwiki-kg/ts/src/stack-id.ts` re-exports `@repo/foundation/stack-id` for
 * exactly this reason.
 */

/**
 * The migration that adds the one column every `stacks` projection selects.
 *
 * Named as an operator meets it — the file inside the repository's `db/` directory —
 * because a refusal that does not say which file to apply cannot be acted on.
 */
export const STACKS_ACTIVE_MIGRATION = "db/migration_stack_active.sql";

/**
 * THE refusal for a database that never ran {@link STACKS_ACTIVE_MIGRATION}.
 *
 * Exported as text, not as a constant template, so a caller cannot append a status code,
 * a hint or a second sentence: every surface that answers this gap answers it in these
 * words. Each surface chooses only the envelope.
 *
 * @returns The refusal text, without a trailing newline.
 */
export function missingActiveColumnRefusal(): string {
  return (
    `This database is missing the column stacks.active: it has not run ${STACKS_ACTIVE_MIGRATION}. ` +
    "Apply it before serving traffic."
  );
}

/**
 * A database whose `stacks` table predates the migration this build requires.
 *
 * Deliberately NOT an authority error: that family is about which Stack a request may act
 * on, and this is about the schema being too old to ask the question at all. Folding the
 * two would make "the database was never migrated" indistinguishable from "this request
 * named no Stack", which are refusals an operator fixes in completely different places.
 *
 * The name is set explicitly rather than inferred, because every consumer treats this
 * value as a NAME (`error.name === "MissingStackColumnError"`) — a surface that answers
 * it differently, and a log line that has to be searchable, both need the string to be
 * the same as the class.
 */
export class MissingStackColumnError extends Error {
  /**
   * @param message - The refusal text; normally {@link missingActiveColumnRefusal}.
   * @param options - Standard error options; `cause` carries the driver's own error.
   */
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MissingStackColumnError";
  }
}

/** Postgres `undefined_column`, the code an unmigrated database answers with. */
const UNDEFINED_COLUMN = "42703";

/**
 * Postgres's own wording for the column this module is about.
 *
 * The column name is the ONLY discriminator that identifies this gap, which is why it is
 * matched here rather than trusting the SQLSTATE — see {@link missingActiveColumnCause}.
 */
const ACTIVE_COLUMN_ABSENT = /column "active" does not exist/;

/** How deep a driver error chain is searched for {@link UNDEFINED_COLUMN}. */
const MAX_CAUSE_DEPTH = 4;

/**
 * The innermost error in this chain that says Postgres could not read `stacks.active`.
 *
 * ## Why the chain is walked
 *
 * The driver error does not arrive unwrapped: drizzle throws its own
 * `Failed query: select active from stacks …`, which carries the `PostgresError` as
 * `cause`. Returning the INNERMOST match is what lets a consumer chain Postgres's own
 * error as the `cause` it reports, so its words and its SQLSTATE stay reachable.
 *
 * ## Why the COLUMN decides, and the SQLSTATE alone does not
 *
 * `42703` is answered for any missing column, so keying on it reports THIS migration for a
 * schema gap somewhere else entirely — which is what sent an operator to a file that was
 * already applied while the real missing column stayed unnamed. The column is therefore the
 * discriminator, taken from whichever signal carries it: the driver's own `column` field
 * when it sets one, or Postgres's wording `column "active" does not exist`, which is what
 * the SQLSTATE's text is. Both are accepted so a driver that sets only one of them is still
 * recognised, and anything that names a different column matches neither.
 *
 * @param error - Whatever the query threw.
 * @param depth - How many `cause` hops were already followed.
 * @returns That error, or `undefined` when the gap is something else entirely.
 */
export function missingActiveColumnCause(error: unknown, depth = 0): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, column, message, cause } = error as {
    code?: unknown;
    column?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const inner =
    depth < MAX_CAUSE_DEPTH ? missingActiveColumnCause(cause, depth + 1) : undefined;
  if (inner !== undefined) return inner;
  if (code === UNDEFINED_COLUMN && column === "active") return error;
  if (typeof message === "string" && ACTIVE_COLUMN_ABSENT.test(message)) return error;
  return undefined;
}
