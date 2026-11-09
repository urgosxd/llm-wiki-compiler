# Feature: artifact-guard-barrel-decouple

Two silent-failure paths closed by plumbing that does not depend on how the CLI decision lands:
automate the `@repo/*` externalization guard as a test, decouple the MCP server from the
`compiler-cli` barrel, and add an in-process proof that the published entries evaluate.
Branch: `fix/artifact-guard-and-barrel-decouple`. Base commit: `5bac26b21b924b4c40afead4374906fc69bd565f`.

## Specs

Spec IDs are `S1`–`S15`; task IDs are `T1`–`T5` from the `## Tasks` table. Every spec below quotes the
human's request verbatim; any line marked `Consequence:` is derived from the quote and is secondary.

### Piece 1 — automate the artifact specifier guard

S1. RECURSIVE SCOPE IS THE POINT. "Walk **recursively** over `dist/**/*.js` **and** `packages/llmwiki-core/dist/**/*.js`. The current manual grep is `dist/*.js` — non-recursive and root-only — so it never inspects the package that actually externalizes (`express`, `@modelcontextprotocol/sdk`, `@hono/node-server`, `mammoth`). The recursive scope is the point."

Consequence: the deliverable is `test/artifact/dist-specifiers.test.ts`, and the collected set must be the union of both trees, walked recursively. A guard that inspects only root `dist/*.js` reproduces the manual grep's blind spot and does not satisfy this spec, whatever else it asserts. The manual grep it automates is "`grep -o '@repo/[a-z-]*' dist/*.js` — and it exists only as prose in `odd/tasks/*.md`. **No script, no npm script, no workflow step, no hook, no test.**" It has caught two real failures by hand (`odd/tasks/package-split.md:97` and `:123`), "a private package externalized into a broken `dist` with every fast gate green, twice" — the Risk item 6 reach this test exists to close.

S2. FAIL CLOSED. "**Fail closed**: assert the collected file set is non-empty first. A guard that passes because it found nothing to check is the failure mode this whole repo keeps rediscovering."

Consequence: the non-empty assertion on the collected file set is the first assertion in the test, and it fails the test rather than skipping it.

S3. ZERO PRIVATE SPECIFIERS. "Assert zero matches for `/@repo\//`."

Consequence: the pattern is `/@repo\//` exactly, matched over the recursively collected file set, and the assertion is zero matches.

S4. THE GUARD MUST BITE, AND THE BUILD IS ITS PRECONDITION. "Prove it **bites**: on a scratch copy, inject `import "@repo/kg"` into one collected bundle file and show the test failing with a message naming the file and specifier; restore and prove byte-identity by sha256. If `dist/` is absent in your first run, build it — but say in the report that the guard's own precondition is "the build has run", and make the test state that in its failure message rather than passing."

Consequence: four separate obligations. (a) The injection is `import "@repo/kg"` into one collected bundle file, performed on a scratch copy, not on the worktree. (b) The observed failure message names both the file and the specifier. (c) Restoring is proven byte-identical by sha256. (d) The guard's own precondition is "the build has run", and when `dist/` is absent the test states that in its failure message instead of passing.

### Piece 2 — decouple the MCP server from the `compiler-cli` barrel

S5. THE FOUR FILES AND THE REWRITE TARGET. "Four MCP files import through the `@atomicstrata/llmwiki-core/compiler-cli` barrel: `packages/wiki/src/mcp/tools.ts:13-48`, `mcp/okf-tools.ts:5-8`, `mcp/resources.ts:12-21`, `mcp/wiki-read-tools.ts:28-44`. `compiler-cli.ts:7-102` eagerly re-exports ~133 symbols from ~50 modules, so **every module reached by the CLI barrel also loads inside the MCP server process** — and the cycle is documented in-source at `host/mcp-http.ts:22-24`."

Consequence: exactly these four files are rewritten to "import from the **defining modules** instead of the barrel". The four paths, quoted verbatim, are `packages/wiki/src/mcp/tools.ts:13-48`, `mcp/okf-tools.ts:5-8`, `mcp/resources.ts:12-21`, `mcp/wiki-read-tools.ts:28-44`; the last three are relative to `packages/wiki/src/`.

S6. THE MAPPING IS RE-VERIFIED, NOT TRUSTED. "**Re-verify the symbol→module mapping yourself** with your own grep; do not trust the list above. An independent recon on this exact point was internally sloppy and cited a line number inside a file that has 142 lines — trust the grep, not the summary."

Consequence: the module each consumed symbol is imported from is established by the writer's own grep of the defining modules. A mapping copied from the request's list is not evidence, and a supplied list that disagrees with the grep loses.

S7. TYPE-ONLY STAYS TYPE-ONLY. "Imports must be **type-only where they were type-only**. Do not turn a type import into a value import."

Consequence: an `import type` binding stays `import type` after the specifier changes. Turning one into a runtime import is a failure of this spec even when the tests pass.

S8. NO BEHAVIOUR CHANGE, NO TEST EDITS, AND THE REWRITE IS WHAT IS WRONG. "**No behaviour change, no test edits.** If a test breaks, the rewrite is wrong — fix the rewrite."

Consequence: the fix surface for a broken test is the rewrite, never the test. Editing a test to accommodate the import rewrite is prohibited (see S13).

S9. ACCEPTANCE AND THE COUNTS. "Acceptance: `packages/wiki/src/mcp/**` no longer names `@atomicstrata/llmwiki-core/compiler-cli`, and the MCP tests still pass. Report the before/after import counts for those four files."

Consequence: two acceptance conditions, both measurable: a grep over `packages/wiki/src/mcp/**` returns nothing for `@atomicstrata/llmwiki-core/compiler-cli`, and the MCP tests pass. The report carries the before and after import counts for each of the four files.

### Piece 3 — in-process import proof for the published entries

S10. FOUR ENTRIES, LOADED IN PROCESS. "`test/cli.test.ts:58-62` proves the shipped bundle evaluates by spawning it. That guard dies with the CLI. Add `test/artifact/entries-load.test.ts`: `await import()` each published entry (`llm-wiki-compiler`, `@atomicstrata/llmwiki-core`, `@atomicstrata/llmwiki-core/compiler-sdk`, `@atomicstrata/llmwiki-core/compiler-cli`) and assert the expected exports are the expected kinds. Those chains reach `mammoth`, `express` and the streamable-HTTP MCP chunk, so they catch the externalization and value-import classes in-process."

Consequence: the file is `test/artifact/entries-load.test.ts`; the four entries are `llm-wiki-compiler`, `@atomicstrata/llmwiki-core`, `@atomicstrata/llmwiki-core/compiler-sdk`, `@atomicstrata/llmwiki-core/compiler-cli`; each is loaded with `await import()`; the assertions are on the expected exports being the expected kinds. The reach that makes the proof possible is `mammoth`, `express` and the streamable-HTTP MCP chunk.

S11. THE NON-CLAIM, STATED PLAINLY. "State plainly in the report **what this does not prove**: no argv, no exit code, no stdout contract, no shebang. It complements Piece 1, it does not replace the spawn guard."

Consequence: the report names all four non-claims — no argv, no exit code, no stdout contract, no shebang — and states that the new test complements Piece 1 rather than replacing the spawn guard at `test/cli.test.ts:58-62`.

### Envelope, gates, prohibitions and report

S12. GATES. "`gates:static` · `tsc --noEmit` · `typecheck:tests` · `lint` (**643/466/496 ceiling; literal triple**) · `build` · `fallow:ci` · `fallow:kg` · **`pnpm test` in full, alone** · `test:pack`."

Consequence: nine gates, each reported with its exit code. The lint ceiling is the literal triple `643/466/496`. `pnpm test` runs in full and alone.

S13. HARD PROHIBITIONS. "No deleting the CLI, no `bin` change, no Dockerfile or `docker/entry.sh` change, no test edits to accommodate the import rewrite, no history rewriting (no `git reset`; use a fixup commit), no push, no `--no-verify`, no `HUSKY=0`. No `cp -a` of this worktree. `odd/tasks/**` append-only."

Consequence: nine prohibitions, each individually checkable. History repair is a fixup commit, never `git reset`. The worktree is not copied with `cp -a` — the `package-split.md` verifier incident (a `.git` pointer file operating on the shared gitdir) is the reason.

S14. WHAT THE REPORT MUST CONTAIN. "The recursive scope and the fail-closed assertion; the bite proof with its message and sha256; the symbol→module re-verification for the four MCP files and their before/after import counts; what the in-process proof does not cover; every gate exit with the literal lint triple; full-suite counts and duration; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line using item 1 data/irreversible, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery/environment, 6 no test would catch a regression — or `Risk: none`. This slice exists to reduce item 6, so say how it does."

Consequence: nine report items plus the risk line plus one sentence explaining how the slice reduces item 6. Commit SHAs are 40 characters, never abbreviations.

S15. SCOPE ENVELOPE. "Two pieces of plumbing that are needed regardless of how the CLI decision lands, both of which remove a known silent-failure path. No product behaviour changes."

Consequence: the work is plumbing that survives every CLI decision, and "no product behaviour changes" is a boundary on the whole slice — S9's no-behaviour-change rule for Piece 2 and the gates in S13 are its enforcement, not an addition to it.

## Tasks

| ID | linked S# | route | commit |
| --- | --- | --- | --- |
| T1 (done) — this feature document | none | worker | (this commit) |
| T2 (done) — Piece 2, the MCP barrel decoupling (`packages/wiki/src/mcp/**`) | S5-S9 | worker | e00b838534bb6a3ed8a7e827399e6867ad3cd6c0 |
| T3 — Piece 1, `test/artifact/dist-specifiers.test.ts` | S1-S4 | worker | pending |
| T4 (done) — Piece 3, `test/artifact/entries-load.test.ts` | S10-S11 | worker | e5ef03da7b78d35de26a2ad5983646469fd11ff9 + fixup (this commit) |
| T5 — independent verification of T2-T4 plus the full gate set | S12-S15 | verify | pending |

T1 is done because this file is its deliverable. The commit column of T1 reads `(this commit)`
because a commit cannot contain its own hash; T4 carries its original SHA plus the fixup commit that
follows it, and the SHAs are reported in the implementation handoff.

## Log

L1 (original request, verbatim — the source of every `S#` above):

```
Project assignment for branch fix/artifact-guard-and-barrel-decouple:

Two pieces of plumbing that are needed regardless of how the CLI decision lands, both of which remove a known silent-failure path. No product behaviour changes.

Repo: llm-wiki-compiler, `main` at **`5bac26b21b924b4c40afead4374906fc69bd565f`**. Read `AGENTS.md` first. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. pnpm; if bare `pnpm` answers 127, use `corepack pnpm`. `maxWorkers` is pinned at 4 (~500 s suite). `test:affected` exits **78** when the scope resolves to the full tier — expected, not a failure.

## Piece 1 — automate the artifact specifier guard (it has never been automated)
The repo's guard against a private workspace package being **externalized** into the shipped bundle is `grep -o '@repo/[a-z-]*' dist/*.js` — and it exists only as prose in `odd/tasks/*.md`. **No script, no npm script, no workflow step, no hook, no test.** A human runs it when someone remembers. It has caught two real failures by hand (`odd/tasks/package-split.md:97` and `:123`: a private package externalized into a broken `dist` with every fast gate green, twice).

Write `test/artifact/dist-specifiers.test.ts`:
- Walk **recursively** over `dist/**/*.js` **and** `packages/llmwiki-core/dist/**/*.js`. The current manual grep is `dist/*.js` — non-recursive and root-only — so it never inspects the package that actually externalizes (`express`, `@modelcontextprotocol/sdk`, `@hono/node-server`, `mammoth`). The recursive scope is the point.
- **Fail closed**: assert the collected file set is non-empty first. A guard that passes because it found nothing to check is the failure mode this whole repo keeps rediscovering.
- Assert zero matches for `/@repo\//`.
- Prove it **bites**: on a scratch copy, inject `import "@repo/kg"` into one collected bundle file and show the test failing with a message naming the file and specifier; restore and prove byte-identity by sha256. If `dist/` is absent in your first run, build it — but say in the report that the guard's own precondition is "the build has run", and make the test state that in its failure message rather than passing.

## Piece 2 — decouple the MCP server from the `compiler-cli` barrel
Four MCP files import through the `@atomicstrata/llmwiki-core/compiler-cli` barrel: `packages/wiki/src/mcp/tools.ts:13-48`, `mcp/okf-tools.ts:5-8`, `mcp/resources.ts:12-21`, `mcp/wiki-read-tools.ts:28-44`. `compiler-cli.ts:7-102` eagerly re-exports ~133 symbols from ~50 modules, so **every module reached by the CLI barrel also loads inside the MCP server process** — and the cycle is documented in-source at `host/mcp-http.ts:22-24`.

Measured: **no module reached only through that barrel defines a single symbol the MCP surface consumes**; every symbol they take lives in a SHARED module (`dimensions/wiki/page-source-seam.ts`, `compiler/index.ts`, `context/build.ts`, `linter/index.ts`, `status/collect.ts`, `search/retrieval.ts`, `pages/list.ts`, `pages/read.ts`, `profile/{block,identity}.ts`, `utils/provider-guard.ts`, `commands/ingest.ts`, `commands/query.ts`, `eval/index.ts`, `export/okf/run.ts`, `import/run.ts`, `utils/output.ts`, `utils/path-confine.ts`, `eval/stats.ts`, `sources/scan.ts`, `utils/constants.ts`, `utils/markdown.ts`).

Rewrite those four files to import from the **defining modules** instead of the barrel. Requirements:
- **Re-verify the symbol→module mapping yourself** with your own grep; do not trust the list above. An independent recon on this exact point was internally sloppy and cited a line number inside a file that has 142 lines — trust the grep, not the summary.
- Imports must be **type-only where they were type-only**. Do not turn a type import into a value import.
- **No behaviour change, no test edits.** If a test breaks, the rewrite is wrong — fix the rewrite.
- Acceptance: `packages/wiki/src/mcp/**` no longer names `@atomicstrata/llmwiki-core/compiler-cli`, and the MCP tests still pass. Report the before/after import counts for those four files.

## Piece 3 — in-process import proof for the published entries
`test/cli.test.ts:58-62` proves the shipped bundle evaluates by spawning it. That guard dies with the CLI. Add `test/artifact/entries-load.test.ts`: `await import()` each published entry (`llm-wiki-compiler`, `@atomicstrata/llmwiki-core`, `@atomicstrata/llmwiki-core/compiler-sdk`, `@atomicstrata/llmwiki-core/compiler-cli`) and assert the expected exports are the expected kinds. Those chains reach `mammoth`, `express` and the streamable-HTTP MCP chunk, so they catch the externalization and value-import classes in-process.
State plainly in the report **what this does not prove**: no argv, no exit code, no stdout contract, no shebang. It complements Piece 1, it does not replace the spawn guard.

## Gates
`gates:static` · `tsc --noEmit` · `typecheck:tests` · `lint` (**643/466/496 ceiling; literal triple**) · `build` · `fallow:ci` · `fallow:kg` · **`pnpm test` in full, alone** · `test:pack`.

## Hard prohibitions
No deleting the CLI, no `bin` change, no Dockerfile or `docker/entry.sh` change, no test edits to accommodate the import rewrite, no history rewriting (no `git reset`; use a fixup commit), no push, no `--no-verify`, no `HUSKY=0`. No `cp -a` of this worktree. `odd/tasks/**` append-only.

## Report
The recursive scope and the fail-closed assertion; the bite proof with its message and sha256; the symbol→module re-verification for the four MCP files and their before/after import counts; what the in-process proof does not cover; every gate exit with the literal lint triple; full-suite counts and duration; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line using item 1 data/irreversible, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery/environment, 6 no test would catch a regression — or `Risk: none`. This slice exists to reduce item 6, so say how it does.
```
