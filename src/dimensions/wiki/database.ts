/**
 * @file src/dimensions/wiki/database.ts
 * @description The database-backed half of the wiki dimension, published as its
 * own entry point so it can be reached without dragging Postgres onto the
 * filesystem path.
 *
 * ## The problem this file solves
 *
 * W3.2 and W3.3 added `store-dimension.ts` and `page-reader.ts`, and the tests
 * import them by their own paths. Nothing in the product could: `index.ts` is the
 * wiki's barrel and it deliberately exports only the file-backed pair, so the two
 * database factories existed and were unreachable from any consumer.
 *
 * The obvious fix — add two `export` lines to `index.ts` — is the wrong one, and
 * this file exists because it is wrong for a measurable reason:
 *
 *   - `store-dimension.ts` and `page-reader.ts` both import `page-store.ts`, which
 *     imports `sql` from `drizzle-orm` as a VALUE, not a type.
 *   - `drizzle-orm` is declared in `packages/llmwiki-kg/ts/package.json`, not in
 *     the root `package.json`. Every consumer of the root package would start
 *     depending on a workspace-internal dependency the moment the wiki barrel
 *     loaded, including the CLI paths that never touch a database.
 *   - `index.ts` is imported by `src/dimensions/index.ts`, which is imported by
 *     `src/compiler/index.ts` and `src/services/ingest/service.ts`. So "add two
 *     lines to the barrel" means "every `compile` and `ingest` invocation loads
 *     the query builder", for a feature the caller did not ask for.
 *
 * A separate entry point keeps the cost where the choice is made: a consumer that
 * wants the database-backed wiki imports this module, and one that does not never
 * sees `drizzle-orm` at all. W3.4 requires the file-backed implementation to stay
 * selectable, and this is what makes "selectable" mean a real import decision
 * rather than a runtime flag over one already-loaded module graph.
 *
 * ## What is NOT decided here
 *
 * The choice between the backends is a caller decision and this module asserts
 * nothing about it. `createWikiDimension(root)` and `createWikiStoreDimension({
 * db, stackId })` both satisfy the same `Dimension` port; likewise
 * `createWikiReader(root)` and `createWikiPageReader({ db, stackId })` both
 * satisfy `DimensionReader`. Neither the activation switch
 * (`src/dimensions/activation.ts`) nor the top-level dimension barrel is touched
 * here: both are `sharedPaths`, so wiring the database path into the product's
 * startup belongs to the integration role, not to the wiki dimension.
 */

export { createWikiStoreDimension } from "./store-dimension.js";
export { createWikiPageReader } from "./page-reader.js";
export type { WikiPageReaderOptions } from "./page-reader.js";
