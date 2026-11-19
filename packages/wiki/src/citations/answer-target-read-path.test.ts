/**
 * The round trip that failed in production, pinned as a property over arbitrary pages:
 * every id our own machinery EMITS must resolve back to the page it names.
 *
 * WHY THIS FILE EXISTS. The human's report was a response whose citations and body
 * wikilinks were BOTH dead, which means the failure was in what the machinery emitted,
 * not in what it detected. There are three emitters, and this file drives all three:
 *
 *   - `collectAnswerCitationIndex` (`packages/wiki/src/citations/answer-index.ts`) — the
 *     ids the answer prompt is shown and the model cites back;
 *   - `pageLinkRefs` (`packages/wiki/src/pages/read.ts`) — the `links[].slug` on the wire;
 *   - `collectViewerPages` (`packages/wiki/src/viewer/collect.ts`) — page ids and the
 *     resolved outgoing links behind `/api/graph`.
 *
 * WHAT EACH EMITTER'S ID IS — not the same thing, and the difference is the point:
 *
 *   - `collectAnswerCitationIndex` carries the RAW filename stem:
 *     `const slug = file.slice(0, -3)` (`packages/wiki/src/citations/answer-index.ts:33`)
 *     feeding `id: \`${pageDirectory}/${slug}\`` (`:36`);
 *   - `collectViewerPages` carries the RAW stem too: the page id is
 *     `\`${page.pageDirectory}/${page.slug}\`` (`packages/wiki/src/viewer/collect.ts:217`);
 *   - `pageLinkRefs` is the ONLY one that slugifies: it carries the normalized target
 *     (`packages/wiki/src/pages/read.ts:82`), whose page part `normalizeWikilinkTarget`
 *     (`packages/wiki/src/wiki/wikilink-tokens.ts:77`) slugifies.
 *
 * So of the 32 ids this file drives, the 8 `link from …` ids are the only ones that can
 * exercise the slugified qualified path, and 4 of those 8 actually differ from their raw
 * stem (`7. Subdominios DDD`, `2024 Recap`, `東京 Café`, `6. Query Titled`); the other 24
 * ids sit on the pre-existing exact-stem path. Measured the hard way: reverting the
 * read-path slugified pass fails ONLY the `link from …` entries — zero `index id`,
 * `viewer id` or `viewer out`. The last test in this file pins that leg on purpose, so
 * dropping the title-shaped pages from the seed cannot leave this file green while
 * covering nothing this branch fixed.
 *
 * A page's stored `slug` is its RAW filename stem, so the round trip holds only because
 * `readPageRecord` resolves exact-stem-first, then slugified, inside the namespace. This
 * file asserts the round trip through the public read path; it asserts nothing about
 * internals.
 *
 * The expectations are keyed by IDENTITY, not by one spelling of it: one page answers to
 * BOTH `${directory}/${stem}` and `${directory}/${slugify(stem)}`, because those are the
 * two forms the machinery emits for it.
 */
import { describe, expect, it, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPageRecord, pageLinkRefs } from "../pages/read.js";
import { collectAnswerCitationIndex } from "./answer-index.js";
import { reportAnswerCitations } from "./answer-report.js";
import { collectViewerPages } from "../viewer/collect.js";
import { slugify } from "../utils/markdown.js";

interface Seeded { directory: string; stem: string; title: string; body?: string }
const created: string[] = [];
afterAll(async () => { for (const root of created) await fs.rm(root, { recursive: true, force: true }); });

async function makeStack(pages: Seeded[]): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answer-read-path-")));
  created.push(root);
  await fs.mkdir(path.join(root, "wiki"), { recursive: true });
  for (const page of pages) {
    const file = path.join(root, "wiki", page.directory, `${page.stem}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: "${page.title}"\nsummary: ""\nsources: []\n---\n\n${page.body ?? "Body text."}\n`);
  }
  return root;
}

/**
 * Expected titles keyed by every id form the machinery can emit for a page.
 *
 * Two keys per page — `<directory>/<stem>` and `<directory>/<slugify(stem)>` — so a
 * comparison is against a TITLE and never against `undefined`. The two forms are the
 * same page: `7. Subdominios DDD` on disk is emitted as `concepts/7-subdominios-ddd`.
 *
 * A COLLISION throws instead of overwriting. If two seeded pages answered to one key, the
 * comparison would be a value compared with itself — a tautology, which is worse than no
 * test — so this file's seed is kept free of collisions on purpose and a future seed that
 * introduces one fails loudly here rather than going quiet.
 *
 * @param pages - The seed, as written to disk.
 * @returns Id -> title for both emitted forms of every page.
 */
function expectedTitles(pages: Seeded[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const page of pages) {
    for (const id of [`${page.directory}/${page.stem}`, `${page.directory}/${slugify(page.stem)}`]) {
      const known = titles.get(id);
      if (known !== undefined && known !== page.title) {
        throw new Error(`two seeded pages answer to ${id}: ${known} and ${page.title}`);
      }
      titles.set(id, page.title);
    }
  }
  return titles;
}

/**
 * One failure string, or null when `id` resolves to the page the seed says it names.
 *
 * An id the seed does not contain is a failure too: otherwise a lookup that returned
 * `undefined` for both sides would read as agreement.
 *
 * @param root - Project root the read path runs against.
 * @param expected - Id -> title, from {@link expectedTitles}.
 * @param id - An id the machinery emitted.
 * @param label - Which emitter produced it, for the failure message.
 * @returns The failure, or null.
 */
async function mismatch(
  root: string,
  expected: Map<string, string>,
  id: string,
  label: string,
): Promise<string | null> {
  const want = expected.get(id);
  if (want === undefined) return `${label}: unexpected id ${id}`;
  const record = await readPageRecord(root, id);
  if (record?.title === want) return null;
  return `${label}: ${id} -> ${record?.title ?? "null"} (expected ${want})`;
}

/**
 * Every emitted id that fails to resolve back to the page it names.
 *
 * @param root - Project root.
 * @param seeded - The seed the ids were emitted for.
 * @returns One line per failure; empty when the round trip holds.
 */
async function emittedIdFailures(root: string, seeded: Seeded[]): Promise<string[]> {
  const expected = expectedTitles(seeded);
  const failures: string[] = [];
  const check = async (id: string, label: string) => {
    const failure = await mismatch(root, expected, id, label);
    if (failure !== null) failures.push(failure);
  };
  for (const entry of (await collectAnswerCitationIndex(root)).retained) await check(entry.id, "index id");
  for (const page of seeded) {
    for (const ref of pageLinkRefs(page.body ?? "")) await check(ref.slug, `link from ${page.directory}/${page.stem}`);
  }
  for (const page of await collectViewerPages(root)) {
    await check(page.id, "viewer id");
    for (const out of page.outgoingLinks) await check(out, `viewer out from ${page.id}`);
  }
  return failures;
}

describe("read_page follows the identities query_wiki emits (S7)", () => {
  it("resolves a qualified id against a title-shaped stem, confined to its namespace", async () => {
    const root = await makeStack([{ directory: "concepts", stem: "7. Subdominios DDD", title: "Seven" }]);
    expect((await readPageRecord(root, "concepts/7-subdominios-ddd"))?.title).toBe("Seven");
    expect((await readPageRecord(root, "concepts/7. Subdominios DDD"))?.title).toBe("Seven");
    expect(await readPageRecord(root, "queries/7-subdominios-ddd")).toBeNull();
    expect(await readPageRecord(root, "concepts/nope")).toBeNull();
    expect(await readPageRecord(root, "concepts/")).toBeNull();
  });

  it("resolves every id the machinery emits back to the page it names", async () => {
    const concepts = ["attention", "test2", "rbac-por-oficina", "7. Subdominios DDD", "2024 Recap", "東京 Café"];
    const queries = ["how-does-attention-work", "6. Query Titled"];
    const seeded: Seeded[] = [
      ...concepts.map((stem, i) => ({ directory: "concepts", stem, title: `Concept ${i}`,
        body: `Concept ${i}, pointing at [[concepts/${concepts[(i + 1) % concepts.length]}]] .` })),
      ...queries.map((stem, i) => ({ directory: "queries", stem, title: `Query ${i}`,
        body: `Query ${i}, pointing at [[queries/${queries[(i + 1) % queries.length]}]] .` })),
    ];
    const root = await makeStack(seeded);

    expect(await emittedIdFailures(root, seeded)).toEqual([]);
  }, 60_000);

  it("pins the documented residual: the BARE form does not slugify", async () => {
    const root = await makeStack([{ directory: "concepts", stem: "7. Subdominios DDD", title: "Seven" }]);
    expect(await readPageRecord(root, "7-subdominios-ddd")).toBeNull();
    const report = await reportAnswerCitations(root, "Grounded in [[7-subdominios-ddd]].");
    expect(report.citations).toEqual([{ target: "7-subdominios-ddd", status: "resolved", pageId: "concepts/7. Subdominios DDD" }]);
  });
});

/**
 * Covers S7. This seed is the only place the slugified qualified path is exercised: the
 * index (`packages/wiki/src/citations/answer-index.ts:36`) and viewer
 * (`packages/wiki/src/viewer/collect.ts:217`) ids carry the RAW stem, and only
 * `pageLinkRefs` (`packages/wiki/src/pages/read.ts:82`) slugifies. Without this pin,
 * dropping the title-shaped pages from the seed would leave the property green while
 * covering nothing this branch fixed.
 */
it("keeps the slugified leg under test: the link emitter slugifies, the read path follows", async () => {
  const seeds = [
    ["concepts", "7. Subdominios DDD", "concepts/7-subdominios-ddd"],
    ["concepts", "2024 Recap", "concepts/2024-recap"],
    ["concepts", "東京 Café", "concepts/東京-café"],
    ["queries", "6. Query Titled", "queries/6-query-titled"],
  ] as const;
  const root = await makeStack(seeds.map(([directory, stem], i) => ({ directory, stem, title: `Slug ${i}` })));
  for (const [i, [directory, stem, id]] of seeds.entries()) {
    expect(pageLinkRefs(`see [[${directory}/${stem}]]`).map((ref) => ref.slug)).toEqual([id]);
    expect((await readPageRecord(root, id))?.title).toBe(`Slug ${i}`);
  }
});
