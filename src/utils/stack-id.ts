/**
 * @file src/utils/stack-id.ts
 * @description Validate a Stack id before it is allowed near the database.
 *
 * ## Why this is a shared util and not a local check
 *
 * Two surfaces accept a caller-named Stack — the MCP tools (`?stackId=` on the job
 * reads) and `GET /api/ingest/jobs?stackId=` — and they must agree on what a valid
 * id is. A copy in each would drift, and the drift would surface as one surface
 * rejecting an id the other accepts.
 *
 * It lives under `src/utils` rather than in either caller because the viewer must
 * not import from `src/mcp/**` (it must stay free of the MCP SDK) and the MCP tools
 * must not import from the viewer.
 *
 * ## Why validate at all
 *
 * Leaving an invalid string to Postgres makes the `uuid` cast raise, and that error
 * reaches the caller as an internal failure when the honest answer is "that is not
 * a Stack id". Checking first turns a 500 into a 400 with a message a client can act
 * on — and a UUID is the only shape the column can hold, so nothing legitimate is
 * rejected here.
 */

/** The canonical 8-4-4-4-12 hex form, upper or lower case. */
const STACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this Stack id well formed?
 *
 * @param stackId - The id a caller supplied.
 * @returns A caller-facing explanation when it is not, or `undefined` when it is.
 */
export function stackIdProblem(stackId: string): string | undefined {
  if (STACK_ID_PATTERN.test(stackId)) return undefined;
  return (
    `'${stackId}' is not a Stack id. Stack ids are UUIDs — call list_stacks to see ` +
    "the ones this endpoint can reach."
  );
}
