/**
 * @file Guard: no user-visible runtime string may advertise a removed `llmwiki <subcommand>`.
 *
 * ## Why this guard exists
 *
 * No `package.json` in this repository declares a `bin`, and the only launcher is
 * `dist/api.js` — built from `packages/api/src/main.ts` and `exec`'d by
 * `docker/entry.sh`. That entry is a SERVER: it starts the host/viewer/MCP process and
 * accepts no subcommands. So every `llmwiki review`, `llmwiki compile`, `llmwiki query …`
 * a string tells a user or an agent to type is an instruction to run something that does
 * not exist. The reviewer's ruling on the review family was final — review does not come
 * back, nothing of review — so the fix is never to re-add the capability, and never to
 * soften the lie into a vaguer one: where a string cannot be made true, the advert is
 * deleted.
 *
 * ## Scope: the whole source tree, not a hand-maintained list
 *
 * The first version of this guard scanned six explicit files. A guard named "no removed
 * CLI adverts" that inspects 6 of ~488 source files makes a claim about itself it cannot
 * support: a green run meant "these six are clean", and a seventh file could carry the
 * same advert forever. This version walks every first-party package root this repository
 * ships — `packages/wiki/src`, `packages/api/src`, and the whole of
 * `packages/llmwiki-core` — recursively, and reads every `.ts`, `.js`, `.css` and `.sql`
 * file in them. The adverts live in MCP tool payloads, terminal report lines, doc
 * comments, SQL migration headers and browser assets that no unit test renders; a text
 * scan is the only assertion that covers all of those shapes at once, and it costs
 * milliseconds because nothing is built, spawned, or rendered.
 *
 * `.sql` was left outside that walk for one commit, and the omission was not cosmetic: a
 * migration header explained the job table by naming two processes that no longer exist
 * as subcommands. A guard that claims to cover the tree inherits the same defect as the
 * string it hunts the moment it draws the boundary by extension instead of by "can a
 * user read this?". A migration header is read by every maintainer who opens the file.
 *
 * `packages/llmwiki-core` was the third such area, and it failed the same way for the same
 * reason: the boundary was drawn at `src` subtrees. A published package's build config is
 * a `.ts` file at the PACKAGE root (`packages/llmwiki-core/tsup.config.ts`), so every walk
 * that named a `src/` directory left it unread — and it carried a live advert, a comment
 * explaining why the MCP SDK is external that ended "which is how it already runs under
 * `llmwiki serve`". Build-config comments are read by every integrator who opens the
 * package, which makes them the same class of surface as a doc comment, not a lesser one.
 * The root for that package is therefore the package directory itself.
 *
 * `dist` is skipped for exactly one reason: it is gitignored build output, so a walk that
 * read it would report a file count, and a verdict, that depend on whether this working
 * tree happened to be built. Nothing authored escapes by that exclusion — `dist` is
 * regenerated from the source these roots already cover, by the very build config the scan
 * now reads (`clean: true`, and an `onSuccess` asset copy out of
 * `packages/wiki/src/viewer/assets`, itself inside a scanned root).
 *
 * ## Why the pattern names subcommands instead of accepting any lowercase word
 *
 * The obvious widening — `/llmwiki\s+[a-z]/` — does NOT work at tree scale. That pattern
 * matches the product noun in true prose (`the llmwiki knowledge compiler`, and any
 * `.llmwiki lock` because `.` is not a word character and `\s+` then matches). Sweeping
 * those would mean rewording statements that are simply true, and once one true sentence
 * has to be reworded to satisfy a regex, the regex has become an allow-list with extra
 * steps — the exact failure this guard exists to prevent.
 *
 * So the pattern below names the subcommands the retired binary actually accepted:
 * `compile`, `query`, `ingest`, `lint`, `review`, `view`, `export`, `import`,
 * `quickstart`, `workflow`, `next`, `recover`, `eval`, `serve`, `host`. Those tokens after
 * `llmwiki ` are adverts by construction — no sentence in this repository needs to say
 * "llmwiki compile" for any other reason — while the product noun and the dot-paths are
 * left alone. The listed words are the entire removed surface; a new subcommand cannot
 * appear without a deliberate edit here.
 *
 * `host` is in the list even though the server entry still HAS a `host` mode: what is
 * retired is the binary name in front of it. `llmwiki host` instructs a reader to run an
 * executable no package ships, and the mode is reachable through the launcher, not
 * through that word. Leaving it out while catching `llmwiki serve` would have been the
 * same extension-shaped gap that `.sql` was: one live advert kept out by a list that
 * looked complete.
 *
 * ## Why comments are in scope
 *
 * A doc comment that says "reviewers approve via `llmwiki review`" is the same lie in a
 * quieter place: it tells the next maintainer the surface exists, and they will
 * re-introduce it. The scan therefore has no opinion about string literals — it reads
 * every line of the file.
 *
 * ## Why a green run over a swept tree proves nothing on its own
 *
 * "Found nothing" and "looked nowhere" are indistinguishable, so the inventory is
 * asserted non-vacuous (a real count, one contributing file per root, no empty reads) and
 * the pattern is exercised in BOTH directions on inline samples: it must still catch every
 * true advert shape, and it must leave the negative neighbours alone, so nobody re-widens
 * it to force a file through.
 *
 * The historical proof is out of band. Measured with this exact walk and this exact
 * pattern, the base commit this feature started from (`0cecbee5`) carried 137 offenders:
 * 488 paths walked, 487 readable — `packages/wiki/src/mcp/tool-names.ts` does not exist at
 * that commit — of which 12 are `.sql`. Two of the 137 were in `.sql`
 * (`dimensions/wiki/migration_wiki_jobs.sql:13` `llmwiki serve` and `:14` `llmwiki host`,
 * the same sentence naming both retired processes) and one was in `packages/llmwiki-core`
 * (`tsup.config.ts:29`). Every narrower scope reported a smaller number, and each was a
 * lie of omission: `.ts`/`.js`/`.css` only reported 132 offenders across 474 files, which
 * left the two `.sql` adverts unread; catching `serve` without `host` reported 133, which
 * left the second one unread; and stopping the walk at `src` subtrees reported 136 across
 * 487 files, which left a published package's build config unread. This tree now walks
 * 488 files (12 of them `.sql`) and reports 0. The tree was never clean, it was
 * unexamined.
 *
 * That run is deliberately NOT part of this file — a committed test must not read git
 * history, or it fails for anyone without those commits and passes for the wrong reason.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Repository root, resolved from this file's location so the walk is cwd-independent. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The source roots every scanned file lives under, repository-relative.
 *
 * Each root is asserted to contribute at least one file: a walker bug that silently drops
 * a root would otherwise read as a clean tree. `packages/llmwiki-core` is listed as a
 * whole package rather than a subtree because its build config sits at the package root;
 * see the scope note above.
 */
const SCAN_ROOTS = ["packages/wiki/src", "packages/api/src", "packages/llmwiki-core"] as const;

/** File types whose contents a user or an agent can end up reading. */
const SCAN_EXTENSIONS = new Set([".ts", ".js", ".css", ".sql"]);

/**
 * Directories that can never contain authored, first-party source: vendored dependencies,
 * and build output (`dist`), which is regenerated from what these roots already cover. A
 * walk that read `dist` would report a count and a verdict that depend on whether the tree
 * was built; see the scope note above.
 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

/**
 * A removed CLI subcommand advertised after the binary name.
 *
 * Shared with a global copy used by `matchAll`, which is reset per line so no `lastIndex`
 * state leaks between files and one line carrying two adverts reports both.
 */
const REMOVED_SUBCOMMAND_PATTERN =
  /llmwiki\s+(compile|query|ingest|lint|review|view|export|import|quickstart|workflow|next|recover|eval|serves?|host)\b/;

/** Global copy for `matchAll`; `findAdverts` resets it per line. */
const ADVERT_PATTERN_GLOBAL = new RegExp(REMOVED_SUBCOMMAND_PATTERN.source, "g");

/**
 * Every scanned production file under `relative`, repository-relative.
 *
 * @param relative - Repository-relative directory to walk.
 * @returns Paths of the `.ts`, `.js`, `.css` and `.sql` files found beneath it.
 */
async function listScannedFiles(relative: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(path.join(REPO_ROOT, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...(await listScannedFiles(child)));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(child);
    }
  }
  return found;
}

/**
 * Every advert in `text`, reported as `path:line: matched text — surrounding context`.
 *
 * The exact match comes first so the failure list is greppable; the surrounding context
 * follows because the reader of a failure needs to know WHICH string to fix — a
 * `nextAction`, a warning message, a doc comment, or a browser asset's caption — without
 * opening the file at that line.
 *
 * @param relative - Path used as the report prefix.
 * @param text - File contents to scan.
 * @returns One entry per match, in file order.
 */
function findAdverts(relative: string, text: string): string[] {
  const offenders: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    ADVERT_PATTERN_GLOBAL.lastIndex = 0;
    for (const match of line.matchAll(ADVERT_PATTERN_GLOBAL)) {
      const context = line.slice(Math.max(0, match.index - 20), match.index + 40).trim();
      offenders.push(`${relative}:${index + 1}: ${match[0]} — ${context}`);
    }
  }
  return offenders;
}

/**
 * The full scanned inventory: every source file this guard covers.
 *
 * @returns Repository-relative paths of the scanned files.
 */
async function scannedTree(): Promise<string[]> {
  return (await Promise.all(SCAN_ROOTS.map(listScannedFiles))).flat();
}

/**
 * Every advert in the whole scanned tree, as report lines.
 *
 * @returns `path:line: matched text — context` for each advert, in walk order.
 */
async function scanTree(): Promise<string[]> {
  const files = await scannedTree();
  const offenders: string[] = [];
  for (const file of files) {
    offenders.push(...findAdverts(file, await readFile(path.join(REPO_ROOT, file), "utf8")));
  }
  return offenders;
}

/**
 * Assert the inventory is a real tree, not an empty walk that would read as clean.
 *
 * A count floor, one contributing file per root, and no empty reads: any of these failing
 * means the guard looked nowhere, which is indistinguishable from a clean tree unless it
 * is asserted.
 */
async function assertRealInventory(): Promise<void> {
  const files = await scannedTree();
  expect(files.length, `only ${files.length} files found; the walk is not covering the tree`).toBeGreaterThan(100);
  for (const root of SCAN_ROOTS) {
    expect(files, `no file scanned under ${root}`).toContainEqual(expect.stringContaining(`${root}${path.sep}`));
  }
  const unreadable: string[] = [];
  for (const file of files) {
    if ((await readFile(path.join(REPO_ROOT, file), "utf8")).length === 0) unreadable.push(file);
  }
  expect(unreadable, `scanned files resolved to an empty read: ${unreadable.join(", ")}`).toEqual([]);
}

describe("no runtime string advertises a removed `llmwiki <subcommand>`", () => {
  it("still catches every true advert shape", () => {
    expect(findAdverts("x.ts", "Next: llmwiki compile")).toHaveLength(1);
    expect(findAdverts("x.ts", "then run llmwiki review approve <id>")).toHaveLength(1);
    expect(findAdverts("x.ts", "$ llmwiki view --open")).toHaveLength(1);
    expect(findAdverts("x.ts", "run `llmwiki recover` to rebuild the index")).toHaveLength(1);
    // Two adverts on one line report twice, so a single count cannot hide a second.
    expect(findAdverts("x.ts", "llmwiki ingest then llmwiki lint")).toHaveLength(2);
    // `serve` is the launcher that used to exist as a subcommand and no longer does.
    expect(findAdverts("x.ts", "start with llmwiki serve")).toHaveLength(1);
    // `host` is retired as a SUBCOMMAND while the mode survives, so the binary name in
    // front of it is still an instruction to run something that does not exist.
    expect(findAdverts("x.ts", "start with llmwiki host")).toHaveLength(1);
  });

  it("leaves the product noun, dot-paths and schema keys alone", () => {
    // Pinned so nobody re-widens the pattern to `/llmwiki\s+[a-z]/` and forces true prose
    // to be reworded: every one of these statements is correct and stays legal.
    expect(findAdverts("x.ts", "Candidates live under `.llmwiki/candidates/`.")).toEqual([]);
    expect(findAdverts("x.ts", "the `x-llmwiki.citations` frontmatter key")).toEqual([]);
    expect(findAdverts("x.ts", "Citation coverage for the llmwiki knowledge compiler.")).toEqual([]);
    expect(findAdverts("x.ts", "Owns the `.llmwiki` lock.")).toEqual([]);
    expect(findAdverts("x.ts", "`llmwiki.css` is the viewer stylesheet")).toEqual([]);
    expect(findAdverts("x.ts", "the llmwiki viewer process")).toEqual([]);
  });

  it("scans a real, non-trivial tree (the guard is not vacuous)", async () => {
    await assertRealInventory();
  });

  it("finds no removed-subcommand advert under any scanned root", async () => {
    const offenders = await scanTree();

    expect(offenders, `${offenders.length} removed-subcommand advert(s):\n${offenders.join("\n")}`).toEqual([]);
  });
});
