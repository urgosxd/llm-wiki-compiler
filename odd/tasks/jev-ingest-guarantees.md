# Feature: JEV ingest classification — silent-gap coverage

Branch: test/jev-ingest-algorithm-guarantees · Base: 8955d0615c5b6f624ba59d4f3154764050103028

## Specs

S1 — Threshold boundaries pinned. For each of `LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW 0.35`, `LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW 0.65`, `LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY 0.45`, `LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW 0.6`: one case just below, one exactly at, one just above — 12 positions. All four comparisons are strict `<`, so equality belongs to the upper arm, and that is the semantics the tests pin. Each position asserts the verdict label AND the reason/state it declares, never only one of them.

S2 — Env overrides reach the band. One test per threshold: parse the override through `parseJevConfig`, drive the interpreter with the resulting declaration, and assert the classifier's band moved AT the new value while the other three bands did not move. A variable that parses but is never wired, or is wired to the wrong band, must fail this test.

S3 — Uncertain support fires end to end. A request through stages 4-6 with an injected `ScriptedJevClient` lands stored `support_state = 'uncertain'` with the exact uncertain-support reason string. Today that band has never fired through a real request; only hand-seeded read-path fixtures mention it.

S4 — The write path asserts exactly. `routes/ingest/classification.test.ts` pins `free.reason` by exact string instead of `toBeTruthy()`, and asserts `jev_model` and `jev_classified_at` on the stored row. `jev_model` matters because `jev-latest` is a moving alias, so wrong or missing model attribution is undetectable and unattributable after the fact.

Non-goals: the five spec divergences (retry-after unread on 429; no `choice == argmax` / `sum(probabilities) == 1` validation; lenient envelope accepting `usage`-less responses and `noul` outside [0,1]; support modelled as a binary choice instead of the `score` primitive; no payload-size preflight). Every one is a behaviour change, not a test. No production change unless a test proves a real defect, and then only after reporting it.

## Tasks

- T1 — S1 — `packages/llmwiki-kg/ts/src/core/jev/interpret-thresholds.test.ts`
- T2 — S2 — `packages/llmwiki-kg/ts/src/core/jev/interpret-thresholds.test.ts`
- T3 — S3 — `packages/llmwiki-kg/ts/src/routes/ingest/classification-support-band.test.ts`
- T4 — S4 — `packages/llmwiki-kg/ts/src/routes/ingest/classification.test.ts`

## Log

L1 — Manager assignment, verbatim: "Close the silent coverage gaps in the KG ingest algorithm that consumes JEV. An audit just established that the guarantee the owner asked for exists partly — and not in the places where a wrong answer would go unnoticed." T1: "the four threshold boundaries, 0 of 12 positions asserted". T2: "no behavioural test of the env overrides". T3: "`support_state='uncertain'` is produced by no pipeline test at all". T4: "the write path under-asserts". Discipline: "Test-first, one RED per rule. Observe each failing before making it pass. If any of these passes before you write it, say so — that means the gap was smaller than the audit claimed, and the audit is the thing to correct, not the test to keep."

L2 — Lead technical direction: T1/T2 pin behaviour that is already correct (all four comparisons are strict `<`), so authoring-time RED is not available and a plain green would be vacuous. Non-vacuity is therefore established by a per-threshold mutation probe (`<` -> `<=`, and for T2 a cross-band mis-wire), each reverted before reporting, so every position has an observed RED.
