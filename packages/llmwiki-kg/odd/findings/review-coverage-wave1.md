# Native review coverage — Wave 1

Same rule as the Wave 0 document: this records what the native review actually
approved, what it did not, and why. "Wave 1 closed" does not mean "Wave 1
reviewed".

## Not covered by native review

**All three slices.** No native review authority was created for any of them.

Two attempts, both candidate-scoped declines:

| Attempt | Candidate | Result |
|---|---|---|
| 1 | `8960986..HEAD`, 8 files, 1,123 lines | `pi-host-relay-transport-failure` — reliability lens aborted at 764,826 ms with a 953,271 ms timeout still remaining; `prepared_reviewers: 0`, `submitted_reviewers: 0`, `mutation_outcome: none` |
| 2 | full branch, 53 files, **19,872 lines** | `consent-declined-this-candidate`; `lineage_created: false`, `mutation_outcome: none` |

Neither burned authority. Neither produced a lineage that needed abandoning.

## Why the second attempt was wrong on my part

I asked for a review of the accumulated branch. 19,872 lines across 53 files
is the entire port, not a reviewable candidate. The contract says the candidate
is a work-unit commit or a PR slice, "never the accumulated feature branch",
and I keep re-learning that the hard way.

The structural reason it happened: **the review projection is `base-ref..HEAD`.**
Once three slices are merged, there is no way to ask for just one of them
without moving HEAD.

## Slice sizes, for the record

| Slice | Diff | Tests added |
|---|---|---|
| backfeed + consolidation | 2,636 insertions | 61 |
| documents | 2,433 insertions, 1 deletion | 52 |
| mcp | 2,208 insertions | 54 |

Every one exceeds the 400-line human review budget and is large for the
reviewer context too. Even reviewed individually, backfeed alone would likely
decline for size.

## What verification does exist

This is not "no verification". Each slice was verified empirically against the
live oracle before merge:

- **420/420 tests** across 13 files (253 carried from Wave 0, 167 new).
- **backfeed**: full lifecycle differential (flag → queue → get → approve →
  double-approve → reject → approve-after-reject), 32 ordered error probes,
  upsert semantics, and post-approval DB state compared row by row including
  `round(confidence,4)`, `verified`, `source_kind`, `pipeline`.
- **documents**: 78 differential scenarios through the real `dist/index.js`
  entrypoint, plus a row-by-row comparison of stored metadata.
- **mcp**: no Python oracle is possible — the reference MCP server cannot
  import (see `mcp-server-broken-in-reference.md`). Formatters were goldened by
  executing the real CPython functions directly, and the protocol was driven
  through a real stdio handshake.
- I independently re-verified each merge's router mount against the oracle,
  matching the exact 404 detail strings rather than just status codes.

## What that verification does not replace

No adversarial lens read this code. The reliability, resilience, readability
and risk lenses never ran. Differential testing proves the port matches the
oracle on the paths probed; it does not ask whether a design is sound, whether
an error is swallowed, or whether a hand-written multipart parser has a
pathological input.

Known specific gaps, from the slices' own handoffs:

- The multipart parser matches 78 scenarios but was never probed with RFC 2231
  `filename*`, header folding, or non-UTF-8 part charsets.
- `mcp.ts` hand-rolls `formatFixed2`, `pyFloatToString` and `encodeQuery` to
  match CPython; fuzz-verified against CPython but unread by a reviewer.
- The non-empty `context`/`traverse` formatter branches are tested against
  synthetic bodies, because those endpoints need LLM credentials.

## Decision

Accepted as a documented gap rather than pursued further. Wave 1 is verified,
not reviewed.

## What changes for Wave 2

Review moves **before merge**, on the worktree branch, while each candidate is
small. Oleada 1 cannot be retrofitted — the granularity is already gone.
