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
 * CLI adverts" that inspects 6 of ~475 source files makes a claim about itself it cannot
 * support: a green run meant "these six are clean", and a seventh file could carry the
 * same advert forever. This version walks `packages/wiki/src` and `packages/api/src`
 * recursively and reads every `.ts`, `.js` and `.css` file in them. The adverts live in
 * MCP tool payloads, terminal report lines, doc comments and browser assets that no unit
 * test renders; a text scan is the only assertion that covers all of those shapes at
 * once, and it costs milliseconds because nothing is built, spawned, or rendered.
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
 * `quickstart`, `workflow`, `next`, `recover`, `eval`, `serve`. Those tokens after
 * `llmwiki ` are adverts by construction — no sentence in this repository needs to say
 * "llmwiki compile" for any other reason — while the product noun and the dot-paths are
 * left alone. The listed words are the entire removed surface; a new subcommand cannot
 * appear without a deliberate edit here.
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
 * The historical proof is out of band: at the base commit this feature started from
 * (`0cecbee5`), the same pattern over the same walk reported 132 offenders across 474
 * files. That run is deliberately NOT part of this file — a committed test must not read
 * git history, or it fails for anyone without those commits and passes for the wrong
 * reason.
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
 * Both are asserted to contribute at least one file: a walker bug that silently drops a
 * root would otherwise read as a clean tree.
 */
const SCAN_ROOTS = ["packages/wiki/src", "packages/api/src"] as const;

/** File types whose contents a user or an agent can end up reading. */
const SCAN_EXTENSIONS = new Set([".ts", ".js", ".css"]);

/** Directories that can never contain first-party source, skipped so the walk stays cheap. */
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

/**
 * A removed CLI subcommand advertised after the binary name.
 *
 * Shared with a global copy used by `matchAll`, which is reset per line so no `lastIndex`
 * state leaks between files and one line carrying two adverts reports both.
 */
const REMOVED_SUBCOMMAND_PATTERN =
  /llmwiki\s+(compile|query|ingest|lint|review|view|export|import|quickstart|workflow|next|recover|eval|serves?)\b/;

/** Global copy for `matchAll`; `findAdverts` resets it per line. */
const ADVERT_PATTERN_GLOBAL = new RegExp(REMOVED_SUBCOMMAND_PATTERN.source, "g");

/**
 * Every scanned production file under `relative`, repository-relative.
 *
 * @param relative - Repository-relative directory to walk.
 * @returns Paths of the `.ts`, `.js` and `.css` files found beneath it.
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

  it("finds no removed-subcommand advert under either source root", async () => {
    const offenders = await scanTree();

    expect(offenders, `${offenders.length} removed-subcommand advert(s):\n${offenders.join("\n")}`).toEqual([]);
  });
});
