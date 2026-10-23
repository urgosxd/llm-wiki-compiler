# Native review produced no authority in this session

Five attempts across Wave 1 and Wave 2, none of which created review authority.
Recorded because a reader of the commit log would otherwise assume these
changes were reviewed.

## The attempts

| # | Candidate | Result |
|---|---|---|
| 1 | 8 files, 1,123 lines | `pi-host-relay-transport-failure` — reliability lens aborted at 764,826 ms with a 953,271 ms timeout still remaining; `prepared_reviewers: 0`, `submitted_reviewers: 0` |
| 2 | 53 files, 19,872 lines | `consent-declined-this-candidate` |
| 3 | 3 files, 57 lines | `consent-declined-this-candidate` |
| 4 | same 3 files, retried | `consent-binding-stale` (expired after 10 min) |
| 5 | 4 files, 96 lines | `consent-declined-this-candidate` |

Every one reports `lineage_created: false` and `mutation_outcome: none`, so
nothing was burned and nothing needs repairing. That part is working correctly.

## What this rules out

**Size is not the cause.** Attempts 2 and 1 were large, but 3 and 5 were 57 and
96 lines across 3 and 4 files — exactly the size a review is designed for — and
both declined. My earlier theory that the accumulated branch was too big to
review was wrong, or at least incomplete.

## What is not known

The decline envelope carries no reason. It reports `consent: "declined_this_candidate"`
and nothing else: no diagnostic code, no provider message, no hint whether the
decline came from a human, the host, the provider, or a policy.

Attempt 1's abort is a different failure (transport, not consent) and had a
concrete reason attached. Attempts 2, 3 and 5 declined silently.

## What was done instead

Every change was verified empirically before being called done:

- 420 automated tests plus the per-slice suites.
- Differential verification against the live oracle, per slice, for backfeed,
  documents, stacks and the HTTP layer.
- The gateway work was verified end to end: ingest produced 9 coherent entities
  and 8 relationships, and `/context` returned correct entities with
  confidence HIGH.
- Router mounts checked against the oracle's exact 404 detail strings.

## What remains true regardless

No adversarial lens read this code. Differential testing proves the port
matches the oracle on the paths probed; it does not evaluate design, error
swallowing, or pathological input. The specific unprobed areas are listed in
`review-coverage-wave1.md`.

## Recommendation

Do not read "Wave 1 and Wave 2 closed" as "reviewed". If the native review
starts accepting candidates later, the honest next step is a review of the
Gateway commit (`8657bf0`, 84 lines) first, because it is small, it touches the
LLM boundary, and it introduced two workarounds that a reviewer should see.
