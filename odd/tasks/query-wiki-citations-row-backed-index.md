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

- T1 — feature document. S1-S10. Parent (Lead) authors, worker writes. Commit 1.
- T2 — thread the page-source seam into the citation index and make an unreadable index an error; RED then GREEN. S1, S3, S4, S5, S6, S7. Commit 2.
- T3 — disk-versus-rows differential on identical content. S8. Commit 3.
- T4 — independent verification and gates. S9, S10.

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
