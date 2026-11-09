/**
 * @file packages/foundation/src/stack-id.ts
 * @description The ONE Stack-id rule: a Stack is addressed by a UUID, both dimensions agree.
 *
 * ## Why the rule lives in THIS package
 *
 * Two dimensions accept a caller-named Stack — the wiki MCP tools and the KG MCP
 * tools and routes — and they must agree on what a valid id is. Two copies would
 * drift, and the drift surfaces as one dimension refusing an id the other accepts,
 * which is exactly the defect this rule exists to prevent (spec S1). The rule
 * therefore has exactly one home.
 *
 * That home is the bottom layer. `@repo/wiki` and `@repo/kg` may both import
 * `@repo/foundation` (spec S2) and may not import each other (spec S3), so a pure
 * rule placed here is the only placement both sides reach without the edge the
 * split exists to forbid. The rule needs no database, no configuration and no
 * package: this module imports nothing at all, which is what keeps the bottom
 * layer the bottom layer.
 *
 * The rule used to live in the KG package, and for a reachability reason rather
 * than a taste one: root `src/**` already imported `llmwiki-kg` in production, so
 * a shared module placed there was free for the compiler to consume, while the
 * reverse direction was impossible under that package's `rootDir: "src"` and
 * `noEmitOnError` (TS6059). Moving the rule DOWN retires that constraint instead
 * of trading it for a new one, because no dimension sits on the left of this
 * arrow: both sides are consumers here, and neither is a dependency of the other.
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
