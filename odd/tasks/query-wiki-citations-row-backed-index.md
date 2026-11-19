# Row-backed answer-citation index

Restores answer-citation resolution on row-backed Stacks: `collectAnswerCitationIndex` reads through the page-source seam instead of walking `wiki/` on disk, and an unreadable index stops masquerading as a Stack with zero pages.

## Specs

**S1 — The defect.** "**`collectAnswerCitationIndex` (`packages/wiki/src/citations/answer-index.ts`) reads from disk only and was untouched by `1c3e6358`.**" and "**On a row-backed Stack with no `wiki/` directory the index is `{"retained":0,"pending":0}`, so every citation reports `broken` regardless of the tokenizer or the prompt.**"

**S2 — Both deployment shapes named, with `path:line`.** "**Confirm which source each deployment shape uses, with `path:line`.**"

**S3 — Reuse the existing row reader, never a second one.** "**Is there an existing row-backed reader that already answers "give me every page's identity and body for this stack"?** **If yes, reuse it; do not build a second one.**"

**S4 — The source choice is explicit, never a silent fallback.** "**Where does the disk path get chosen over the row path**, and is the choice explicit or a fallback? **A fallback that silently yields an empty index is how this bug stayed invisible — the empty index is not an error, it is a valid answer that means "nothing to check".**"

**S5 — The invariant, both halves.** "**on a row-backed Stack, `reportAnswerCitations` resolves every citation whose page exists, and reports `broken` only for pages that do not.** **Test both halves.** **A test that only asserts "not broken" passes when the index invents entries, and a test that only asserts "broken" passes when the index is empty — which is the bug.**"

**S6 — Zero entries is distinguishable from zero pages.** "**pin the empty-index case explicitly: an index of zero entries must be distinguishable from a Stack with zero pages.** **If today they are the same value, that is the defect at its root and it needs fixing, not documenting.**"

**S7 — Test-first, on a genuinely row-backed Stack.** "**RED first, on a row-backed Stack with no `wiki/` directory, by whatever mechanism this codebase already uses to make a Stack row-backed in a test.**" and "**If there is no such mechanism, say so — that absence is itself a finding and would explain why nobody saw this.**"

**S8 — The disk path must not regress.** "**A differential: the same content on disk and in rows must produce the same citation verdicts.** **Both, then compare.** **If they differ, that difference is the second bug and must be explained before this merges.**"

**S9 — Standing constraints.** "**Node 24 on PATH for `git commit`.** Never `--no-verify`, never `HUSKY=0`." "**No `.env`, no keys, no tokens, no provider spend.**" "**Test database isolation is in force:** `TESTCONTAINERS_REUSE_ENABLE=false`, and **refuse a server this run did not create.**" "**`path:line` from a command you ran this session.**" "**Nothing pushed, no PR, no merge.**"

**S10 — No claim beyond the evidence.** "**Do not claim the human's production citations now resolve unless you can show a row-backed Stack resolving one.**"

## Tasks

- [x] T1 — feature document. S1-S10. Parent (Lead) authors, worker writes. Commit 1 `f93096b4b1d63adad91c2d7c06e6ceb4b92ce027` (`docs(odd): open the row-backed citation index feature`).
- [x] T2 — thread the page-source seam into the citation index and make an unreadable index an error; RED then GREEN. S1, S3, S4, S5, S6, S7. Commit 2 (`fix(citations): read the citation index through the page-source seam`) — its SHA cannot be written inside its own diff; it is reported in the handoff and in `git log`.
- [ ] T3 — disk-versus-rows differential on identical content. S8. Commit 3.
- [ ] T4 — independent verification and gates. S9, S10.

## Log

### L1 — the assignment, verbatim

Project assignment for branch fix/query-wiki-citations-row-backed-index:

The citation fix merged, and it does not fix the human's production bug. `collectAnswerCitationIndex` is disk-only, so on a row-backed Stack the index is empty and every citation reports `broken` no matter what the tokenizer does.

## The finding, as the last branch reported it
**`collectAnswerCitationIndex` (`packages/wiki/src/citations/answer-index.ts`) reads from disk only and was untouched by `1c3e6358`.** **On a row-backed Stack with no `wiki/` directory the index is `{"retained":0,"pending":0}`, so every citation reports `broken` regardless of the tokenizer or the prompt.**

**And the direction of the evidence points at row-backed:** the human's environment is a database-backed deployment, and a registry-only source falling back to on-disk is the one discriminating signal. **Confirm which source each deployment shape uses, with `path:line`.**

**This is the human's actual bug.** **They reported three broken citations from a production environment; the tokenizer defect was real and is fixed; and the index being disk-only means their report may be reproduced again today, unchanged.**

## Step 1 — establish the seam before writing anything
1. **What exactly does `collectAnswerCitationIndex` read**, and how does it build the index? **Name the function, the path it walks, and every input.**
2. **What would a row-backed index need to read instead** — which table, which columns, which identity form (`page_directory` + `slug`, not a bare slug — `1c3e6358` established that a bare slug cannot name a page).
3. **Is there an existing row-backed reader that already answers "give me every page's identity and body for this stack"?** **If yes, reuse it; do not build a second one.** **This repository has five private copies of `verdictClause` and that is exactly the failure this step avoids.**
4. **Where does the disk path get chosen over the row path**, and is the choice explicit or a fallback? **A fallback that silently yields an empty index is how this bug stayed invisible — the empty index is not an error, it is a valid answer that means "nothing to check".**

## Step 2 — the fix, with the invariant pinned
**The invariant: on a row-backed Stack, `reportAnswerCitations` resolves every citation whose page exists, and reports `broken` only for pages that do not.** **Test both halves.** **A test that only asserts "not broken" passes when the index invents entries, and a test that only asserts "broken" passes when the index is empty — which is the bug.**
**And pin the empty-index case explicitly: an index of zero entries must be distinguishable from a Stack with zero pages.** **If today they are the same value, that is the defect at its root and it needs fixing, not documenting.**

**Test-first.** **RED first, on a row-backed Stack with no `wiki/` directory, by whatever mechanism this codebase already uses to make a Stack row-backed in a test.** **If there is no such mechanism, say so — that absence is itself a finding and would explain why nobody saw this.**

## Step 3 — do not regress the disk path
**A differential: the same content on disk and in rows must produce the same citation verdicts.** **Both, then compare.** **If they differ, that difference is the second bug and must be explained before this merges.**

## Standing constraints
- **Node 24 on PATH for `git commit`.** Never `--no-verify`, never `HUSKY=0`.
- **No `.env`, no keys, no tokens, no provider spend.**
- **Test database isolation is in force:** `TESTCONTAINERS_REUSE_ENABLE=false`, and **refuse a server this run did not create.** **Note: an untracked leftover container `crazy_heyrovsky` on `:5434` is now schema-stale (6 missing `public.ontology_entries.*` / `ontology_relationships.*` columns) and will fail parity checks — do not adopt it, and do not delete containers you did not create without saying so.**
- **`path:line` from a command you ran this session.** **Every brief in this campaign has had wrong premises; nine passes were rejected for inventions.**
- **Nothing pushed, no PR, no merge.**

## Deliverables
- **`odd/tasks/query-wiki-citations-row-backed-index.md`** with `## Specs`, `## Tasks`, `## Log`, L1 = this task verbatim.
- **Work-unit commits with `Risk:` lines.**
- **Report: which source each deployment shape uses (`path:line`), whether a row-backed reader already existed, the empty-index-versus-empty-stack answer, the differential between disk and rows, the full 40-character SHA, and the gate scope with its counts.**
- **Do not claim the human's production citations now resolve unless you can show a row-backed Stack resolving one.**

### L2 — T2 evidence, verified this session (covers S1, S3, S4, S5, S6, S7)

**Premises re-verified before writing (not re-derived from the assignment).**

- E1, confirmed. Before this task `collectAnswerCitationIndex(root)` was disk-only: it
  `safeRealpath`'d `root`, walked `<root>/wiki/concepts` and `<root>/wiki/queries`,
  called `listCandidates`, and returned `{ retained: [], pending: [] }` when the root
  did not resolve. Its two consumers were `answer-report.ts:13` and
  `answer-publication.ts:65`.
- E2, confirmed. `withRawPageSource` (`page-source-seam.ts:261-271`) hands the callback
  `undefined` for the `file` authority and `createRawPageSource(db, stackId, root)` for
  `stack`, and the seam idiom is uniform across its call sites (`export.ts:213`,
  `snapshot.ts:164`, `linter/index.ts:180`, `graph-health.ts:97`, `okf/run.ts:19`,
  `delta.ts:77`).
- E3, confirmed and reused. The row reader is `createRawPageSource` →
  `listStoredPagesUnfiltered` (`page-store.ts:257`), whose SQL already selects
  `page_directory`, `slug` and `aliases`. No second reader was written.
- E4, confirmed and fixed. `toRaw` (`page-scan-source.ts:278-299` before this change)
  selected `aliases` at the SQL layer and then dropped them from `frontmatter`, while
  the disk walk reads aliases from frontmatter (`answer-index.ts:30` before) and
  `resolveBareSlug` uses them as a fallback.

**Where the disk read is chosen, now explicit (S4).** `collectAnswerCitationIndex`
(`answer-index.ts:142`) branches on the `source` argument the caller's seam resolved.
There is no fallback: with a `source` the disk walk is not attempted at all, and without
one the read is the byte-identical file read. Production callers hand the seam's answer
in: `commands/query.ts:230` (`withRawPageSource(root, options.env ?? process.env, …)`)
and `commands/query-publication.ts:85` (the save path, with the publication's own `env`).
Both callers had an environment in scope, so none was invented.

**RED, observed before the implementation.** `test/answer-citation-row-source.test.ts`
(real database, project root with NO `wiki/` directory) — `3 failed | 1 passed`:

```
 FAIL  test/answer-citation-row-source.test.ts > resolves a row-backed page and reports only the absent one broken
AssertionError: expected { version: 1, citations: [ …(2) ] } to deeply equal { version: 1, citations: [ …(2) ] }
-       "pageId": "concepts/alpha",
-       "status": "resolved",
+       "status": "broken",
        "target": "alpha",
      {
        "status": "broken",
        "target": "gone",
 FAIL  test/answer-citation-row-source.test.ts > resolves a declared alias from rows, as the disk walk does
-     "pageId": "concepts/vector-db",
-     "status": "resolved",
+     "status": "broken",
      "target": "vector-database",
```

The right failure: the existing page came back `broken` (the empty index) while the
absent page's `broken` already matched, so the case discriminates instead of passing on
an empty result.

`test/answer-citation-index-unreadable.test.ts` — `3 failed | 1 passed`:

```
 FAIL  test/answer-citation-index-unreadable.test.ts > throws for a root it cannot resolve instead of reporting zero pages
AssertionError: promise resolved "{ retained: [], pending: [] }" instead of rejecting
 FAIL  test/answer-citation-index-unreadable.test.ts > reports an unreadable index as unavailable instead of printing verdicts
AssertionError: expected { answerCitations: { …(2) } } to deeply equal {}
 FAIL  test/answer-citation-index-unreadable.test.ts > refuses publication validation rather than publishing an unverifiable document
AssertionError: The instanceof assertion needs a constructor but undefined was given.
```

The third failure is the class not existing yet — it is the discriminator's own
assertion, not a behavioural pass.

**GREEN, observed after the implementation.**
`pnpm exec vitest run test/answer-citation-index-unreadable.test.ts test/answer-citation-row-source.test.ts`
→ `Test Files 2 passed (2)`, `Tests 8 passed (8)`, nothing skipped.

**F2 — the discriminator, and the rejected alternative.** `AnswerCitationIndexUnreadableError`
(`answer-index.ts:53`) is thrown when no `source` was supplied and `safeRealpath(root)`
returns null (`:152`). A discriminant field on the exported `AnswerCitationIndex`
(`readable: true|false`) was CONSIDERED AND REJECTED: it is a breaking shape change to an
exported type for information the type system already carries for free by throwing, and
every existing consumer would have to handle a state that cannot be returned. Zero
entries from a source that WAS readable stays a legitimate empty value — pinned both
ways: rows-only Stack with no pages returns `{ retained: [], pending: [] }` without
throwing, and an unresolved root throws. The existing boundaries then do the right thing
with no new code: `query-citation-report.ts` prints `Answer citations: unavailable (…)`
instead of fake verdicts, and `query-publication.ts` refuses the write with
`code: "unavailable"` rather than publishing an unverifiable document.

**F3 — the alias finding, and the shared-code change it required.** `frontmatter.aliases`
has TWO consumers besides the citation index, both reached through the same `RawWikiPage`
carrier:

- `viewer/collect.ts:286` (`readAliases`) → `ViewerPage.aliases`, which
  `resolveBareSlug`'s alias fallback reads (`viewer/collect.ts:108-111`), so row-backed
  outgoing links and dangling links change;
- `export/collect.ts:164` (`readStringArray(meta, "aliases")`) → the exported page's
  `aliases`, which the OKF mapping emits (`export/okf/mapping.ts:51`).

Adding aliases to `toRaw` (`page-scan-source.ts:296`) is therefore a SHARED-CODE
behaviour change for row-backed viewers, exports and the linter corpus — toward parity
with the file path, which has always read them from frontmatter. It cannot reach the disk
path: `createRawPageSource` is only built in the `stack` branch of `withResolvedBackend`
(`page-source-seam.ts:269`). Named in the commit `Risk:` line.

**Named gap, not invented (pending).** A row-backed candidate source DOES exist:
`withCandidateSource` (`candidate-source.ts:118-131`), which `listCandidates` already
reaches through its own default `env`. The gap is that the index threads no environment,
so `listCandidates` resolves `process.env` while the retained half resolves the caller's
seam. On a host serving several Stacks the PENDING half of the index is still the
deployment's queue. Pre-existing, unchanged by T2, out of this task's scope.

**S8 is T3's, not claimed here.** No disk-versus-rows differential was run; these cases
prove the row half only. S10 stands: nothing here claims the human's production citations
resolve.
