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
 * ## What is here today
 *
 * `main.ts` is the container launcher (`host` and `serve`), and `host/` is the
 * unified listener it dispatches to: one HTTP server mounting the wiki viewer, the
 * wiki mutation endpoints and the KG graph sub-app, plus the MCP-over-HTTP mount
 * and the tenant resolver. `serve-bind.ts` is HERE, beside the only listener that
 * uses it: it lived in `@repo/wiki` while the CLI's `view` command shared the bind
 * and privacy gate, and it moved once `view` left with the CLI, because moving it
 * earlier would have created a `wiki → api` edge. The modules the listener needs
 * from the wiki side are reached through that package's explicit `exports`
 * subpaths; nothing here is a re-export barrel.
 *
 * This is a private, bundled entry: `tsup` emits it as the root `dist/api.js`, so
 * the package declares no public API and its `exports` map names only `.` for the
 * topology statement.
 */
