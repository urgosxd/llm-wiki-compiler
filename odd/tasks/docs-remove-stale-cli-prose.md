# Remove stale CLI prose from the documentation

Branch `docs/remove-stale-cli-prose`, base `5a31842bfa788971de757ba62b322cf94118696b`. Documentation-only slice: the product no longer has a CLI, a `bin`, or eighteen of its commands, and the surviving prose still teaches them.

## Specs

**S1 — The decision rule.** The rule that decides every edit, verbatim:

```
a document that teaches a command which no longer exists is worse than no document.
```

For each occurrence of a removed command in prose: **Delete** the sentence, section or example if it only describes removed behaviour; **Rewrite** it if it describes a surviving library surface (`createWiki`, the SDK methods, MCP tools) using command-shaped language; **Leave** it if it is genuinely historical — a CHANGELOG-style record.

**S2 — The occurrence count is re-derived, never trusted.** The briefed figure, verbatim and explicitly stale:

```
~280 `llmwiki <command>` prose occurrences across ~30 files
```

and the instruction that governs it, verbatim:

```
That count is two slices old — re-derive it with `git grep` and report the real number
```

Every census figure in the briefs has been wrong at least once, so the count is a measurement produced by a named command and reported before and after the change, never inherited.

**S3 — Every command is verified against the code before prose about it is written.** The brief's command inventory, verbatim:

```
eighteen commands lost their only entry point; `rm`, `visualize`, `lint --fix*`, `ingest-session`, `eval cache clear` and `review reject` lost their capability entirely; `review approve`/`show`/`list` also went; and `deleteSource` was withdrawn from the SDK. `import` survives as `sdk importOkf()`; `eval`, `compile`, `lint`, `status`, `context` survive as SDK and/or MCP tools.
```

and the brief's own qualifier on that list, verbatim:

```
**Verify each against the code before writing prose about it** — do not trust my list, which is a summary of summaries.
```

The inventory is a summary of summaries: it is re-verified against the code in T1, not inherited.

**S4 — The SDK and MCP pages are the primary non-CLI documentation.** Verbatim:

```
The SDK and MCP pages are now the **primary** non-CLI documentation. They should gain nothing speculative; they should simply stop being wrong.
```

Their correctness criterion is subtraction of falsehood, not addition of new material.

**S5 — Monorepo and package-boundary accuracy.** Verbatim:

```
`ARCHITECTURE.md` and the package boundary description describe a monorepo whose packages are real. Check whether they are accurate and fix what is not, but do not redesign the document.
```

**S6 — No invented documentation.** Verbatim:

```
Do **not** invent tutorials, new guides, or 'how to migrate' pages unless a page already exists that would otherwise lie.
```

No new page is authored by this slice.

**S7 — Documentation only.** Verbatim:

```
**No source, test, config or manifest changes.** This slice edits documentation only. If you believe prose is wrong because code is wrong, **record it and stop** — do not fix code here.
```

Code defects found while verifying prose are recorded as report items, never patched here.

**S8 — Scope and git boundaries.** Verbatim, in three parts:

```
**Do not edit `odd/tasks/**`** beyond your own feature document.
```

```
Never delete `packages/llmwiki-kg/LICENSE.md`.
```

```
No history rewriting, **no hook bypass of any kind** (`git -c core.hooksPath=/dev/null` is `--no-verify` and has been disclosed twice as a violation), no push, no `--no-verify`, no `HUSKY=0`, **no `cp -a` of this worktree** (`.git` is a pointer file, so that is a second handle on the same shared gitdir).
```

**S9 — Deliberately light verification budget.** Verbatim:

```
**Do not run `pnpm test`, do not start Docker, do not provision a database.**
```

Verification is `gates:static`, the config prose-rot guard (`test/config-prose-rot-guard.test.ts`), and `vitest run` over any test that reads documentation. And, verbatim:

```
**Do not touch `CHANGELOG.md`** — the concurrent slice owns it right now, and two writers on one file is how the last few incidents started.
```

**S10 — The report contract.** The report must contain, verbatim:

```
The re-derived occurrence count before and after, with the command you used; the per-file decision summary (deleted / rewritten / left, with a reason for each file you left alone); any prose that turned out wrong **because the code is wrong**, recorded rather than fixed; the static gate exits and the prose-rot guard result; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line.
```

## Tasks

- [x] T1 — Occurrence census + verified code surface census · S2,S3 · read-only explore · commit e878a47b52cb65063fe888a6cd595c1d5ac910eb (census evidence rides with the SDK slice)
- [x] T2 — Author this feature document · S1-S10 · worker · commit 44886c1ef3aeb9802f9ff3dbc697ad76c59cbfca
- [x] T3 — Prune/rewrite root-level and `docs/` user-facing pages that teach removed commands · S1,S6 · worker · commits 354b2e8b6c332e4a2ee9bb4ee9a694dc85eb2dfe and e1034233ce95904ceff2305822499b3ebd5f55e1
- [x] T4 — Correct the SDK and MCP reference pages (primary non-CLI surface) · S1,S3,S4 · worker · commit e878a47b52cb65063fe888a6cd595c1d5ac910eb
- [x] T5 — Correct `ARCHITECTURE.md` and the package-boundary prose · S5 · worker · commit 3dbd2d5ced87ead6be45c2be0dc1437d1fb5e5f4
- [x] T6 — Remaining documentation surfaces (agent-facing/container/example prose) · S1,S6 · worker · commit 5ee32a7c6804564fc528ebfd1ad110fca1d472ba
- [x] T7 — Verification: `gates:static`, prose-rot guard, doc-reading tests · S9 · verify · commit 3dbd2d5ced87ead6be45c2be0dc1437d1fb5e5f4 (verification evidence lives with the root-docs slice)
- [x] T8 — Final syntax/link sweep + confirm counts post-change · S2,S10 · worker · commit 3dbd2d5ced87ead6be45c2be0dc1437d1fb5e5f4

## Log

### L1 — original request (verbatim)

Project assignment for branch docs/remove-stale-cli-prose:

Finish the documentation debt the CLI removal knowingly deferred. The product no longer has a CLI, a `bin`, or eighteen of its commands, and the surviving prose still teaches them.

Repo: llm-wiki-compiler, `main` at **`5a31842bfa788971de757ba62b322cf94118696b`**. Read `AGENTS.md`. Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. pnpm; bare `pnpm` 127 → `corepack pnpm`.

## This is a LIGHT unit, deliberately, and you must keep it light

**Another slice is running concurrently on this machine** and it needs the database and Docker. So:
- **Do not run `pnpm test`, do not start Docker, do not provision a database.** This change is prose; a full suite here would compete for the memory that has already killed several agents on this project.
- Your verification is: `gates:static`, the config prose-rot guard (`test/config-prose-rot-guard.test.ts`), and `vitest run` over any test that reads documentation.
- **Do not touch `CHANGELOG.md`** — the concurrent slice owns it right now, and two writers on one file is how the last few incidents started.

## What to remove

The CLI removal left **~280 `llmwiki <command>` prose occurrences across ~30 files** as a named, counted follow-up. That count is two slices old — **re-derive it with `git grep` and report the real number**, because every census figure in my briefs has been wrong at least once.

The rule that decides every edit: **a document that teaches a command which no longer exists is worse than no document.** For each occurrence, decide:
- **Delete** the sentence, section or example if it only describes removed behaviour.
- **Rewrite** it if it describes a surviving library surface (`createWiki`, the SDK methods, MCP tools) using command-shaped language.
- **Leave** it if it is genuinely historical — a CHANGELOG-style record, which you are not touching anyway.

Specifically relevant: eighteen commands lost their only entry point; `rm`, `visualize`, `lint --fix*`, `ingest-session`, `eval cache clear` and `review reject` lost their capability entirely; `review approve`/`show`/`list` also went; and `deleteSource` was withdrawn from the SDK. `import` survives as `sdk importOkf()`; `eval`, `compile`, `lint`, `status`, `context` survive as SDK and/or MCP tools. **Verify each against the code before writing prose about it** — do not trust my list, which is a summary of summaries.

## What must survive intact
- The SDK and MCP pages are now the **primary** non-CLI documentation. They should gain nothing speculative; they should simply stop being wrong.
- `ARCHITECTURE.md` and the package boundary description describe a monorepo whose packages are real. Check whether they are accurate and fix what is not, but do not redesign the document.
- Do **not** invent tutorials, new guides, or "how to migrate" pages unless a page already exists that would otherwise lie.

## Hard constraints
- **No source, test, config or manifest changes.** This slice edits documentation only. If you believe prose is wrong because code is wrong, **record it and stop** — do not fix code here.
- **Do not edit `odd/tasks/**`** beyond your own feature document.
- Never delete `packages/llmwiki-kg/LICENSE.md`.
- No history rewriting, **no hook bypass of any kind** (`git -c core.hooksPath=/dev/null` is `--no-verify` and has been disclosed twice as a violation), no push, no `--no-verify`, no `HUSKY=0`, **no `cp -a` of this worktree** (`.git` is a pointer file, so that is a second handle on the same shared gitdir).

## Report
The re-derived occurrence count before and after, with the command you used; the per-file decision summary (deleted / rewritten / left, with a reason for each file you left alone); any prose that turned out wrong **because the code is wrong**, recorded rather than fixed; the static gate exits and the prose-rot guard result; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line. This is prose: if `Risk: none` is honest, say why — the honest reason is that no executable behaviour changed and the only consumer is a reader, which is exactly the class where "it does not crash" is not the measure and "it no longer lies" is.

### L2 — lead baseline (verified, not inherited)

Lead baseline (verified, not inherited): HEAD `5a31842bfa788971de757ba62b322cf94118696b` == briefed base; branch `docs/remove-stale-cli-prose`; working tree clean; branch had no commits at start. Note: `origin/main` is `82038628a81a2a0d2d5e08ead083e11ae0c24419`, which diverges from the briefed base — so `test:affected` merge-base arithmetic is not trustworthy here and the affected-tier selection must not be relied on for this slice. Also recorded: a first reconnaissance agent returned a fabricated git report (`ANCESTOR_NO` with placeholder output); it was rejected and re-derived; the true direction is 5a31842 ancestor-or-equal of HEAD, in fact equal.

### L3 — commit slices, final census and verification record

The slice landed as **seven** commits on `docs/remove-stale-cli-prose` (base `5a31842bfa788971de757ba62b322cf94118696b`), in this order:

| Slice | SHA (full 40) | Subject | Files | +/- |
| --- | --- | --- | --- | --- |
| S1 | `44886c1ef3aeb9802f9ff3dbc697ad76c59cbfca` | `docs(odd): add the remove-stale-cli-prose feature document` | 1 | +160 / -0 |
| S2 | `e878a47b52cb65063fe888a6cd595c1d5ac910eb` | `docs(sdk): correct the primary SDK and MCP reference pages` | 3 | +100 / -170 |
| S3 | `8e82742b58570c044ba82b78ea3ac8a81d0b3acb` | `docs(configuration): remove CLI commands that no longer exist` | 8 | +69 / -812 |
| S4 | `354b2e8b6c332e4a2ee9bb4ee9a694dc85eb2dfe` | `docs(guides): remove walkthroughs of removed CLI commands` | 15 | +259 / -1489 |
| S5 | `5ee32a7c6804564fc528ebfd1ad110fca1d472ba` | `docs(troubleshooting): answer only with surfaces that exist` | 2 | +47 / -165 |
| S6 | `3dbd2d5ced87ead6be45c2be0dc1437d1fb5e5f4` | `docs: describe the monorepo and feature set that actually exist` | 7 | +128 / -233 |
| S7 | `e1034233ce95904ceff2305822499b3ebd5f55e1` | `docs(introduction): describe the wiki shape and review holds that ship` | 1 | +13 / -9 |

Thirty-six documentation files were modified, plus this feature document — 37 changed paths in total. Each of the 36 sits in exactly one commit, and the tree is clean at `e1034233`.

**Census, re-derived at the commit point (not inherited).** The command is the one this slice standardised on:

```
git grep -n -E 'llmwiki[[:space:]]+(init|ingest|ingest-source|ingest-session|ingest-job-status|ingest-jobs-list|compile|compile-wiki|query|query_wiki|search|search_pages|read_page|get_context_pack|list-stacks|list_stacks|lint|status|context|eval|review|rm|rm-source|visualize|serve|watch|refresh|state|schema|template|category|list|links-here|save|recover|race|build|view|artifacts|stack|profile|workflow|artifact|quickstart|next|import|export|product|operation)([^a-z0-9_-]|$)' -- '*.md' '*.mdx' ':!CHANGELOG.md' ':!odd/**'
```

- Base `5a31842b`: **233 command-shaped lines across 28 files**.
- Final `e1034233`: **2 command-shaped lines across 2 files**.

The two survivors, and why each is acceptable under S1:

1. `README.md:320` — "`- llmwiki status` command: a readable snapshot of page and source counts…". It sits inside the `**Released `1.1.0`:**` history block, i.e. a CHANGELOG-style record of what shipped then. S1 says to **leave** genuinely historical prose, and `CHANGELOG.md` itself was out of scope.
2. `docs/guides/open-knowledge-format.mdx:116` — "`x-llmwiki` is regenerated from current llmwiki state." This is a **product-noun** use: `llmwiki` followed by the noun "state", not the removed `llmwiki state` verb. The predicate matches it only because `state` is in the alternation.

The briefed figure — "~280 `llmwiki <command>` prose occurrences across ~30 files" — was **not reproducible under any predicate tried here**. Measured at base: the command-shaped predicate gives 233 lines / 28 files; a deliberately broad predicate (`llmwiki[[:space:]]+[a-z]`) gives 452 lines / 51 files across `*.md` + `*.mdx` and 106 lines / 20 files across `*.md` only. The briefed number sits between predicate widths and matches none of them, which is the same lesson as S2: a census is a measurement, and it is only meaningful with its predicate attached. (The independent verifier reported broad 376/37 and md-only 30/6 from its own predicate; I could not reproduce those with my broad predicate, so the two figures are not interchangeable and both are recorded as predicate-scoped, not as truth.)

**The `categories-here` gap is real, and it is the important finding about the predicate.** The `category` alternative plus `([^a-z0-9_-]|$)` cannot match `categories-here`, because `categories` is not `category` followed by a non-word character. At base, `docs/guides/row-backed-wiring-reachability.mdx:206` read "`category` and `llmwiki categories-here` resolve their store through…" and was **invisible** to the command-shaped predicate: the base run of that predicate lists `row-backed:152`, `wiki-model:318` and `wiki-db-parity:241` but not `:206`. Two more base pages taught the pair as well — `docs/concepts/wiki-model.mdx:318` and `docs/guides/wiki-db-parity-migration.mdx:241` — so the gap hid a whole family of occurrences. All of them are gone now: `git grep -n 'categories-here' -- '*.md' '*.mdx' ':!CHANGELOG.md' ':!odd/**'` returns nothing at `e1034233`. The residual hits for a wider `llmwiki -d` / `.llmwiki -maxdepth` probe are a Postgres `-d llmwiki` argument and a `find .llmwiki` path, not commands.

**Verification evidence, re-run on the committed tree.**

- `corepack pnpm run gates:static` → exit 0, all six gates ok (`tsc` 8.2 s, `typecheck:kg` 8.2 s, `typecheck:tests` 19.7 s, `fallow:ci` 3.3 s, `fallow:kg` 1.1 s, `lint` 12.5 s; "static gates: all 6 passed in 28.9 s"; eslint ratchet 1645 files, 566 baseline violations, no regression).
- `./node_modules/.bin/vitest run test/config-prose-rot-guard.test.ts test/control-gates.test.ts scripts/static-gates.test.ts` → 3 files passed, **34 tests passed** (prose-rot guard 11, static gates 9, control gates 14). No Docker was started and no database was provisioned; the `adopted running pgvector/pgvector:pg16 container` banner is the fixture reusing a container another slice already had up.
- Zero dead links, dead anchors or dead imports, re-measured on the final commit rather than inherited: a link-and-anchor checker over all 37 changed paths (the 36 documentation files plus this document) resolved every relative link, MDX `href=`, import specifier and slugified anchor, and every `docs/docs.json` nav entry resolves to a page that exists. The only reported hits were three `import … from "llm-wiki-compiler"` lines inside code fences (`README.md:109,135,194`, `docs/guides/sdk.mdx:25,33,43,287`, `examples/basic/README.md:31`) — package specifiers the checker's import rule caught, not links.
- All changed MDX is structurally valid: 29 `.mdx` files with even fence counts, closed frontmatter, and balanced `Card`/`CardGroup`/`Steps`/`Step`/`Accordion`/`Note`/`Tip`/`Warning`/`Tabs`/`Tab`/`ParamField`/`Frame`/`CodeGroup`.
- No non-doc file in the diff (`git diff --name-only | grep -vE '\.(md|mdx)$'` → `NO_NON_DOC_FILES`), `CHANGELOG.md` never staged and never modified, `packages/llmwiki-kg/LICENSE.md` intact, `odd/` touched only through this document.

**The nine verifier defects, and the state each is in now.** Every one was re-checked at the final commit with the verifier's own grep:

1. `docs/guides/row-backed-wiring-reachability.mdx:206-212` still taught `llmwiki category` / `llmwiki categories-here`, and its `:152` rewrite named `listCategories()` / `readCategory()` — internal store functions with no SDK or MCP surface. **Fixed**: no `llmwiki category`, `llmwiki categories-here`, `listCategories` or `readCategory` remains in that file.
2. `docs/guides/atomic-memory-bridge.mdx:4` frontmatter advertised `llmwiki export --target json`. **Fixed**: it now reads "Use wiki.exportJson() with @atomicmemory/llmwiki …", matching the body.
3. `docs/guides/mcp-agent-integration.mdx:167` and its `<Tip>` promised that candidates wait "until an operator approves them". **Fixed**: no `approve` / `operator approves` / `needs your approval` text remains in that file.
4. `docs/guides/clp/build-your-first-profile.mdx` frontmatter advertised building a custom profile while the body denied the capability. **Fixed**: the title is now "Custom Profiles in This Build" and the description states that profiles are not part of this build.
5. `docs/guides/http-ingest-jobs.mdx:173` ran `llmwiki host --allow-lan …` in a ```bash fence. **Fixed**: no `llmwiki host` remains.
6. `docs/guides/sdk-packages.mdx:23,106` named `@atomicstrata/llmwiki-local-workflows` and `src/local-workflow-host/`, neither of which exists in `package.json` workspaces. **Fixed**: no `local-workflow`, "local engine" or "three packages" remains on the page.
7. `ARCHITECTURE.md:107` said a compiler profile "may declare their data contracts". **Fixed**: it now says "The one built-in compiler profile declares no data contract for them".
8. `README.md:289` said "a pnpm workspace of four packages". **Fixed**: `README.md:290` now says "The product is a pnpm workspace of five".
9. `docs/guides/wiki-db-parity-migration.mdx` cited root-relative `src/dimensions/wiki/…` paths that do not exist. **Fixed**: no root-relative `src/` citation remains in that file.

**Code faults recorded and deliberately NOT fixed (S7).** Each is a place where the prose is now truthful because the *code* is wrong or the product has a gap; the prose states the truth and the defect is left for a code slice:

- `packages/wiki/src/mcp/server.ts:65-78` advertises four tools — `list_workflow_actions`, `describe_workflow_action`, `run_workflow_action`, `verify_artifact` — that are never registered. Only 14 MCP tools exist.
- `packages/wiki/src/mcp/okf-tools.ts:72` tells callers to approve imports via `llmwiki review`, a command that no longer exists.
- `packages/wiki/src/compiler/compile-report.ts:256`, `packages/wiki/src/context/pack-warnings.ts:59`, `packages/wiki/src/commands/query.ts:398` and `packages/wiki/src/import/run.ts:163` all point readers at `llmwiki review` commands.
- `packages/wiki/src/project/recommendations.ts:108-135` builds `RecommendedAction.command` strings tagged `executable.binary: "llmwiki"`, and those strings reach agents through `get_context_pack` — the SDK actively hands out commands that cannot run.
- `packages/wiki/src/utils/constants.ts:831` defines `ENV_VERBOSE` with no reader anywhere.
- Stale comments still describe a local workflow engine that does not exist, in `packages/wiki/src/core-index.ts`, `packages/wiki/src/sdk/types.ts` and `packages/wiki/src/sdk/wiki.ts`.
- Product gap: a review-held candidate has **no promotion surface anywhere** — not on the SDK, not among the MCP tools, and the viewer's review list is read-only. The prose now says exactly that instead of promising approval.

**Open decision left to the Manager.** Three pages are now truthful but thin, because almost their entire content described capabilities that do not ship: `docs/configuration/profile-templates.mdx`, `docs/configuration/autosci-profile.mdx` and `docs/concepts/configurable-lifecycle-profiles.mdx`. They are candidates for page retirement together with their `docs/docs.json` nav entries. They were deliberately **not** deleted in this slice — retirement is a navigation decision, not a prose correction.

**Rejected recommendation.** An independent verifier proposed committing a new `test/docs-cli-prose-guard.test.ts` that would walk the docs and fail on any `llmwiki <command>` outside a historical allowlist. It was rejected for this slice because S7 forbids test changes, and it is recorded here as the recommendation for a separate slice — the `categories-here` gap is exactly the kind of regression a durable test would catch and a one-off census cannot.

**Process note — a briefing defect, not a content defect.** The Lead's slice plan enumerated paths for S1–S6 and omitted `docs/introduction.mdx` from every one of them, although the same plan required "every modified documentation file must end up in exactly one commit" and a clean tree. The commit worker caught the contradiction by refusing to stage an unlisted path, escalated it with a derived candidate set, and the file was carried in a seventh commit with its own subject (`docs(introduction): describe the wiki shape and review holds that ship`). The file's **content** was already final and verified before staging and was not edited while committing; only the plan's path list was wrong.

**Risk: none** — and the honest reason is not "it does not crash". No executable behaviour changed: the diff is documentation only, no source, test, config, manifest or `CHANGELOG.md` path appears in any of the seven commits, and the only consumer of this change is a reader. For a reader the measure is not whether the artefact runs but whether it still lies, and the census above is that measure: 233 command-shaped lines that taught commands which do not exist, down to 2, both of them legitimate.
