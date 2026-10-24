/**
 * @file test/dimensions/wiki-database-entry.test.ts
 * @description The database-backed wiki has ONE entry point, and the dimension
 * barrel does not become a second one.
 *
 * ## Why the first case exists
 *
 * `store-dimension.ts` and `page-reader.ts` were written, tested, and completely
 * unreachable: their own test files imported them by path, which proves a module
 * compiles and proves nothing about whether a consumer can obtain it. So the
 * first case exercises the entry point a consumer would actually use.
 *
 * ## Why the second case exists, and what it is NOT about
 *
 * `page-store.ts` imports `sql` from `drizzle-orm` as a VALUE, and `drizzle-orm`
 * is declared in `packages/llmwiki-kg/ts/package.json`, not in the root manifest.
 * `src/dimensions/index.ts` sits on the `compile` and `ingest` paths, so exporting
 * the database pair from there would load a query builder for every caller that
 * never touches a database.
 *
 * The guard therefore names `src/dimensions/index.ts` — the barrel that matters —
 * and not the wiki's own barrel. It used to name `src/dimensions/wiki/index.ts`,
 * which was the right guard against the wrong file: that module is the
 * FILE-BACKED dimension and exports no database factory, so the old assertion
 * could only ever pass by accident of the barrel being narrow. Retargeting it is
 * what keeps the guard honest once the file-backed dimension is deleted, and it
 * is deliberately KEPT rather than dropped: without it, nothing prevents the
 * regression it was written for.
 */
import { describe, expect, it } from "vitest";

import * as databaseEntry from "../../src/dimensions/wiki/database.js";
import type {
  WikiPageReaderOptions,
  WikiStoreDimensionOptions,
} from "../../src/dimensions/wiki/database.js";
import * as dimensionBarrel from "../../src/dimensions/index.js";
import type { Dimension } from "../../src/dimensions/types.js";
import type { DimensionReader } from "../../src/dimensions/read-types.js";

/** A database handle is never touched by construction, so a cast is honest here. */
const unusedDatabase = {} as WikiStoreDimensionOptions["db"];

/** Somewhere no pages exist; construction still does no I/O. */
const EMPTY_STACK_ID = "00000000-0000-0000-0000-000000000000";

describe("the database-backed wiki entry point", () => {
  it("publishes both factories callable as their ports", () => {
    const options: WikiPageReaderOptions = {
      stackId: EMPTY_STACK_ID,
      db: unusedDatabase,
      root: "/tmp/wiki-entry-guard",
    };
    const dimension: Dimension = databaseEntry.createWikiStoreDimension(options);
    const reader: DimensionReader = databaseEntry.createWikiPageReader(options);
    expect(dimension.name).toBe("wiki");
    expect(reader.name).toBe("wiki");
  });

  it("does not leak the database pair into the dimension barrel", () => {
    // Not an oversight: this barrel is imported by the compiler and the ingest
    // service, so a database export here costs every CLI invocation a query
    // builder it does not use.
    expect(Object.keys(dimensionBarrel)).not.toContain("createWikiStoreDimension");
    expect(Object.keys(dimensionBarrel)).not.toContain("createWikiPageReader");
  });
});
