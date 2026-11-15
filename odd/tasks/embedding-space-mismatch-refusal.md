# Refuse to answer when the active embedding space disagrees with the stored one

Feature branch `fix/gateway-embeddings-base-url`. Stored vectors were produced in one vector space; if
the active configuration produces a different one, retrieval must fail loudly rather than degrade
quietly. This is a separate outcome from the gateway endpoint split and gets its own commit, per the
rule ratified for this branch: putting two answers in one diff makes it unreviewable.

## Specs

**S1 — A model or dimension mismatch against stored state is an ERROR.** Verbatim from the assignment:
"A model/dimension mismatch against stored state is an ERROR, not a warning. The stored vectors are
`hf:nomic-ai/nomic-embed-text-v1.5` at 768 dimensions (`wiki.embedding_store_meta`, `vector_dims` 768
across every row). **An embedding produced in a different space answers confidently and wrongly** —
that is the failure this test exists to prevent, and a `200` is not a pass."

**S2 — The enforcement point is stored-state agreement, not config-time policing.** Today a mismatch is
neither a warning nor an error: it *degrades*. `isStaleConfiguration` (`packages/wiki/src/utils/embeddings-load.ts:443`)
returns `!storeMatchesActiveEmbedding(store)` and the caller replaces the store with `null` via
`degraded()`; `assertStoreIntegrityInSql` (`packages/wiki/src/utils/embeddings-rank-sql.ts:161`) does the
same for the SQL path. Scoring then skips every candidate, so retrieval returns nothing instead of
refusing. Degradation must become a named error.

**S3 — `findEmbeddingModelProblem` keeps its current semantics, unchanged.** Its three early returns
(`packages/llmwiki-kg/ts/src/wiki-credential-fallback.ts:392-400`) deliberately permit any
operator-chosen model: they return `null` when `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` or
`LLMWIKI_EMBEDDING_MODEL` is present, and only refuse a purely derived default. That behaviour is pinned
by `wiki-credential-fallback.test.ts:208-230`, and closing it would refuse every deployment that named a
model — which is every real deployment. This feature does not police the operator's choice; it checks
that choice against what the store actually holds.

**S4 — The error names both sides.** The message must state the store's recorded model and dimensions and
the active model and dimensions, so an operator can tell which side to change. Values of environment
variables are never printed; model ids and dimension counts are configuration, not secrets.

**S5 — Degrading stays the behaviour when there is no store to disagree with.** An absent or
uninitialised `wiki.embedding_store_meta` row is not a mismatch. Only a present store whose recorded
identity disagrees with the active configuration is an error. Over-refusing on a fresh install would
break first-run deployments.

**S6 — Agreement is pinned as unchanged.** When the active configuration matches the store, retrieval
behaves exactly as it does today: candidates are scored, results are returned, no error surfaces. Every
existing deployment with a matching store is on this path.

**S7 — The check is observed through the public interface.** The test asserts the returned error and its
content through the retrieval entry point, never internal storage or a private helper's boolean.

**S8 — Deferred observation, recorded not fixed.** `EMBEDDING_ENDPOINT_VARS`
(`packages/wiki/src/utils/embedding-provider.ts:88-94`) has no `gateway` entry, so endpoint drift between
two gateway hosts is not part of the store fingerprint. Record it here; do not fix it in this feature.

## Tasks

- **T1** — RED: a test that presents a store whose recorded model or dimensions disagree with the active
  configuration and asserts a named error, not an empty result. Assert every observable effect: the
  error, its message content naming both sides, and that no scored results are returned. Route:
  `gentle-ai-worker`. Commit: pending.
- **T2** — S6 pin: a test that proves a matching store still returns scored results with no error.
  Route: `gentle-ai-worker`. Commit: pending.
- **T3** — S2, S4, S5: turn the degraded branch into a named error at the retrieval entry point, leaving
  the no-store path degrading as today. Route: `gentle-ai-worker`. Commit: pending.
- **T4** — Gates with Node 24 PATH (`gates:static`, `build`, `test:affected`) and the work-unit commit.
  Route: `gentle-ai-worker`. Commit: pending.

## Log

**L1 — the assignment, verbatim.**
"3. **A model/dimension mismatch against stored state is an ERROR, not a warning.** The stored vectors
are `hf:nomic-ai/nomic-embed-text-v1.5` at 768 dimensions (`wiki.embedding_store_meta`, `vector_dims`
768 across every row). **An embedding produced in a different space answers confidently and wrongly** —
that is the failure this test exists to prevent, and a `200` is not a pass."

**L2 — the specification this implements, verbatim from
`docs/provider-endpoint-resolution-hazards.md` (branch `docs/ingest-dimension-observability` @
`bc5bfec4`).**
"A wrong model id is a perfectly valid request. It returns `200` and a vector of the wrong width — or the
right width drawn from a different space — and the only place the contradiction surfaces is arithmetic
that nobody checks." / "For retrieval, acceptance is **consistency with stored state** — model and
dimension match — not the absence of an HTTP error. A test for an embedding path should assert the
**resolved model and dimension against what the store records**, so a mismatch fails loudly at test time
instead of degrading quietly at answer time. `200` is evidence that a server answered; it is not evidence
that the vectors are comparable."

**L3 — hard constraints, verbatim.**
"**Never print a connection string, URL value, token or key.** Report host *variable names*, never
values, and presence booleans only." / "**Use a scripted double or a local endpoint for every test.**" /
"**Do not start or stop the `kg-mcp-live` container.** Do not contact the `aks` database." Node 24 PATH
for gates and commits: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

**L4 — decomposition decision.** Kept separate from the endpoint split. Verbatim, from the Manager's D3
ratification: "Hiding a security-contract change inside a config-splitting diff is exactly what makes it
unreviewable." Applied to this feature for the same reason: it changes retrieval behaviour, not
configuration resolution.

**L5 — T1 RED, first execution of this feature's test file, at HEAD in a detached scratch worktree
(`git worktree add --detach "$BASE/head" HEAD`, test file copied in, `node <main>/node_modules/vitest/vitest.mjs`
invoked directly).** Verbatim: `Tests 5 failed | 5 passed (10)`; the SQL case failed with
`AssertionError: expected undefined to be 'EmbeddingSpaceMismatchError' // Object.is equality` — no error was
thrown at HEAD. Behavioural probe output at HEAD, verbatim:
`IN-MEMORY_OUTCOME={"threw":false,"value":{"refs":[],"warnings":[{"code":"embedding-index-outdated",...}]},"embedCalls":0}` /
`SQL_OUTCOME={"threw":false,"value":{"kind":"degraded","code":"embedding-index-outdated",...},"statements":2}`.
Both retrieval paths degraded to an EMPTY answer at HEAD; neither refused.

**L6 — S2 completed on the SQL path.** `assertStoreIntegrityInSql` no longer builds its own degraded result for
a configuration disagreement: it calls the exported `embeddingSpaceMismatch` with the header
(`model`, `dimensions`, `fingerprint`) and throws the returned `EmbeddingSpaceMismatchError`, so both paths
refuse with the same class and the same message. `storeMatchesActiveEmbedding` is untouched (its migration
caller depends on the boolean). S5 preserved: `row === undefined` still degrades before the comparison, and
`embeddingSpaceMismatch(null)` returns null by construction. Verified evidence:
`vitest run test/embedding-space-mismatch.test.ts test/dimensions/min-similarity-floor.test.ts` → 13 passed;
`tsc --noEmit` and `typecheck:tests` both exit 0.

**L7 — four existing DB-backed tests pin the behaviour this feature replaces, and three files are OUTSIDE the
allowed edit surfaces.** They must assert the refusal instead of the degradation, and that is a disposition
decision this task may not take:
`test/dimensions/wiki-rank-chunks-parity.test.ts` "degrades with embedding-index-outdated when the store was
built by another model" (L6's change); `test/embeddings-database.test.ts` "the loader reads its store through
the database seam > degrades a store whose configuration does not match the active model";
`test/embeddings-store-inputs.test.ts` "records NULL for a digest it cannot vouch for, and still refuses it"
and "records NULL for an empty endpoint and STILL refuses the mismatched digest" (the last three from the
in-memory conversion already in the tree, not from L6).

**L8 — S4 closed: a fingerprint-only mismatch is described as one.** `describeSpaceMismatch` split into two
sentences, because the two mismatches are different facts. Model ids that DIFFER keep their original wording
byte-for-byte (verified by a scratch differential against the pre-change implementation over five headers:
identical in every case). A store whose model id AGREES and whose fingerprint does not is no longer rendered
as `model "X" … resolves to model "X"`: the id is printed once as the shared fact, followed by
"through a different embedding configuration — a different endpoint or provider —" and both shortened
fingerprints. `resolveEmbeddingFingerprint()` is `embeddingIdentityDigest`, a SHA-256 hex digest, so a
12-character prefix of each side is printable and reveals nothing about the endpoint a credential may ride
in; a stored value that is not that shape is withheld, and an absent one prints `(not recorded)` plus the
reason the store cannot be vouched for. RED observed first: `Tests 1 failed | 10 passed (11)`,
`AssertionError: expected 2 to be 1` on the model-id occurrence count. Green: the same file at 11 passed,
focused suite 58 passed.

**L9 — the lint gate is green again without touching the baseline.** `test/embedding-space-mismatch.test.ts:197`
failed `max-lines-per-function` at 44 lines. The `describe` was split into two — message content, and the
entry-point/no-value-leak pairing — leaving callbacks of 38 and 23 effective lines, no assertion dropped, and
249 effective lines in the file (cap 399). `pnpm run lint` → `ESLint ratchet: 1687 files scanned; 558
baseline violations in 396 files across 423 rule/file entries; no regression.` `lint:update` was NOT run.
