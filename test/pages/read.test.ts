/**
 * @file test/pages/read.test.ts
 * @description `readPageRecord` — the read path behind `read_page` — over pages on disk.
 *
 * ## The condition the two original cases did not contain
 *
 * A page's `slug` is its RAW filename stem (`packages/wiki/src/wiki/collect.ts` keeps
 * it verbatim), while a wikilink target is SLUGIFIED: `normalizeWikilinkTarget`
 * (`packages/wiki/src/wiki/wikilink-tokens.ts:77`) slugifies the page part, so a body
 * that says `[[concepts/7. Subdominios DDD]]` is emitted as `concepts/7-subdominios-ddd`.
 * `readPageRecord` joined that page part straight onto the filename, so the id our own
 * extractor produces answered "not found" — the original defect one level down, and
 * invisible because the shared resolver (`packages/wiki/src/viewer/collect.ts:129`,
 * exact stem first then slugified stem) resolved the same target without complaint.
 *
 * Every id asserted below is the string the extractor produces for the page that is on
 * disk; none is hand-written to suit the implementation.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPageRecord } from "../../packages/wiki/src/pages/read.js";

const roots: string[] = [];

/**
 * A throwaway project root with both page directories, removed after each case.
 *
 * @returns The absolute root path.
 */
async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-read-"));
  roots.push(root);
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  return root;
}

/**
 * Write one page the way the compiler writes it: frontmatter, blank line, body.
 *
 * @param root - Project root.
 * @param directory - `concepts` or `queries`.
 * @param stem - The RAW filename stem, title-shaped included.
 * @param title - Frontmatter title, distinct per page so a wrong page cannot pass.
 */
async function writePage(
  root: string,
  directory: string,
  stem: string,
  title: string,
): Promise<void> {
  const body = `---\ntitle: ${title}\nsummary: about ${title}\n---\n\n${title} body text.\n`;
  await writeFile(path.join(root, "wiki", directory, `${stem}.md`), body, "utf-8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readPageRecord", () => {
  it("reads a concept page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-read-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/foo.md"), "---\ntitle: Foo\nsummary: s\n---\nbody", "utf-8");
    const page = await readPageRecord(root, "foo");
    expect(page?.title).toBe("Foo");
    expect(page?.body).toContain("body");
  });

  it("skips orphaned pages, returning null", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-read-"));
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/gone.md"), "---\ntitle: Gone\norphaned: true\n---\nbody", "utf-8");
    expect(await readPageRecord(root, "gone")).toBeNull();
  });
});

describe("readPageRecord over a qualified page id", () => {
  it("resolves the slugified id our extractor emits to a title-shaped stem", async () => {
    const root = await scratchRoot();
    await writePage(root, "concepts", "7. Subdominios DDD", "Seven");

    // The exact string `normalizeWikilinkTarget` produces for
    // `[[concepts/7. Subdominios DDD]]` — not a spelling chosen to suit the lookup.
    const page = await readPageRecord(root, "concepts/7-subdominios-ddd");

    expect(page?.title).toBe("Seven");
    expect(page?.body).toContain("Seven body text.");
    // The id reported back is the one that was asked for, so a caller can pass it on.
    expect(page?.slug).toBe("concepts/7-subdominios-ddd");
  });

  it("stays inside the namespace it names, and invents no page", async () => {
    const root = await scratchRoot();
    await writePage(root, "concepts", "7. Subdominios DDD", "Seven");

    // Only the concepts page exists: a `queries` id must not reach across, and a page
    // that is genuinely absent must still answer "not found" rather than the nearest
    // fuzzy match.
    expect(await readPageRecord(root, "queries/7-subdominios-ddd")).toBeNull();
    expect(await readPageRecord(root, "concepts/nope")).toBeNull();
  });

  it("prefers the exact stem over a slugified one inside the namespace", async () => {
    const root = await scratchRoot();
    await writePage(root, "concepts", "7-subdominios-ddd", "Exact");
    await writePage(root, "concepts", "7. Subdominios DDD", "Title shaped");

    // Both pages answer to the same slug form. The id names the literal one, so the
    // answer cannot depend on directory read order.
    const page = await readPageRecord(root, "concepts/7-subdominios-ddd");
    expect(page?.title).toBe("Exact");
  });
});

describe("readPageRecord over a bare slug", () => {
  it("keeps the direct filename lookup — no slugified scan on the bare path", async () => {
    const root = await scratchRoot();
    await writePage(root, "concepts", "7. Subdominios DDD", "Seven");

    // PRESERVE, pinned as what it is rather than chosen here: the bare path joins the
    // slug onto the filename and never scans, so a title-shaped stem is reachable only
    // through the qualified id its own link carries.
    expect(await readPageRecord(root, "7-subdominios-ddd")).toBeNull();
    expect((await readPageRecord(root, "7. Subdominios DDD"))?.title).toBe("Seven");
  });
});
