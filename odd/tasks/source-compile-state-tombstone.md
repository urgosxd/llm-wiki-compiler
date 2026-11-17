# source-compile-state-tombstone — let a compile record outlive its document

**Branch:** `fix/source-compile-state-outlives-source`, cut from `refactor/stack-id-inline-readers` at base commit `66c41087f85d4104f67004f3418e11ac89a68d72`.
**Scope:** T15, the ROW-mode half of the graph-retirement disability: `wiki.source_compile_state` must be able to hold the compile record of a source whose `wiki.source_documents` row is gone, so a non-review `compile` can see the deletion and reach `forgetDeletedSources`.

## Specs

### S1 — the operator's question

**Requirement (manager, verbatim):**

> what should a retired source leave behind?

### S2 — the measured defect

**Requirement (manager, verbatim):**

> `wiki.source_compile_state` keys on `source_identity` with `on delete cascade` from `wiki.source_documents` (`packages/wiki/src/dimensions/wiki/schema.sql:356-359`). `listSourceDocuments` reads `source_documents` unfiltered, so a source that no longer exists is not in the listing; and because the compile-state row cascaded away with it, nothing remembers it was ever compiled. So `findDeletedDocuments` is always empty and `compiler/index.ts` returns before `forgetDeletedSources`.

### S3 — the deliverable: say the word "tombstone" and defend it

**Requirement (manager, verbatim):**

> the deliverable must state, in one paragraph, what the row store now keeps after a source is deleted, who reads it, and how long it lives. A compile-state row that outlives its source is a tombstone; say the word and defend it, because the next person to look at that table will otherwise assume the cascade was intentional.

**Answer — what a retired source leaves behind.** After a source is deleted, `wiki.source_compile_state` keeps that source's last compile record — `source_identity`, `compiled_hash`, `concept_slugs`, `entities`, `extraction`, `output_language`, `source_ref`, `compiled_at` — while `wiki.source_documents` holds no row for it and no longer has to. That row is a **tombstone**: it is the only thing left in the store that can still name a source whose document is gone, which is exactly why the `source_compile_state_document_fkey` cascade was the bug — a record that is deleted in the same instant as the document it describes cannot report a deletion. The tombstone is read by `readCompileStateRows` (`packages/wiki/src/dimensions/wiki/wiki-state-source.ts:115`), which reassembles it into `state.sources[identity]`, and then by `findDeletedDocuments` (`packages/wiki/src/compiler/hasher.ts:172`), which subtracts the identities the row store still lists from the identities the state still records, so a recorded identity with no document becomes `status: "deleted"`; `compile` folds that into `buckets.deleted`, `deletedSourceIdentities` (`packages/wiki/src/compiler/index.ts:1553`) captures the identity, and `forgetDeletedSources` (`:1596`) retires the graph rows. Retirement needs only the identity, never the document — which is the whole reason the record has to survive it. It lives until a state flush no longer lists the identity: `writeWikiStateToRows` deletes every `source_compile_state` row whose `source_identity` is absent from `state.sources` (`wiki-state-source.ts:200`), and a non-review compile reaches that state by retiring the source (`orphan.ts:72` `draft.removeSource`), so the tombstone's life is "from the deletion until the compile that acts on it finishes". A **review** compile deliberately does not shorten it: nothing is retired, the flush still lists the identity, and the deletion stays recorded for the next run that may act on it. Deleting the whole Stack still takes the tombstone with it, because `stack_id uuid not null references stacks(id) on delete cascade` is untouched — the tenancy cascade stays, only the per-document one goes.

### S4 — RED: the deletion made observable, asserted as an outcome

**Requirement (manager, verbatim):**

> compile twice with the second run's input missing a source that the first run compiled, and assert the retirement happened — a `deleted: 1` in the compile result, and the graph entity gone. Assert the OUTCOME, not the error message.

### S5 — the touched-behaviour pin: a modified source is recompiled, not retired

**Requirement (manager, verbatim):**

> a source that is merely modified must still be recompiled, not retired. A tombstone that swallows updates would be a worse bug than the one being fixed.

### S6 — the migration mechanism, its reversibility, and what it CANNOT recover

**Requirement (manager, verbatim):**

> State the mechanism, whether it is reversible, and what happens to a database where prior deletions already removed their compile-state rows — those deletions are lost, and no migration recovers them. Say that plainly; do not imply a backfill can reconstruct history it never had.

**Mechanism.** One `alter table wiki.source_compile_state drop constraint if exists source_compile_state_document_fkey;` in `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql`, which `scripts/apply-schemas.sh:89` applies on every run. It drops a constraint; it adds, removes and rewrites **no row**, so it is safe to re-run and safe on a database built from `schema.sql`, where the constraint no longer exists and the statement is a no-op. It is applied to `test/fixtures/wiki-schema-pre-db-parity.sql` (frozen, unedited, still carrying the constraint) by `test/dimensions/db-parity-migration.test.ts`, which is what proves the migrated shape equals a fresh install.

**Reversible?** Re-applying the constraint is possible (`alter table … add constraint …`), but only for a database whose tombstones are gone: once a tombstone exists, the constraint cannot be re-added without first deleting the offending rows, because they reference a document that no longer exists.

**What it does NOT recover.** Every deletion that happened while the cascade was live already deleted its compile-state row, and this migration does **not** bring those rows back. There is no backfill and none is possible: the record of what was compiled was destroyed by the same delete that removed the document, so the stored data contains no trace from which it could be reconstructed — the file is gone, the document row is gone, and the compile record is gone. So on an existing database, a source deleted before this migration stays invisible forever: its graph rows are never retired by this mechanism, and a re-ingest of the same identity starts over as a new source. The migration changes what happens **from now on**; it does not restore history it never had.

### S7 — the gate constraint

**Requirement (manager, verbatim):**

> the goal is a gate that is green for the first time in this campaign, with zero failures outside the three T15 files. If a fix makes those five pass and breaks something else, that is not a fix.

## Tasks

- [x] T1 author this document: header, `S1`–`S7` quoted verbatim, tasks, and the tombstone paragraph `S3` owes. S1-S7. worker. —
- [x] T2 drop `constraint source_compile_state_document_fkey` (and only that constraint) from `packages/wiki/src/dimensions/wiki/schema.sql`, keeping `stack_id … references stacks(id) on delete cascade`, the `(stack_id, source_identity)` primary key and every column, and leave a comment stating why the record may outlive its document. S2, S3. worker. —
- [x] T3 add the idempotent `alter table wiki.source_compile_state drop constraint if exists source_compile_state_document_fkey;` to `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql`, in that file's existing idiom, and remove the same constraint from that file's own `create table if not exists wiki.source_compile_state` copy. S6. worker. —
- [x] T4 prove the schema is representable for existing databases: `vitest run test/dimensions/db-parity-migration.test.ts` (frozen fixture + migration equals a fresh install), plus the RED set and `test/mcp/retired-parity-payloads.test.ts`. S4, S6, S7. worker. **Parity GREEN (9/9), payload GREEN (3/3), and the RED set GREEN `Test Files 4 passed (4)` / `Tests 8 passed (8)`. The RED set went `5 failed | 2 passed` → `1 failed | 7 passed` on row staging alone (see `L4`), and the last failure was the authorized assertion correction in `L5`. `S4`'s RED itself is on record and NOT re-observable without reverting the schema change, which is forbidden.**
- [x] T5 the modified-source pin: a source that is merely modified is still recompiled, not retired. S5. worker — `test/compiler/graph-retirement-modified-source.test.ts`, GREEN (`1 passed`); see `L4`. —
- [x] T6 the gate of record, `corepack pnpm exec turbo run test --filter=//`, compared against the base population of 862 with zero failures outside the three T15 files. S7. lead (parent-owned; not run by this agent). **GREEN: exit 0, `1 successful, 1 total`, `Test Files 858 passed | 5 skipped (863)`, `Tests 6435 passed | 12 skipped (6447)`. Population reconciled: 863 = the pre-committed 862 + the ONE file this fix ADDS (`test/compiler/graph-retirement-modified-source.test.ts`), so no base file is missing. `gates:static` is 6 of 6 (see `L6`).** —

## Log

**L1 (decision — the recorded request, verbatim).** The assignment as received:

```text
Feature document + schema change for T15 in /home/urgosxd/.herdr/worktrees/llm-wiki-compiler/fix-source-compile-state-outlives-source (branch fix/source-compile-state-outlives-source at base 66c41087f85d4104f67004f3418e11ac89a68d72, deps installed).

## Allowed edit surfaces
- `odd/tasks/source-compile-state-tombstone.md` (create)
- `packages/wiki/src/dimensions/wiki/schema.sql`
- `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql`

Do NOT edit any test file, do NOT edit `test/fixtures/wiki-schema-pre-db-parity.sql`, do NOT edit `scripts/apply-schemas.sh`, do NOT commit, do NOT push. Never print a connection string, URL with userinfo, token, key or env value; do not read or edit `.env`.

## Step 1 — write the feature document FIRST, before any source edit
Create `odd/tasks/source-compile-state-tombstone.md` in the house shape: a 2-3 line header, then `## Specs`, then `## Tasks`, then `## Log` last.

`## Specs` must carry numbered `S#` entries that quote the assignment verbatim (do not paraphrase, do not add requirements):

- S1 — the operator's question, verbatim: "what should a retired source leave behind?"
- S2 — the measured defect, verbatim: "`wiki.source_compile_state` keys on `source_identity` with `on delete cascade` from `wiki.source_documents` (`packages/wiki/src/dimensions/wiki/schema.sql:356-359`). `listSourceDocuments` reads `source_documents` unfiltered, so a source that no longer exists is not in the listing; and because the compile-state row cascaded away with it, nothing remembers it was ever compiled. So `findDeletedDocuments` is always empty and `compiler/index.ts` returns before `forgetDeletedSources`."
- S3 — the deliverable, verbatim: "the deliverable must state, in one paragraph, what the row store now keeps after a source is deleted, who reads it, and how long it lives. A compile-state row that outlives its source is a tombstone; say the word and defend it, because the next person to look at that table will otherwise assume the cascade was intentional."
- S4 — RED, verbatim: "compile twice with the second run's input missing a source that the first run compiled, and assert the retirement happened — a `deleted: 1` in the compile result, and the graph entity gone. Assert the OUTCOME, not the error message."
- S5 — the touched-behaviour pin, verbatim: "a source that is merely modified must still be recompiled, not retired. A tombstone that swallows updates would be a worse bug than the one being fixed."
- S6 — the migration requirement, verbatim: "State the mechanism, whether it is reversible, and what happens to a database where prior deletions already removed their compile-state rows — those deletions are lost, and no migration recovers them. Say that plainly; do not imply a backfill can reconstruct history it never had."
- S7 — the gate constraint, verbatim: "the goal is a gate that is green for the first time in this campaign, with zero failures outside the three T15 files. If a fix makes those five pass and breaks something else, that is not a fix."

`## Tasks`: one line per task with ID, linked `S#`, route, commit (commit left `—` until known). At least: T1 author the document; T2 drop the constraint in schema.sql; T3 add the idempotent drop to the migration; T4 verify parity; T5 the modified-source pin.
`## Log`: `L1` = this whole assignment, verbatim, as the recorded request. Then `L2` recording the measured evidence that confirmed the hypothesis, quoting `odd/tasks/single-stack-authority.md:143-145` ("seeding the deletion row a removed source would leave behind is refused with `source_compile_state_document_fkey`").

## Step 2 — the schema change
`wiki.source_compile_state` must be allowed to hold a compile record whose `wiki.source_documents` row is gone. In `packages/wiki/src/dimensions/wiki/schema.sql` remove ONLY the composite constraint

```
constraint source_compile_state_document_fkey
    foreign key (stack_id, source_identity)
    references wiki.source_documents (stack_id, source_identity)
    on delete cascade
```
Keep `stack_id uuid not null references stacks(id) on delete cascade`, the primary key `(stack_id, source_identity)`, and every column. Replace the removed constraint's place with nothing (a trailing comma must not be left dangling) and, per the repo's comment style, leave a short comment stating WHY the record may outlive its document (it is the deletion record: it is the only thing that can still name a source whose document is gone).

## Step 3 — the migration
`scripts/apply-schemas.sh:89` applies `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql` on every apply, and `test/dimensions/db-parity-migration.test.ts` proves that (frozen pre-migration fixture + migration) equals (a fresh install from `schema.sql`). So add to the migration file, in the same idempotent style the file already uses, an explicit:
`alter table wiki.source_compile_state drop constraint if exists source_compile_state_document_fkey;`
Read the file first and match its existing idiom and comment style exactly. If the migration file ALSO contains its own `create table if not exists wiki.source_compile_state` copy with the constraint, remove the constraint there too so a database created by the migration does not re-impose it. Do not touch the frozen fixture.

## Step 4 — checks (report literal output, do not summarize)
Run, with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` and `corepack pnpm exec`:
1. `vitest run test/compiler/graph-retirement-port-invocation.test.ts test/compiler/graph-retirement-retires-source.test.ts test/compiler/graph-retirement-tenant-scope.test.ts` — these are the RED set: the 5 failures captured before your change were `deleted: 0` where 1 or 2 was expected, plus `expected [] to have a length of 1`. Report pass/fail per test literally. If ANY still fails, do NOT add more changes to force it: report the literal failure and stop.
2. `vitest run test/dimensions/db-parity-migration.test.ts` — must be green; the fixture-plus-migration path is what proves the change is representable for existing databases.
3. `vitest run test/mcp/retired-parity-payloads.test.ts` — a payload test whose comment assumes the cascade; it must stay green.
4. `git status --porcelain` — report which files changed.

## Return
The exact files you changed, the literal before/after of the constraint region, the literal test output for steps 1-3 (counts plus any failure text), the tombstone paragraph you wrote into the document (S3), and a blunt statement of what the migration does NOT recover (S6). Mark clearly any check that failed or did not run.
```

**L2 (measured) — the hypothesis was confirmed by prior measurement, and the evidence is quoted rather than re-derived.** `odd/tasks/single-stack-authority.md:143-145` records the impossibility in the words the assignment quotes: "seeding the deletion row a removed source would leave behind is refused with `source_compile_state_document_fkey`" — with the mechanism named in the same sentence: `wiki.source_compile_state` carries `constraint source_compile_state_document_fkey` — `foreign key (stack_id, source_identity) references wiki.source_documents (stack_id, source_identity) on delete cascade` (`packages/wiki/src/dimensions/wiki/schema.sql:356-359`), and `listSourceDocuments` (`source-documents-store.ts:296-317`) reads `wiki.source_documents` unfiltered. Re-read in this tree to confirm the two halves still hold where the paragraph says: the constraint is at `schema.sql:356`–`:359`, and `findDeletedDocuments` at `hasher.ts:172`–`:177` is `Object.keys(prevState.sources).filter((identity) => !currentSet.has(identity))` — it compares the RECORDED identities against the identities the change-detection source lists, so a recorded identity with no document is exactly what it reports, `forgetDeletedSources` consumes only identities (`deletedSourceIdentities`, `index.ts:1553`), and the early return that makes the defect unreachable is `index.ts:1236` (`buckets.toCompile.length === 0 && buckets.deleted.length === 0`) in this tree rather than the `:1134` the older note cites. The hypothesis (the cascade is the bug; the compile record is the deletion record) therefore holds on the code, which is why the fix is one schema shape.

**L3 (measured) — the schema change, the migration, and the three checks, reported literally. The two schema checks are green; the RED set is UNCHANGED, and its cause is NOT the cascade.** Node `v24.21.0` on `PATH`, every invocation through `corepack pnpm exec`, cwd the repository root. No connection string, database URL, token or key is reproduced here or was printed by these commands beyond the harness's own redacted banner.

The before/after of the constraint region, literally. `packages/wiki/src/dimensions/wiki/schema.sql` BEFORE:

```text
    primary key (stack_id, source_identity),
    constraint source_compile_state_document_fkey
        foreign key (stack_id, source_identity)
        references wiki.source_documents (stack_id, source_identity)
        on delete cascade
);
```

AFTER — the constraint is gone and its trailing comma with it, replaced by the comment `S2`/`S3` ask for, and `stack_id uuid not null references stacks(id) on delete cascade`, the `(stack_id, source_identity)` primary key and every column are untouched:

```text
    -- Deliberately NO foreign key to `wiki.source_documents (stack_id, source_identity)`.
    -- This row must OUTLIVE its document, because it IS the deletion record: it is the
    -- only thing left that can still name a source whose document is gone. The
    -- `on delete cascade` that used to sit here deleted the compile record in the same
    -- instant as the document it describes, so a removed source left no trace at all:
    -- `findDeletedDocuments` compared against nothing, `buckets.deleted` stayed empty,
    -- and the graph was never retired. `stack_id` still cascades from `stacks`, so
    -- dropping a whole Stack takes its compile records with it.
    primary key (stack_id, source_identity)
);
```

`packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql` got the same removal in its own `create table if not exists wiki.source_compile_state` copy (so a database created by applying ONLY the migration cannot re-impose the key) plus, in that file's existing `-- =====` banner idiom, a section headed `Retire the document foreign key this table used to carry` ending in:

```text
alter table wiki.source_compile_state
    drop constraint if exists source_compile_state_document_fkey;
```

After the change, `grep -rn "source_compile_state_document_fkey" --include=*.sql --include=*.ts .` returns exactly three hits: the frozen fixture's `create table` (`test/fixtures/wiki-schema-pre-db-parity.sql:291`, untouched by design), and the migration's own comment and drop statement. No `create table` in the shipped schema declares it any more.

1. `corepack pnpm exec vitest run test/compiler/graph-retirement-port-invocation.test.ts test/compiler/graph-retirement-retires-source.test.ts test/compiler/graph-retirement-tenant-scope.test.ts` → **exit 1, `Test Files 3 failed (3)`, `Tests 5 failed | 2 passed (7)`**. Literally: `retires a deleted source from the graph exactly once` → `× AssertionError: expected +0 to be 1 // Object.is equality` at `:257` (`expect(result.deleted).toBe(1)`); `retires nothing for a deleted source with no recorded identity` → `× expected +0 to be 1 // Object.is equality` at `:268`; `retires each of two deleted sources once, under its own identity` → `× expected +0 to be 2 // Object.is equality` at `:278`; `graph retirement tenant scope > retires the deleted source only inside the Stack that owns it` → `× expected { compiled: +0, skipped: +0, …(4) } to match object { deleted: 1, errors: [] }` with the diff `- "deleted": 1` / `+ "deleted": 0` at `:166`. That is the same five failures the assignment captured BEFORE this change, with the same values: **nothing moved**, and the `expected [] to have a length of 1` line was never reached because the assertion above it (`result.deleted`) fails first. Per the assignment, no further change was made to force them.
2. `corepack pnpm exec vitest run test/dimensions/db-parity-migration.test.ts` → **exit 0, `Test Files 1 passed (1)`, `Tests 9 passed (9)`**, 596ms, two scratch databases built (`pre-migration`, `fresh-install`). This is the proof `S6` owes: database A = every file `scripts/apply-schemas.sh` lists with the wiki schema of record replaced by the frozen fixture (which still carries the constraint) and the parity migration excluded; database B = A + parity migration; database C = a fresh install from the CURRENT `schema.sql`. **B equals C in all six compared dimensions, `constraints` included**, so the migrated shape really has lost `source_compile_state_document_fkey` and A agrees — had the drop been missing from the migration, A would have kept the fixture's constraint and this suite would have named it.
3. `corepack pnpm exec vitest run test/mcp/retired-parity-payloads.test.ts` → **exit 0, `Test Files 1 passed (1)`, `Tests 3 passed (3)`**. The payload suite whose comment assumes the cascade stays green.

**Why the RED set did not move, measured rather than guessed — and this is a finding the parent needs, not a defence.** Those three files seed their deletion as a FILE: `seedDeletedSourceProject` (`test/compiler/retirement-port-project.ts:43`) writes `.llmwiki/state.json` naming `deleted-source.md` and leaves `sources/` empty, and their own docstring says the absence of `AKS_STACK_ID` keeps the state seams FILE-backed ("with the variable set, the draft would read `source_compile_state` rows instead and the seed would be invisible"). That premise no longer holds on this base: `resolveStackAuthority` (`packages/wiki/src/dimensions/stack-authority.ts:129`–`:133`) returns `file` ONLY when no database is configured, and `RETIREMENT_ENV` sets `AKS_DATABASE_URL` with `LLMWIKI_DIMENSIONS: "kg"`, so the run resolves a Stack (`resolveStackForDimensions` → `resolveStackForCommand`) and every seam gates on that one authority — `wikiStateRowsBackend`, `sourceChangeDetection`, `sourceContentReading` all return `undefined` only for `authority.kind === "file"` (`packages/wiki/src/compiler/index.ts:2187`–`:2192`, `:2167`–`:2172`, `:2148`–`:2153`). The seeded `state.json` is therefore never read: `state.sources` is empty, change detection lists the (empty) row corpus, and the run reaches `finalizeNothingToCompile` through `index.ts:1236` with `{ compiled: 0, skipped: 0, deleted: 0, errors: [] }` — exactly the observed object. **A cascade drop cannot make a file seed visible**, so the RED set needs the deletion recorded in ROWS (`insert into wiki.source_compile_state` for an identity with no `wiki.source_documents` row) — the very insert the constraint refused with `source_compile_state_document_fkey` before this change and now accepts. That is a test-file edit, which is outside this agent's allowed edit surfaces, so it is reported rather than performed. `S4`'s RED remains owed by whoever owns those seeds; this change is its prerequisite, not its replacement.

**L4 (measured) — T15 part 2: the deletion is staged in ROWS, the pin is GREEN, and one assertion in the RED set is unsatisfiable rather than mis-staged.** Row staging only; every assertion in the four test files is byte-identical to what the RED captured. `test/compiler/retirement-port-project.ts` gained `seedDeletedSourceRows` / `seedIdentitylessSourceRows` / `seedTwoDeletedSourceRows`, all routed through the production writer `writeWikiStateToRows` (`wiki-state-source.ts:182`) so the seeded record carries `source_identity` AND `source_ref` = `https://example.test/deleted-source` with NO `wiki.source_documents` row — the row the dropped constraint used to refuse. The three failing files now seed against the Stack the run itself resolves (`resolveStackForCommand(harness.db, env)`, the same resolver `resolveStackAuthority` calls), and the four docstrings that claimed `AKS_STACK_ID`'s absence keeps the seams file-backed were corrected: the PRESENCE OF A DATABASE decides, and `stackEnvWith` (`index.ts:451`) publishes a resolved Stack into a COPY of the run's env.

1. `corepack pnpm exec vitest run test/compiler/graph-retirement-port-invocation.test.ts test/compiler/graph-retirement-retires-source.test.ts test/compiler/graph-retirement-tenant-scope.test.ts test/compiler/graph-retirement-modified-source.test.ts` → **exit 1, `Test Files 1 failed | 3 passed (4)`, `Tests 1 failed | 7 passed (8)`.** Green: `retires a deleted source from the graph exactly once`, `retires nothing for a deleted source with no recorded identity`, `retires each of two deleted sources once, under its own identity`, `retires the deleted source only inside the Stack that owns it`, `is recompiled, not retired, while its compile record outlives the edit`, and both file-mode port cases. The single red is `a supplied port on the compile path > is called once with the request the run resolved`, now failing PAST the empty-request list on `expect(received[0].env).toBe(GRAPH_ENV)` at `:153` with `received[0].env` = `{ AKS_DATABASE_URL, AKS_STACK_ID, LLMWIKI_DIMENSIONS }`.
2. `corepack pnpm exec vitest run test/dimensions/db-parity-migration.test.ts` → **exit 0, `Tests 9 passed (9)`.**
3. `corepack pnpm exec vitest run test/mcp/retired-parity-payloads.test.ts` → **exit 0, `Tests 3 passed (3)`.**
4. `corepack pnpm run lint` → **exit 0, `ESLint ratchet: 1715 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.`**

**Why that last assertion cannot pass, measured, and why it is NOT this agent's decision.** The retirement port is handed the RUN's environment, which `stackEnvWith` builds as `{ ...env, AKS_STACK_ID: authority.stackId }` for every `kind: "stack"` authority (`index.ts:451`–`:458`), and `toBe` is reference equality — so no row-mode stage can satisfy it, and file mode never calls the port at all (`stackEnv` is the caller's object there, but the graph retirement is skipped). Before the row staging the assertion was never REACHED, because `expect(received).toHaveLength(1)` failed first; the case has therefore never passed on this base. Changing it (to `toMatchObject`, or to an equality on the published env) is a spec decision about what the port's request must carry, not a staging choice, so it is left untouched and reported.

**L5 (decision, then measured) — the ONE assertion this fix changes, recorded so it can be weighed alone.** `test/compiler/graph-retirement-port-invocation.test.ts` asserted `expect(received[0].env).toBe(GRAPH_ENV)`: reference equality against the CALLER's environment object. That assertion had never held on this base and was not reachable — `expect(received).toHaveLength(1)` above it failed first, because in row mode the file seed stated nothing the run reads and retirement (the only caller of the port) was never reached. Its cause is not narrowness but reference equality against an object production deliberately copies: `stackEnvWith` (`packages/wiki/src/compiler/index.ts:451`–`:458`) returns `{ ...env, [AKS_STACK_ID_ENV_VAR]: authority.stackId }` for every `kind: "stack"` authority, because every seam downstream must see the Stack the run RESOLVED, and a file authority publishes nothing so file mode stays bit-identical. The test's own docstring already stated the intent — "with the root, environment and Stack it resolved" — so the lead authorized replacing the assertion with exact equality on the PUBLISHED environment, the resolved id reused from `resolveStackForCommand(harness.db, GRAPH_ENV)`, plus an explicit non-mutation check on the caller's env object:

```ts
expect(received[0].env).toEqual({ ...GRAPH_ENV, AKS_STACK_ID: stackId });
expect(GRAPH_ENV).toEqual({ AKS_DATABASE_URL: DATABASE_URL, LLMWIKI_DIMENSIONS: "kg" });
```

`toEqual` over the whole object means an extra leaked key, a missing `AKS_STACK_ID`, or a mutated caller env each fail; it was NOT loosened to `toMatchObject` and NOT deleted. **No other assertion in the RED set was altered**, and the file-mode cases were not touched. Measured after the change, node `v24.21.0`, `corepack pnpm exec`: the four graph-retirement files → **exit 0, `Test Files 4 passed (4)`, `Tests 8 passed (8)`**; `corepack pnpm run lint` → **exit 0, `ESLint ratchet: 1715 files scanned; 558 baseline violations in 396 files across 423 rule/file entries; no regression.`** With that, the row-mode half of T15 is green end to end: the deletion is observable because the compile record outlives its document, and an EDIT is still a recompile rather than a retirement.

**L6 (measured) — the gate of record, its population reconciliation, and the one static gate `L5` left red.** The gate of record in item 1 was run and verified OUTSIDE this worker (parent-owned; its counts are transcribed verbatim below and not re-run here). Items 3–5 — the dedupe, every static gate and the working-tree shape — were measured by this worker, node `v24.21.0` on `PATH`, every invocation through `corepack pnpm exec`, cwd the repository root. No connection string, database URL, token, key or env value is reproduced here.

1. Gate of record, `corepack pnpm exec turbo run test --filter=//` → **exit 0, `1 successful`**, with the run's own completed test totals **`Test Files 858 passed | 5 skipped (863)`** and **`Tests 6435 passed | 12 skipped (6447)`** — zero failures anywhere, so zero failures outside the three T15 files by construction.
2. **Population reconciliation against the pre-committed 862, stated as arithmetic rather than as an explanation after the fact: 863 = 862 + 1.** The single added file is this fix's own `test/compiler/graph-retirement-modified-source.test.ts`, the `S5` pin; every one of the 862 base files is still collected, which is what "863 collected" has to mean for the reconcile to hold. Nothing is missing and nothing was replaced.
3. **The one change-caused static blocker, `fallow:ci`, and how it was closed — by sharing, not by suppression.** The gate reported `0 dead-code, 0 complexity, 2 duplication introduced since main` (verdict warn; 2 dead-code, 0 complexity, 2 duplication inherited, not counted), and both introduced clone groups named the new pin as an instance: (a) `test/compiler/graph-retirement-modified-source.test.ts:79-116` ↔ `test/compiler/graph-retirement-retires-source.test.ts:122-159` — the `recordingDimension` + `recordingPort` double, 38 lines / 111 tokens, carried once per case; (b) `test/compiler/graph-retirement-modified-source.test.ts:125-130` ↔ `test/mcp/lint-compile-isolation.test.ts:284-289` — the LLM-boundary stub, 6 lines / 60 tokens. **Both were resolved by reusing code that already existed**: the recording double moved ONCE into `test/compiler/retirement-port-project.ts` (the suite's shared helper) and both cases import it; the provider stub was dropped in favour of the existing `stubCompileProvider` fixture (`test/fixtures/compile-provider.ts`), which already installs the extraction and page-render stubs, so the pin now supplies only its two answers and no longer restates the spy installation. `test/mcp/lint-compile-isolation.test.ts` was NOT touched, and that group dissolved because the pin stopped carrying its own copy. **No baseline was regenerated, no `lint:update` was run, and no `fallow-ignore` comment was added.** Not one assertion changed: the pin still asserts `deleted` `0`, `retired` `[]`, `compiled` `1`, `skipped` `0`, `errors` `[]`, and the three retirement files' assertions are byte-identical to `L5`.
4. Measured after the dedupe: `corepack pnpm run fallow:ci` → **exit 0, `Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass; 2 dead-code, 0 complexity, 2 duplication inherited, not counted)`**; the four graph-retirement files → **exit 0, `Test Files 4 passed (4)`, `Tests 8 passed (8)`**; `corepack pnpm run lint` → **exit 0, `no regression`**; `corepack pnpm run gates:static` → **exit 0, `static gates: all 6 passed in 23.2 s`** with `tsc ok`, `typecheck:kg ok`, `typecheck:tests ok`, `fallow:ci ok`, `fallow:kg ok`, `lint ok`. The 2 inherited duplication groups are pre-existing debt on `main` (`test/lint.test.ts:55-60`/`:90-95`, `test/review-candidate-durability.test.ts:123-128`/`:136-141`), not counted and not touched.
5. `git status --porcelain` at the end: modified `packages/wiki/src/dimensions/wiki/migration_wiki_sources.sql`, `packages/wiki/src/dimensions/wiki/schema.sql`, `test/compiler/graph-retirement-port-invocation.test.ts`, `test/compiler/graph-retirement-retires-source.test.ts`, `test/compiler/graph-retirement-tenant-scope.test.ts`, `test/compiler/retirement-port-project.ts`; untracked `odd/tasks/source-compile-state-tombstone.md`, `test/compiler/graph-retirement-modified-source.test.ts`. No tool cache, no scratch path, no `.env`.

With `L6`, the whole of `S7` holds: the gate of record is green for the first time in this campaign, with the population reconciled instead of explained, and all six static gates pass together.
