# kg-graph-hash-identity-only

**Defect note, NOT a fix.** Found by `feat/kg-rejected-edges-in-graph` (T7, `de09ce57b06f78d09a9cdb0cb0581ed55774bbd6`). The defect is larger than the branch that found it: it lives in the measurement instrument, it voids a pinned baseline, and fixing it here would have changed an instrument other fixtures depend on inside a branch already far past its slice budget.

## Finding

**A fingerprint that cannot see a class is a fingerprint whose equality stops meaning "same graph".**

`graphHashFor` is treated as the graph's identity: two runs that print the same 64 hex characters are taken to have produced the same graph. That equivalence broke the moment a row gained a second dimension. The digest is taken over *identity* only — a name and a type, two endpoint names and a verb — while the thing a reader now cares about, `ontology_verdict`, is not in the canonical form at all. So the two classes are indistinguishable to the instrument, and equal digests no longer imply equal graphs.

## Evidence

**The field list it covers today**, from `test/fixtures/kg-ingest-measure.ts:285-302` (the function body is `:291-309`, cited below line by line):

- Entities project exactly `(name, type)` — the discovery query is `select name, type from ontology_entities where stack_id = '${stackId}'` (`:292`), and the canonical form maps each row to `{ name, type }` (`:303`).
- Relationships project exactly `(from, type, to)` — the discovery query joins both endpoints and selects `source.name as from_name, relationship.type as type, target.name as to_name` (`:295-300`), and the canonical form maps each row to `{ from, type, to }` (`:304-306`).
- **Both discovery queries filter by `stack_id` only.** Neither carries a class predicate, so every row of the Stack is *read* regardless of class — and then everything about the class is dropped when the canonical object is built.

So the instrument reads both classes and serialises one. That asymmetry is the defect.

**The consequence, plainly.** An accepted→rejected flip keeps the row's identity, so the digest is unchanged while the accepted set shrinks. **The unchanged baseline `99cbdad5faa2b45cd90a9ddebab289dbdc5bf5e90f447dbfb99ed3575f46d30c` is therefore NOT evidence that the accepted set is unchanged.** Measured, not reasoned: the two baseline suites printed that exact value before and after this feature landed, with the accepted set deliberately exercised separately in `packages/llmwiki-kg/ts/src/core/accepted-set-differential.test.ts`.

That sentence is the point of this note. It is what stops someone — a reviewer, a future worker, a `git log` archaeologist — from pointing at a green hash assertion later and concluding the class work was a no-op. A test that passes for a reason the test does not state is worse than no test, because it is quotable.

**What the instrument DOES still cover, and where that is pinned.** `test/dimensions/kg-graph-hash-includes-class.test.ts` proves the discovery queries carry **no class FILTER**: flipping every row to `rejected` leaves the digest identical, because a filter would hash the empty graph instead, and each newly *written* rejected row does move the digest. That test protects the adjacent risk — a future "optimisation" adding `where ontology_verdict = 'accepted'` and silently narrowing what the baseline describes. It does not, and cannot, protect the equivalence this note is about: no filter is not the same as no blindness.

## What it would take

1. **Add the verdict to the canonical form for both projections** — `{ name, type, verdict }` for entities and `{ from, type, to, verdict }` for relationships at `test/fixtures/kg-ingest-measure.ts:302-307`, since both projections are built there and both are equally blind today. Covering only relationships would leave an entity-only flip invisible, which is the same defect one table over.
2. **The reason does not belong in the canonical form, and the verdict does. Reasoning:** the digest answers "is this the same graph", and the graph is the set of classified facts. `ontology_rejection_reason` is *why* a fact was refused — a finer question than *what* the graph contains, and one whose answer is already derivable from the verdict for any reader who wants it (join the row, read the column). Including it would make the digest move when a rejection is re-classified between two of the four reasons on an unchanged identity, which is a change to the graph's *annotation*, not to its *shape*. Two classes is the axis this branch introduced; the instrument should follow exactly that axis and no further. If a later feature makes the reason load-bearing for identity — for example, if two reasons on one identity became two rows — the reason enters the canonical form then, on the same evidence rule.
3. **This WILL move the pinned baseline**, at `test/dimensions/kg-ingest-item1.test.ts:203` and `test/dimensions/kg-ingest-item2.test.ts:150` (both still read `99cbdad5faa2b45cd90a9ddebab289dbdc5bf5e90f447dbfb99ed3575f46d30c`), because the canonical bytes change even when no row changes class. The new literal must be **re-derived from a real run of those two suites**, printed and copied — never reasoned into existence. Note the shape of the trap: the digest moves for a reason unrelated to the extraction, so whoever re-derives it must be able to say why it moved or they will "fix" a real extraction regression by updating a literal. `BASELINE_GRAPH_HASH` exists precisely to catch that, so the re-derivation needs its justification written beside the new value.
4. **Say what the equality now means.** Once the verdict is in the form, an equal digest means same identities *and* same classes. The doc block on the function at `test/fixtures/kg-ingest-measure.ts:273-290` should say that, because the next reader's assumption is the one this note had to correct.
5. **Re-check the callers of `graphHashFor` before changing it.** It is exported as an instrument, not as a private helper (`test/fixtures/kg-ingest-measure.ts:281-285` says so explicitly), so the change reaches every fixture that compares a digest, not only the two baseline suites.

## Why it is not fixed here

Fixing it **moves a pinned baseline** and **changes a shared measurement instrument other fixtures depend on** — a two-suite baseline rewrite plus a form change in a helper that is exported specifically so other tests can pin its properties. Doing that inside `feat/kg-rejected-edges-in-graph` would mean:

- a second, unrelated reason for the pinned digest to move, in a branch whose whole S8 argument is that hash movement must be attributable;
- a change to the instrument that measured *this* feature, introduced after the feature's measurements were taken, which retroactively muddies the evidence those measurements produced;
- more lines in a branch already **6,517 authored lines across 11 code commits** — sixteen times the ~400-line slice guidance, with the human's explicit decision to merge rather than re-slice. Adding a baseline rewrite at the end of that is how a diff stops being reviewable at all.

So the defect is recorded with its mechanism, its exact field list, its consequence and its remedy, and it is left for its own branch. The mitigation this branch does carry is the honest sentence: the pinned hash is not evidence about the accepted set, and that evidence lives somewhere else.

**Risk: none as a change** — this file is documentation. The defect it describes is real and open.
