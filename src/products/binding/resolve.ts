/**
 * @file src/products/binding/resolve.ts
 * @description Resolve which profile AUTHORITY a project uses.
 *
 * ## What this replaced
 *
 * A product binding was a second, signed profile authority that could sit beside a
 * legacy `profile.json`. Deciding between them was a real problem: two authorities
 * present had to be a hard conflict rather than a silent preference, and a binding that
 * was present but unhealthy had to fail closed instead of quietly falling back.
 *
 * The product layer is gone from this build, so one of the three outcomes can no longer
 * occur: nothing can produce a binding. This module therefore reports `legacy` for every
 * project -- not as a permissive default, but because it is now the only possible state.
 *
 * ## Why the union keeps its other arms
 *
 * `loadProfile` still branches on `product` and `conflict`, and `on-unavailable` still
 * carries a detail string. Narrowing the union to a single arm would force a rewrite of
 * the loader's authority handling for no behavioural gain, and would erase the vocabulary
 * a future binding implementation would need. The caller keeps failing closed on the arms
 * it can still receive from elsewhere; they are simply unreachable here.
 */

/** Which authority a project's profile comes from. */
export type ActiveProductResolution =
  | { mode: "legacy" }
  | { mode: "product"; loaded: never }
  | { mode: "conflict" }
  | { mode: "unavailable"; detail: string };

/**
 * Report that this project has no product binding, so its profile is the legacy one.
 *
 * @returns Always `{ mode: "legacy" }` in this build.
 */
export async function resolveActiveProduct(): Promise<ActiveProductResolution> {
  return { mode: "legacy" };
}
