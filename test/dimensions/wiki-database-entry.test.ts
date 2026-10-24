/**
 * @file test/dimensions/wiki-database-entry.test.ts
 * @description The database-backed wiki factories are reachable from outside the
 * wiki directory — and the filesystem barrel still does not carry them.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. `store-dimension.ts` and `page-reader.ts`
 * were written and tested, and nothing in the product could import them: their own
 * test files reached them by path, which proves the module compiles and proves
 * nothing about reachability. The bug was invisible because every existing test
 * imported the exact file it was testing.
 *
 * So the first assertion is about the ENTRY POINT a consumer would use. The second
 * records the reason the entry point is separate rather than being two lines in
 * `index.ts`: pulling `page-store.ts` into the wiki barrel would load
 * `drizzle-orm` — a dependency of the KG workspace package, absent from the root
 * manifest — on every `compile` and `ingest` path. Both assertions are here so a
 * future "simplification" that merges the entry point into the barrel fails.
 */
import { describe, expect, it } from "vitest";

import * as databaseEntry from "../../src/dimensions/wiki/database.js";
import type { WikiPageReaderOptions } from "../../src/dimensions/wiki/database.js";
import * as filesystemBarrel from "../../src/dimensions/wiki/index.js";
import type { Dimension } from "../../src/dimensions/types.js";
import type { DimensionReader } from "../../src/dimensions/read-types.js";

/** A database handle is never touched by construction, so a cast is honest here. */
const unusedDatabase = {} as Parameters<typeof databaseEntry.createWikiStoreDimension>[0]["db"];

/** Somewhere no pages exist; construction still does no I/O. */
const EMPTY_STACK_ID = "00000000-0000-0000-0000-000000000000";

describe("the database-backed wiki entry point", () => {
  it("publishes both factories callable as their ports", () => {
    const options: WikiPageReaderOptions = { stackId: EMPTY_STACK_ID, db: unusedDatabase };
    const dimension: Dimension = databaseEntry.createWikiStoreDimension(options);
    const reader: DimensionReader = databaseEntry.createWikiPageReader(options);
    expect(dimension.name).toBe("wiki");
    expect(reader.name).toBe("wiki");
  });

  it("keeps them out of the filesystem barrel", () => {
    // Not an oversight: exporting these from `index.ts` would load the query
    // builder for every caller that only wanted the file-backed wiki.
    expect(Object.keys(filesystemBarrel)).not.toContain("createWikiStoreDimension");
    expect(Object.keys(filesystemBarrel)).not.toContain("createWikiPageReader");
  });
});
