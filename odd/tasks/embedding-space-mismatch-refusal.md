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
  `gentle-ai-worker`. Commit: `59ff6eb8` (T1).
- **T2** — S6 pin: a test that proves a matching store still returns scored results with no error.
  Route: `gentle-ai-worker`. Commit: `59ff6eb8` (T2).
- **T3** — S2, S4, S5: turn the degraded branch into a named error at the retrieval entry point, leaving
  the no-store path degrading as today. Route: `gentle-ai-worker`. Commit: `59ff6eb8` (T3).
- **T4** — Gates with Node 24 PATH (`gates:static`, `build`, `test:affected`) and the work-unit commit.
  Route: `gentle-ai-worker`. Commit: `59ff6eb8` (T4, the gates and the work-unit commit); the changelog
  lands separately in `bf79a294`.

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

**L10 — L7 undercounted the tests that pinned the retired contract: there was a FIFTH.** L7 records FOUR DB-backed
tests asserting the degraded behaviour. The suite-wide run (`turbo run test --filter=//`, `Test Files 838 passed |
4 skipped (842)`, `Tests 6319 passed | 11 skipped (6330)`) proved a fifth that the four-file search had missed:
`test/embeddings-validation.test.ts`, case `degrades instead of ranking a store built by a different embedding
model`, which asserted `expectDegradedStore(root, "embedding-index-outdated")` for a store whose model was
`some-other-model`. It now reads `refuses instead of ranking a store built by a different embedding model` and
asserts the refusal and both sides through `spaceRefusalOf` / `expectSpaceRefusalNamesBothSides`.

This is a correction to L7's count, not a change to any spec. S1 and S2 always covered this case; L7's list was
simply incomplete, and it was found by running the whole suite rather than by reading harder. The file also
carries the deliberate contrast in its header comment: integrity failures still degrade, a store from another
embedding space does not.

**L11 — `fallow:ci` found three clone groups introduced by this change set, all test-only.** Two flavours:
duplicated space-refusal assertions across the re-pointed test files, and an alpha-page seed that
re-implemented an existing fixture. Remedy: a new shared fixture `test/fixtures/embedding-space-refusal.ts`,
mirroring the existing
`test/fixtures/embeddings-degrade.ts` on the other side of the same contract, exporting `spaceRefusalOf` and
`expectSpaceRefusalNamesBothSides` so both sides of the contract are asserted the same way by every suite.

No assertion was dropped: `test/embedding-space-mismatch.test.ts` had 11 tests before and after this
consolidation. The duplication was worth removing on its own terms — a copy that drifted to assert only the
class, or only one of the two sides, would stay green while the diagnostic it guards lost the half an operator
needs to act on.

**L12 — a `@repo/foundation` type-only edge was introduced, and not by declaring it.**
`test/embedding-space-mismatch.test.ts` imported `DatabaseHandle` for its scripted handle, which made the root
test tier a type-only dependent of `@repo/foundation`; `test/package-selection-union.test.ts` requires every
such dependent to be declared, so the suite refused it. Resolved instead by expressing the type structurally as
`Parameters<typeof rankChunksInSql>[0]` (`test/embedding-space-mismatch.test.ts:187`), which keeps the file a
behavioural test of the function it calls rather than a declared consumer of an internal package type, and
leaves `TYPE_ONLY_DEPENDENTS` in `scripts/package-selection.ts` untouched.

The alternative a reviewer may prefer: declare the edge rather than infer the type — a two-line revert of that
import plus one annotation entry in `TYPE_ONLY_DEPENDENTS`. It names the dependency honestly and reads more
directly, at the cost of a test-side declaration the union test now has to keep in step with the package graph.

**L13 — S4 was initially unmet for a fingerprint-only mismatch, and the fix is a different sentence, not a
wider one.** The first implementation printed the same model id on both sides and never showed the one thing
that differed. `describeSpaceMismatch` now branches on which side disagrees: model ids that differ keep their
original wording byte-for-byte, and a store whose id AGREES while its fingerprint does not is described as a
configuration change — the id printed once as the shared fact, then a 12-character prefix of each side's
SHA-256 digest (`embeddingIdentityDigest`).

Recorded guard: a stored value that is not a 64-hex digest is withheld and rendered `(not recorded)`, because a
value of another shape could be raw configuration — an endpoint, or something carrying a credential — and
printing a prefix of it would leak exactly what the fingerprint exists to keep unprintable. L8 holds the
behavioural detail; this entry records why the branch exists at all.

**L14 — the verifier round found the refusal swallowed at THREE call sites, not one, and the correction is
this feature's last code change.** `59ff6eb8` raised `EmbeddingSpaceMismatchError` correctly and every
catch-all above it turned it back into an empty answer: `materializeForPages` (`search/retrieval.ts:258`)
and `selectViaEmbeddings` (`search/retrieval.ts:216`), plus `searchChunks`
(`dimensions/wiki/reader.ts:156`). Before the fix, a store from another embedding space produced an empty
page list with no warning and no fallback on those paths — the loud refusal silently reduced to silence one
call site up, which is L5's measured behaviour arriving by a second route. All three rethrow now, and every
other error keeps its previous behaviour, including the reader's capability-gap `return []`.

The refusal is classified by error **class**, never by message text. A message-matching guard would let a
future rewording of `describeSpaceMismatch` quietly restore the swallow, and L13 shows that message has
already been rewritten once.

**The governing principle, stated so it survives its authors.** `embeddingFailure: "fallback"` is documented
as opt-in recovery from *embedder* failures. A space mismatch is a completed request that produced
incomparable vectors — not transient, not retryable — so that opt-in must not reach it. Genuine embedder
failures still degrade to the LLM and index fallbacks, byte-identically. The opt-in is a tolerance for a
flaky dependency, not a licence to rank vectors from a different space.

`describeSpaceMismatch` no longer states that a store "records no fingerprint" when a fingerprint exists
but cannot be printed safely. The two cases now read differently, because they need different fixes: an
absent header means rebuild the index, an unprintable one means the row holds something that is not a
digest. A store model id is printed only when it matches a model-id shape, for L13's reason at one more
surface — a hand-edited row could otherwise place a URL, and therefore the credential sitting in its
userinfo, into an operator's log.

Commit: `a3255f2a00bc9234b76d8f8972048aee9d23dee2`. Gates at that tree, Node 24 PATH: `gates:static` all
6 passed (24.2 s, ratchet `1689 files scanned; 558 baseline violations in 396 files across 423 rule/file
entries; no regression`), `build` exit 0, and the full unit tier through turbo (`Test Files 839 passed |
4 skipped (843)`, `Tests 6329 passed | 11 skipped (6340)`, `1 successful`, `Cached: 0 cached`) because
`test:affected` exits 78 by design and refuses to choose a narrower scope.
