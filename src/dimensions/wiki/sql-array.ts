/**
 * @file src/dimensions/wiki/sql-array.ts
 * @description Render a JS string array as the Postgres literal Drizzle accepts.
 *
 * ## Why this exists at all
 *
 * Drizzle expands a JS array parameter into a ROW constructor — `(a, b)` — so
 * `tags = ${["x"]}` becomes an empty `()` for a single element and a syntax error
 * for more. The form Postgres accepts is one text parameter holding `{"x","y"}`,
 * cast to `text[]` in SQL.
 *
 * ## Why local rather than imported
 *
 * The vendored package solves the same problem in `toPostgresArrayLiteral`
 * (`core/aks_serializers.ts`) but does not export it through the barrel, and
 * reaching into a package's internals is worse than owning four lines. Three wiki
 * stores needed this; keeping three copies is how one of them eventually escapes
 * differently from the others.
 */

/**
 * Encode strings as a Postgres array literal.
 *
 * Quotes and backslashes are escaped, because a slug or tag containing either would
 * otherwise produce a literal Postgres cannot parse — and the failure would surface
 * as a syntax error far from the value that caused it.
 *
 * @param values - Strings to encode.
 * @returns A literal such as `{"a","b"}`, safe to cast to `text[]`.
 */
export function toArrayLiteral(values: readonly string[]): string {
  const quoted = values.map(
    (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return `{${quoted.join(",")}}`;
}
