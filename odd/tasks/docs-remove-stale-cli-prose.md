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

- [ ] T1 — Occurrence census + verified code surface census · S2,S3 · read-only explore · no commit
- [ ] T2 — Author this feature document · S1-S10 · worker · commit
- [ ] T3 — Prune/rewrite root-level and `docs/` user-facing pages that teach removed commands · S1,S6 · worker · commit
- [ ] T4 — Correct the SDK and MCP reference pages (primary non-CLI surface) · S1,S3,S4 · worker · commit
- [ ] T5 — Correct `ARCHITECTURE.md` and the package-boundary prose · S5 · worker · commit
- [ ] T6 — Remaining documentation surfaces (agent-facing/container/example prose) · S1,S6 · worker · commit
- [ ] T7 — Verification: `gates:static`, prose-rot guard, doc-reading tests · S9 · verify · no commit
- [ ] T8 — Final syntax/link sweep + confirm counts post-change · S2,S10 · worker · commit

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
