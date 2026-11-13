# embedding-store-input-unknown-not-empty

A fingerprint input that the redaction cut reduces to nothing is recorded as `""` in
`wiki.embedding_store_meta.backend`/`.endpoint` instead of SQL `NULL` — so the column whose
whole purpose is not to lie stores the false claim "the endpoint IS empty". Branch
`fix/empty-endpoint-records-unknown`, base `db3e73ba9611845ab4e227c56c56db1f2798df18`.

## Specs

S1. `wiki.embedding_store_meta.backend` and `.endpoint` record the fingerprint's inputs when,
and only when, `sha256(identity) === store.fingerprint` and `store.model === identity.model`;
otherwise SQL `NULL`. The rule is "provably the digest's inputs, or unknown, never a guess".

S2. A value that normalises to empty or whitespace-only records `NULL`, on BOTH columns, on
every path that can produce it. The normalisation lives at the recording seam
(`recordableFingerprintInputs`), not inside `redactEndpointCredentials` /
`cutAtControlCharacter` / `redactUrlCredentials` / `redactAuthorityCredentials`, whose
contract stays "return a string". Emptiness is tested with `trim()`; a non-blank value is
recorded UNCHANGED — no trimming, lowercasing, or other rewrite.

S3. The assertion is `NULL`, not falsy/empty: every pinned case asserts the column with
`toBeNull()` or `toBe("...")`, never truthiness and never `""`-versus-falsy.

S4. The digest, the sha256/model comparison, the write-path admission gate, the SQL and the
migration are unchanged.

## Tasks

T1. Create this feature document. Route: inline. Commit: `docs(odd): track embedding input unknown-not-empty fix`.
T2. RED — extend `test/embeddings-store-inputs.test.ts` through the existing seam; observe `""` written for the new NULL cases. Route: inline. Commit: with T3.
T3. Fix + GREEN — emptiness→NULL normalisation in `recordableFingerprintInputs` for both inputs; focused test passes, nine existing cases untouched. Route: inline. Commit: `fix(embeddings): record NULL when a fingerprint input normalises to empty`.
T4. Gates — `npx tsc --noEmit`, `npm run typecheck:tests`, `npm run lint` (ceiling 558 / 396 / 423), `npm run fallow:ci`, `npm run test:affected`. Route: inline. Commit: none.
T5. Commit the behavioural unit (tests + normalisation together). Route: inline. Commit: as T3.

## Log

L1 (defect statement): `packages/wiki/src/utils/embeddings-database-write.ts` records the fingerprint's inputs into `wiki.embedding_store_meta.backend` / `.endpoint` when, and only when, `sha256(identity) === store.fingerprint` and `store.model === identity.model`; otherwise SQL NULL. The rule is "provably the digest's inputs, or unknown, never a guess". Today a value that the redaction cut reduces to nothing is recorded as `""`. An empty string is a claim that the endpoint IS empty; NULL says "unknown". So the column whose whole purpose is not to lie stores a false fact. Confirmed path: `cutAtControlCharacter` with `controlAt === 0` returns `""`. The fix is one normalisation at the recording seam, applied to BOTH inputs, with `trim()` for the emptiness test only and the recorded value left unchanged when non-blank. Do NOT touch the digest, the sha256/model comparison, the write-path admission gate, the SQL, or the migration. If the empty case also lets a MISMATCHED store through, STOP and report instead of fixing.
