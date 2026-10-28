/**
 * Profile-schema reservations and the live top-level CLI command inventory.
 *
 * Schema-v1 reservations are stable: extending the CLI must not invalidate an
 * existing profile. Workflow and action IDs are positional arguments beneath
 * `workflow`, not dynamically registered top-level commands. The CLI inventory
 * is separate and checked against actual help output by the drift test.
 */

/** Names excluded by the public profile-v1 contract; do not expand in place. */
export const PROFILE_V1_RESERVED_VERBS: ReadonlySet<string> = new Set([
  "artifact", "cache", "compile", "connector", "context", "eval", "export", "host",
  "import", "ingest", "ingest-session", "links-here", "lint", "next", "profile",
  "query", "quickstart", "recover", "refresh", "review", "rm", "rules", "schema",
  "serve", "status", "view", "watch",
]);

/**
 * Live CLI inventory, independent of persisted profile-v1 validation.
 *
 * Pruned to the verbs the CLI actually registers. It used to reserve names for
 * buried subsystems (`workflow`, `template`, `state`, `operation`, `preparation`,
 * `product`) while MISSING two live ones (`host`, `links-here`) -- so the drift
 * guard reported the missing verb and stayed red for a reason nobody read. A
 * reserved-verb list that describes a vanished CLI cannot protect the one that
 * exists.
 */
export const RESERVED_CORE_VERBS: ReadonlySet<string> = new Set([
  ...PROFILE_V1_RESERVED_VERBS, "visualize",
]);
