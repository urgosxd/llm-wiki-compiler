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

S3. ZERO PRIVATE SPECIFIERS IN IMPORT POSITION, PLUS A TOTAL RATCHET. "Assert zero matches for `/@repo\//`."

Ruled form (Manager ruling, recorded verbatim as L2): assert zero `/@repo\//` occurrences in **import
position** across `dist/**/*.js` **and** `packages/llmwiki-core/dist/**/*.js`, fail-closed on an empty
file set; ratchet the total `/@repo\//` occurrence count at the measured baseline, failing on any
increase. The reason for the pin is a comment on the pin itself, naming
`packages/wiki/src/commands/host.ts:76`, and stating that the pin must be lowered to 0 when that file
leaves with the CLI removal.

Consequence: the pattern is `/@repo\//`, matched over the recursively collected file set of both roots.
A literal zero-match over the whole text is RED at base for a class this guard was never about —
`commands/host.ts:76`'s `require("../../package.json")` makes esbuild inline the private `@repo/wiki`
manifest as dead data, which never touches module resolution. The guard exists for
`import … from "@repo/kg"`, a specifier Node resolves to raw TypeScript at runtime. Import position is
therefore asserted at zero and the total is pinned, which keeps literal coverage and makes the
inlined-manifest class visible instead of excluded.

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
| T3 (done) — Piece 1, `test/artifact/dist-specifiers.test.ts` | S1-S4 | worker | (this commit) |
| T4 (done) — Piece 3, `test/artifact/entries-load.test.ts` | S10-S11 | worker | e5ef03da7b78d35de26a2ad5983646469fd11ff9 + fixup (this commit) |
| T5 (done) — independent verification of T2-T4 plus the full gate set | S12-S15 | verify | (no commit — verification) |
| T6 (done) — hardening: guard fail-open closed, stale cycle comments corrected, barrel absence pinned | S1-S4, S5-S9, S13 | worker | (this commit) |

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

L2 (Manager ruling on S3, verbatim — narrows S3 and keeps every other `S#` unchanged):

```
A, with one addition: the count ratchet must be lowered by the removal slice, and say so in the test's own comment.

Your diagnosis is right and it separates two classes the brief conflated. A literal zero-match is RED at base for a class the guard was never about: `commands/host.ts:76`'s `require("../../package.json")` makes esbuild inline the private `@repo/wiki` manifest as **dead data**, which never touches module resolution. The guard exists for `import … from "@repo/kg"` — a specifier Node resolves to raw TypeScript at runtime. Ratcheting the total while asserting zero **in import position** keeps literal coverage, makes the inlined-manifest class visible instead of excluded, and is idiomatic for this repo, which ratchets everywhere else.

**Rejected B, and for a reason specific to the schedule:** `packages/wiki/src/commands/host.ts` is **group A — slated for deletion** in the CLI-removal slice, and its `host` entry moves into `@repo/api`. Fixing its inlining now is work on a file that is about to move or die, and it touches how the published host reports its version — a consumer-visible value — which is exactly outside the envelope I set. So:

- Assert zero `@repo/` in **import position** across `dist/**/*.js` **and** `packages/llmwiki-core/dist/**/*.js`, fail-closed on an empty file set.
- Ratchet the total `@repo/` occurrence count at the measured baseline, failing on any increase.
- **Put the reason in a comment on the pin itself**: the current count exists because `commands/host.ts` inlines `packages/wiki/package.json`; when that file leaves with the CLI, the pin must be **lowered to 0**, and a future reader should learn that from the test rather than from an archaeology session. A frozen count with no explanation is how a ratchet becomes permanent.

Corrected figure for the record: `compiler-cli.ts` is 102 lines but its export statements span ~90 module specifiers, not the brief's rough "133 symbols from ~50 modules".
```

L3 (follow-up hardening — a decision and evidence record, not a quotation). This unit hardens T2-T4
with four approved fixes, all of which are consequences of the work above rather than new scope. The
three advisories raised against T2-T4 were ACCEPTED, none disputed:

1. **The fail-open path inside the fail-closed guard.** `test/artifact/dist-specifiers.test.ts`
   collected with `readdir(...).catch(() => [])`, so an unreadable subdirectory silently
   under-collected and only a wholly empty root tripped the assertion — the exact failure S2 exists to
   prevent, reproduced inside the thing meant to prevent it.
2. **Stale cycle comments.** Piece 2 removed the `mcp/tools.ts -> compiler-cli.ts` edge, and two
   comments still described it in the present tense (`commands/host.ts:78-82`,
   `host/mcp-http.ts:22-31`), which is change-caused doc drift: an explanation that is half-corrected
   is worse than neither.
3. **The static text guard's own blind spot.** No rationale stated that a specifier assembled at
   runtime is invisible to a text scan, and the detector also missed `require.resolve("@repo/kg")`
   and the backtick-quoted form.

The four fixes, each with its evidence:

- **Both comments corrected together, comment text only.** Zero code, import or export change in
  either file, confirmed by a `git diff` in which every added and removed line is a `//` or ` *`
  line; neither file contains the literal `@repo/`, and after the rebuild the total pin is still 2, so
  nothing reached the bundle. The history is preserved rather than denied: the cycle WAS real, it is
  why the factory is injected, the edge was removed when the MCP modules moved to defining-module
  imports, and the injected-factory decision still stands with belt as well as braces.
- **The fail-open path closed.** Only a genuinely absent ROOT yields an empty list (`ENOENT` whose
  `path` is that root, both halves required); every other read failure throws and names the directory.
  Proven by three probes: an absent root yields `[]` and the fail-closed assertion then throws naming
  the root and the build command; a path that exists but is not a directory fails naming itself
  (`ENOTDIR`, portable, works as uid 0); a `chmod 000` directory fails naming itself (`EACCES`, run
  as uid 1000 here, skipped under uid 0 where the mode bits do not bind).
- **The limit documented, and the detector widened where it is cheap.** The file's rationale now
  states that a static text guard cannot see an assembled specifier such as `"@re" + "po/kg"`, that
  the total ratchet catches `"@repo/" + "kg"` because the literal survives, that the split form is
  caught by neither assertion, and that the runtime consequence is covered by
  `test/artifact/entries-load.test.ts`. The detector gained `require.resolve` (one alternation) and a
  backtick quote class; nothing else about it changed.
- **The barrel's absence pinned absolutely.** New `test/artifact/mcp-import-surface.test.ts`: zero
  `compiler-cli` import/export specifiers under `packages/wiki/src/mcp/`, recursively, fail-closed on
  an empty walk. The matcher PARSES specifiers and is not line-anchored, because the pre-rewrite
  barrel imports were multi-line and the specifier sat on a continuation line that `/^\s*import\b/`
  never matched — a naive draft was written first, observed to return `[]` for a synthetic multi-line
  barrel import and to miss the side-effect form, and replaced by the parse-based collector (shared
  from `test/fixtures/module-imports.ts`, not re-implemented). Parsing also makes the three
  explanatory prose mentions (`job-tools.ts:33,37`, `stack-tools.ts:27`) structurally invisible, so
  comments keep passing.

Measured-figure correction for the record, replacing two earlier figures quoted in the brief and in
L2's tail: `packages/wiki/src/compiler-cli.ts` is **102 lines** holding **77 `export … from` clauses
over 64 distinct modules**. The brief's "133 symbols from ~50 modules" was a SYMBOL count with a low
module count, and L2's "~90 module specifiers" was a grep of barrel *references across the tree*
(`grep -rn 'compiler-cli'`), not specifiers inside the file. Neither changes any decision; both were
wrong in the same direction, overstating the module fan-out and understating its uniformity.

Post-rebuild evidence for the comment fix: `grep -ro '@repo/' dist packages/llmwiki-core/dist
--include=*.js | wc -l` is still **2**, and the walked file counts are still **35** and **41**.

L4 (T5 close-out — a decision and evidence record, not a quotation). Independent verification of
T2-T4 plus the full gate set is complete and green. This entry closes T5 and records the evidence;
it changes no `S#` and no task other than T5's own state.

**Verified tree:** `69b1d10760a04c8805f5a84a77e15e7f764e40b5`. A verification task produces no
commit of its own, so T5's commit cell reads `(no commit — verification)`.

**Full suite, alone.** `pnpm test` alone returned `Test Files 929 passed | 3 skipped (932)` and
`Tests 6888 passed | 7 skipped (6895)`, 0 failed, `Duration 513.05s`. `maxWorkers` stayed 4 —
untouched, so the skips are the suite's own pre-existing skips and not a concurrency shortening.

**Packaging.** `test:pack` passed 1 file / 1 test in 44.07s.

**Lint.** `lint` exited 0 with the literal triple `643 / 466 / 496`, unchanged from the ceiling, and
`git diff <base>..HEAD -- eslint-baseline.json` is empty: the baseline was never rebaselined to
absorb this slice's changes.

**Static gates.** `gates:static` passed all 6 in 24.2 s: `tsc --noEmit` 0, `typecheck:tests` 0
(`1776 files checked; 260 baseline diagnostics in 94 files; no regression`), `fallow:ci` 0,
`fallow:kg` 0, `build` 0.

**Database was real, not stubbed.** A real pgvector container (`kind_kirch`) was adopted for the
run, so the database-backed suites executed against a live database, and
`LLMWIKI_TEST_ALLOW_NO_DATABASE` was never set. The suite's green is therefore not a
no-database fast path.

**Guard re-measured on the fresh build.** Total `/@repo\//` occurrences = **2**, both at
`packages/llmwiki-core/dist/compiler-cli.js` lines 306 and 326 — the serialized
`packages/wiki/package.json` dead data that L2 ruling pins deliberately. Import-position occurrences
= **0**. Walked `.js` files per root = **35** and **41**, matching the L3 post-rebuild figures. The
ratchet held at its pin: the guard saw nothing new because nothing new reached the bundle.

**History and protected surface.** Six commits, linear, base `5bac26b2` an ancestor.
`.github/`, `Dockerfile`, `docker/entry.sh`, `package.json`, `pnpm-lock.yaml` and `tsconfig.json`
are untouched. `bin` is still `llmwiki: dist/cli.js`. No pre-existing test was modified: all three
artifact tests read `A` (added), never `M`.

**Residual gaps the final verification named.** These are accepted limits, not open failures, and
none of them is closed by this slice: no argv, no exit codes, no stdout/stderr contract and no
shebang coverage; runtime-assembled specifiers such as `"@re" + "po/kg"` are invisible to the static
text guard (documented in the guard's own rationale, caught only in the literal-survives form by
the total ratchet); the count pin is a ceiling and therefore evidence of *no increase*, not proof
that the remaining two occurrences are intended; dynamic-`import()` reachability into
`compiler-cli.ts` from the MCP process is witnessed only by static analysis and `fallow`, never
observed at runtime; and the pre-existing `AKS_TEST_GATEWAY` and quickstart `it.skip` suites remain
skipped exactly as they were at base.

Decision recorded: T5 is closed as done. The gaps above stay named rather than converted into new
tasks, because closing any of them requires the CLI-removal slice or a runtime probe outside this
feature's envelope, and inventing tasks for them here would reopen scope S15 forbids.
