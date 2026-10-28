/**
 * `listPages` / `getPage` reading from a non-file source.
 *
 * The property that matters is PARITY: the same pages must come back through the
 * listing whether they were scanned from disk or read from rows. Filters, sorting,
 * pagination and the presence of the `body` key all belong to the listing, so a
 * backend that answered differently would break every consumer at once.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPages, type Page, type PageListingSource } from "../../src/pages/list.js";

const ALPHA = "---\ntitle: Alpha\nsummary: first\ntags:\n  - a\n---\n\nLinks [[beta]].\n";
const BETA = "---\ntitle: Beta\nsummary: second\n---\n\nplain.\n";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "page-source-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  await writeFile(path.join(root, "wiki/concepts/alpha.md"), ALPHA);
  await writeFile(path.join(root, "wiki/concepts/beta.md"), BETA);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A source backed by fixed pages, standing in for the table. */
function sourceOf(pages: Page[]): PageListingSource {
  return {
    list: async () => pages,
    get: async (directory, slug) =>
      pages.find((p) => p.pageDirectory === directory && p.slug === slug) ?? null,
  };
}

function pageOf(slug: string, body: string, extra: Partial<Page> = {}): Page {
  return {
    slug,
    pageDirectory: "concepts",
    title: slug,
    summary: "",
    tags: [],
    links: [],
    orphaned: false,
    archived: false,
    body,
    ...extra,
  };
}

describe("listPages from a source", () => {
  it("returns the same pages a directory scan returns", async () => {
    const source = sourceOf([pageOf("alpha", ALPHA), pageOf("beta", BETA)]);
    const fromRows = await listPages(root, { pageSource: source });
    const fromDisk = await listPages(root);

    expect(fromRows.pages.map((p) => p.slug)).toEqual(fromDisk.pages.map((p) => p.slug));
    expect(fromRows.total).toBe(fromDisk.total);
  });

  it("omits the body key exactly as the file path does", async () => {
    // A present-but-undefined key and an absent key are different answers to
    // `"body" in page`, and a consumer keying on that would behave differently per
    // backend.
    const pages = (await listPages(root, { pageSource: sourceOf([pageOf("alpha", ALPHA)]) })).pages;

    expect(pages[0]).not.toHaveProperty("body");
  });

  it("applies the same filters the directory path applies", async () => {
    const hidden = pageOf("hidden", BETA, { orphaned: true });
    const source = sourceOf([pageOf("alpha", ALPHA), hidden]);

    expect((await listPages(root, { pageSource: source })).pages.map((p) => p.slug)).toEqual(["alpha"]);
    const withOrphans = await listPages(root, { pageSource: source, includeOrphaned: true });
    expect(withOrphans.pages.map((p) => p.slug)).toEqual(["alpha", "hidden"]);
  });

  it("reads a single page by directory and slug", async () => {
    const { getPage } = await import("../../src/pages/list.js");
    const page = await getPage(root, { slug: "alpha", pageDirectory: "concepts" },
      sourceOf([pageOf("alpha", ALPHA)]));

    expect(page?.body).toBe(ALPHA);
  });
});
