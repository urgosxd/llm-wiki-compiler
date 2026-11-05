/**
 * @file packages/llmwiki-kg/ts/src/stack-id.ts
 * @description The ONE Stack-id rule: a Stack is addressed by a UUID, both dimensions agree.
 *
 * ## Why the rule lives in THIS package
 *
 * Two dimensions accept a caller-named Stack — the wiki MCP tools and the KG MCP
 * tools and routes — and they must agree on what a valid id is. Two copies would
 * drift, and the drift surfaces as one dimension refusing an id the other accepts,
 * which is exactly the defect this rule exists to prevent (spec S1). The rule
 * therefore has exactly one home and both dimensions import it.
 *
 * The direction of that import is not a preference, it is the only one that
 * compiles. Root `src/**` already reaches this package in production
 * (`src/utils/lock-postgres.ts`, `src/dimensions/activation.ts`,
 * `src/host/server.ts` through the `llmwiki-kg` alias), so a shared module placed
 * here is importable from the compiler for free. The reverse is not: this package
 * compiles with `rootDir: "src"` and `noEmitOnError`, so a file here that reached
 * out to `../../../src/**` would fail with TS6059 and take the package's build with
 * it. Placing the rule in the package the compiler already depends on is the
 * arrangement that needs no new plumbing. `packages/llmwiki-core` is not a
 * candidate either: it owns no source, it is a `dist` shell over root `src/`.
 *
 * ## Why validate at all
 *
 * Leaving an invalid string to Postgres makes the `uuid` cast raise, and that
 * error reaches the caller as an internal failure when the honest answer is "that
 * is not a Stack id". Checking first turns a 500 into a 400 with a message a
 * client can act on — and a UUID is the only shape the column can hold, so nothing
 * legitimate is refused here.
 *
 * ## The boundary, stated
 *
 * `STACK_ID_PATTERN` accepts exactly the canonical 8-4-4-4-12 hex form, in either
 * case, with no version or variant constraint. It does NOT accept the shapes a
 * permissive UUID parser allows — 32 bare hex characters, the braced form, and the
 * `urn:uuid:` prefix are all refused. That narrowness is the contract, not an
 * oversight, and `stack-id.test.ts` pins each of those three refusals.
 */

/** The canonical 8-4-4-4-12 hex form, upper or lower case. */
export const STACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this Stack id well formed?
 *
 * @param value - The candidate id.
 * @returns `true` when it is the canonical UUID form, `false` otherwise.
 */
export function isStackId(value: string): boolean {
  return STACK_ID_PATTERN.test(value);
}

/**
 * Explain why a Stack id is unusable, in the words a caller can act on.
 *
 * The text is stable on purpose: wiki-dimension callers surface it verbatim, so it
 * names the offending value and points at `list_stacks` rather than describing the
 * rule abstractly.
 *
 * @param stackId - The id a caller supplied.
 * @returns A caller-facing explanation when it is not well formed, or `undefined`
 *   when it is.
 */
export function stackIdProblem(stackId: string): string | undefined {
  if (isStackId(stackId)) return undefined;
  return (
    `'${stackId}' is not a Stack id. Stack ids are UUIDs — call list_stacks to see ` +
    "the ones this endpoint can reach."
  );
}
