/**
 * @file packages/api/src/index.ts
 * @description The top of the package split: the joining package, and the only
 * package permitted to depend on both `@repo/wiki` and `@repo/kg`.
 *
 * ## What this package is
 *
 * The seam where the two dimensions meet. The target topology permits
 * `api → wiki`, `api → kg` and `{wiki,kg,api} → foundation`, and forbids
 * `wiki ↔ kg` in both directions. Every place in the tree that has to hold a
 * wiki value and a kg value at once belongs here, because the alternative is
 * that one dimension imports the other and the boundary the split exists to
 * create never materializes. The boundary gate enforces the consequence in both
 * directions: a wiki file importing `@repo/api`, or a kg file importing it, is
 * a violation, because an arrow into the joiner is the same inverted edge as an
 * arrow between the joined.
 *
 * ## What this package is not
 *
 * It is not a home for code that only one dimension needs. Anything reachable
 * from a single side belongs to that side, and anything both sides must name
 * *without* importing each other belongs to the bottom layer, `@repo/foundation`.
 * A module parked here because it was inconvenient to place is how the joiner
 * turns into a second dumping ground and the topology loses its meaning.
 *
 * It is also not a public surface: this package is `private`, imports nothing
 * from the published facade that it does not own, and ships only as part of the
 * root bundle.
 *
 * ## No exports yet
 *
 * The package exists so the topology can be stated, linted and gated before
 * anything moves into it. The moves that populate it are separate work units;
 * until then an empty entry point is the honest state, not a placeholder to
 * fill with a speculative API.
 */
