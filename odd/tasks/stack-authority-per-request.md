# Feature: Stack authority moves from the process to the request

Branch `feat/stack-authority-per-request`. Base `main` @ `ef6cc674cce5e9761a84fd0af0717677b3bc0876`.
Status: specs ratified by the human; all five design decisions closed; T6 partially deferred with a refusal guard as its closure condition. See `## Log`.

## Specs

### S1 — No default Stack is ever created.

> "se sigue creando un default, un stack default analizemos como podemos hacer que no se cree ningun stack y sea yo el que lo cree via http"

Rule: with a database configured and an empty `public.stacks`, boot creates zero rows. `ensureDefaultStack` and precedence 2 of the authority chain are DELETED, not bypassed, and no code path provisions a Stack implicitly.

Evidence:
- `packages/wiki/src/services/stacks/default-stack.ts:69` (`ensureDefaultStack`), insert at `:76-79`.
- Precedence comment `packages/wiki/src/dimensions/stack-authority.ts:22-30`.
- Call sites `packages/wiki/src/dimensions/coordinator.ts:183`, `packages/wiki/src/services/stacks/resolve-stack.ts:49,60,68,94`.

### S2 — The template SEEDS and never UPDATEs.

> "1 solo semilla no se modificara"

Rule: provisioning from a declaration creates a row only when its `domain` does not exist, and NEVER updates an existing row. An operator's later edits made through HTTP must survive a restart. A declared domain that already exists is a no-op, not an overwrite, not an error.

Evidence:
- The seed-only primitive already exists in shape at `packages/wiki/src/services/stacks/default-stack.ts:76-81` (`insert ... on conflict (domain) do nothing`, then select the id).

### S3 — No silent fallback to the filesystem when a database is configured.

> "2 no se debe crear el stack y no recurrir al file system"

Rule: with a database configured, a request that cannot resolve a Stack refuses loudly and by name. It never falls back to files. Scope is narrow (see S7): file mode survives where no database is configured.

### S4 — Deletion marks INACTIVE; no row is ever deleted.

> "3 como inactivo"

Rule: `DELETE` never issues a SQL `DELETE`. It sets a flag. Every authority resolution treats an inactive Stack as unresolvable and refuses by name, with a code distinct from the "you named none" refusal. Because `domain` is `unique`, an inactive row still occupies its domain, so reactivation MUST be expressible through the existing update route or the slug is burned forever. This is a repair of a live defect — see S13.

Evidence:
- Physical delete today at `packages/llmwiki-kg/ts/src/routes/stacks.ts:495-499` (`delete from stacks ... returning id`), 204 at `:505`.
- `domain text not null unique` at `packages/llmwiki-kg/db/schema.sql:16`.
- NINE production tables reference `stacks(id)` and EVERY one declares `on delete cascade` — `packages/llmwiki-kg/db/schema.sql:36, 83, 130, 176, 211, 229, 285, 529, 560` — so today a physical delete SUCCEEDS and silently destroys nine tables' rows.
- No `active`/`status`/`archived`/`deleted_at` column exists on `stacks` (`schema.sql:11-24`).
- The nearest precedent for a status column is `backfeed_queue.status` (`schema.sql:322`) with a `valid_status` check (`:331`).

### S5 — MCP resources FAIL BY NAME.

> "1 simplemente fallan"

Rule: an `llmwiki://` resource has no `stackId` argument. It must not resolve a Stack from the process environment. It fails naming what it could not resolve. MCP *tools* already take a `stackId` and already refuse when it is unknown; that behaviour stays.

Evidence:
- `packages/wiki/src/mcp/resources.ts:179-180` and `:252-253` read `process.env`; resource URLs at `resources.ts:67,83,98,128,145,209,225,251,272`.
- Tool refusal already exists at `packages/wiki/src/mcp/tenant-db.ts:202`; the `list_stacks` fallback to the process env is `packages/wiki/src/mcp/stack-tools.ts:69` → `tenant-db.ts:71`.

Price of the decision, stated plainly: under a database the resource surface is UNUSABLE until a resource URI can carry a Stack, because a resource URI has nowhere to put one. The decision taken was "do not invent ambient resolution", and the cost of that decision is the resources.
Follow-up, and it is a CONTRACT BREAK, not a gap: `llmwiki://pages/foo` must become `llmwiki://<stack>/pages/foo`. That renames a URI surface other people's clients already consume, so it is a deliberate breaking change to a published interface — named here so nobody later files it as a stylistic gap or an open question.

### S6 — `POST /stacks` is the primary bootstrap, and the created Stack is usable by the NEXT request with no restart.

> "me tienta la forma de yo crear el primero via API"

Rule: boot with a database configured and an empty `public.stacks`, no template, and the process binds. `POST /stacks` with the full complex body succeeds, and the very next request uses that Stack WITHOUT a restart. This is the acceptance story and it is the point of per-request authority.

Evidence:
- Boot resolution today `packages/api/src/main.ts:327`.
- The boot snapshot reaches `/api/reviews` through `packages/wiki/src/viewer/server.ts:269` and `:515-517` — that is the stale read to remove.
- A named Stack is already re-checked per request by `stackExists` (`packages/wiki/src/services/stacks/stack-store.ts:119-122`, no cache) via `packages/api/src/host/api.ts:342`.

### S7 — Scope is NARROW: file-backed deployments survive.

> "2 Angosta"

Rule: with NO database configured, the run keeps the named `{kind:"file", reason:"no-database-configured"}` authority exactly as today. The file backend is not touched. S3 forbids falling back to files *when a database is configured*; it does not abolish file mode.

Evidence:
- `packages/wiki/src/dimensions/stack-authority.ts:38` (`export type FileBackedReason = "no-database-configured"`) and `:41` (`NO_DATABASE_CONFIGURED`).
- 14 test files exercise this boundary and must survive unchanged: `test/stack-authority.test.ts`, `test/rule-validation.test.ts`, `test/rule-candidates.test.ts`, `test/candidate-store-confinement.test.ts`, `test/rule-candidate-store-confinement.test.ts`, `test/candidate-custody-authority.test.ts`, `test/candidate-custody-authority-ambient-disagreement.test.ts`, `test/candidate-identity-binding.test.ts`, `test/candidate-identity-limits.test.ts`, `test/candidate-content-mutation-binding.test.ts`, `test/candidate-deletion-final11.test.ts`, `test/candidate-namespace-final9.test.ts`, `test/review-candidate-durability.test.ts`, `test/review-candidate-lifecycle.test.ts`.

### S8 — The template is a JSON declaration with the SAME schema as the `POST /stacks` body: one validator, two entry points.

> "quiero tener una plantilla para crearlo, no crearlo simple sino complejo talves un json indicando lo que quiero como si lo estivrea creando via http"

Rule: the declaration file is `{"stacks":[...]}` where each element validates against the SAME `StackCreate` schema the HTTP route uses. Array shape so a multi-tenant deployment declares N and a single-Stack deployment declares 1 — `tenant = stack`, one mechanism. The file is supplied by an explicit boot flag, never ambient. The template is OPTIONAL: its only justification is an unattended container deploy where nobody is present to POST. It is NOT the normal path and the spec must not sell it as one. A missing or invalid declaration refuses to start, naming the reason; the seed applies in ONE transaction so a bad element seeds nothing.

Evidence:
- `StackCreate` at `packages/llmwiki-kg/ts/src/dto.ts:250`, consumed by `StackCreate.safeParse` at `packages/llmwiki-kg/ts/src/routes/stacks.ts:234`; it is transport-free, so a boot loader can import it and get identical refusals.
- Path-shaped boot input precedent: `--root` in `packages/api/src/main.ts` (`HOST_OPTIONS` around `:390`), rejected on other subcommands by `assertOptionsAccepted` (`:432-437`).
- No operator JSON declaration path exists in this repo today.

### S9 — The bootstrap surface needs no Stack, and everything else fails by name.

Rule: `POST /stacks` and `/health` respond with no Stack named — creating a Stack cannot require being a Stack. `POST /stacks` KEEPS its existing API-key guard unchanged: "cannot require being a Stack" is about Stack identity, not about the API key, and dropping the key guard would let any reachable client mint tenants.

Evidence:
- `/health` is open by design at `packages/llmwiki-kg/ts/src/server.ts:195-206` (rationale `:208-210`).
- The key guard is `router.use(deps.apiKey)` at `packages/llmwiki-kg/ts/src/routes/stacks.ts:532`, fail-open on a blank key at `packages/llmwiki-kg/ts/src/auth.ts:53-56`; no Stack-identity guard middleware exists anywhere.

### S10 — Each surface has ONE error shape, and codes live only where the envelope already carries one.

Rule: the graph surface (`/stacks`, `/aks/v1`) answers `{"detail":"<string>"}` and must not gain fields — it is a byte-faithful FastAPI port. The viewer surface answers `{"error":{"code","message"}}` and that is where machine-readable codes go: `stack_unnamed` (409, no Stack named while a database is configured), `unknown_stack` (404, named but absent — already exists), `stack_inactive` (404, named but inactive). The graph surface's prose must NAME the Stack or the absence it could not resolve.

Evidence:
- `apiError`/`sendApiError` `packages/llmwiki-kg/ts/src/pydantic/wire.ts:52` and `routes/stacks.ts:189`.
- Viewer envelope `packages/wiki/src/viewer/respond.ts:27-34`; existing 404 code `packages/api/src/host/api.ts:342`.
- The repo's only precedent for adding structure is an APPENDED field (`ontology`, `packages/llmwiki-kg/ts/src/dto.ts:296-311`).

### S11 — Named obstacle, recorded not solved.

Rule: the ingest-job durability registry is constructed bound to ONE Stack and cannot re-resolve per request without restructuring. `packages/api/src/host/server.ts:518-523` (`durableRegistryFor(process.env, options.stackAuthority)`) and `:531-535` (`durableJobReadsFor(...)`), with the comment at `:518-520` that a host with no named Stack "refuses to start HERE instead of accepting jobs it will lose". Making this per-request means keying jobs by `stackId` in storage and reads. This is the deepest part of the feature and must not be hidden behind a cache that cannot be invalidated.

### S12 — A contract is reversed ON PURPOSE, not silently retargeted.

Rule: `odd/tasks/boot-precedence-two.md` S1 states that a host with a database configured and an empty `public.stacks` must provision the default Stack and bind. That is now false BY DECISION. Its S1 must be rewritten and the reversal logged here as a deliberate contract change. Its S3 cites `main.test.ts:334`, which is stale: that line is a digest assertion; the refusal test is at `main.test.ts:373`.

Evidence:
- `odd/tasks/boot-precedence-two.md` S1 and S3, added by `ef6cc674`.
- The provisioning pin is `packages/api/src/main.test.ts:229` inside `describe("a deployment whose database holds no Stack yet")` at `:228-252`, asserting `countStacks(...)` is 1 after boot at `:240`.

### S13 — Finding: the delete route is a live data-loss defect

This is a finding about code that is already broken, not a consequence of this feature. `DELETE /stacks/:id` cascades to nine production tables and returns 204, so nothing refuses and nothing reports what it destroyed. Decision 1.3 is therefore not a design preference — it is the repair of something currently broken. The DELETE-to-inactive change must land as its OWN work-unit commit with its own Risk line naming data loss, and must never be folded into the authority seam.

Evidence: `packages/llmwiki-kg/ts/src/routes/stacks.ts:495-499` (`delete from stacks ... returning id`), 204 at `:505`; the nine cascading foreign keys at `packages/llmwiki-kg/db/schema.sql:36, 83, 130, 176, 211, 229, 285, 529, 560`, every one declaring `on delete cascade`.

### S14 — Named obstacle: the viewer snapshot is a process-level read model.

Rule: `buildViewerSnapshot` builds ONE corpus from Stack-scoped reads at boot and serves it process-wide, so per-request authority cannot make it reflect a Stack created after boot without rebuilding it per Stack. T5 makes it *tolerate* a Stack-less boot — an EMPTY corpus with zero counts, never the checkout's files — and that is the limit of what it can claim: once a Stack exists, a viewer read that needs it still cannot see it until restart. Making the snapshot per-Stack is deferred to its own feature, exactly like T6's storage keying. The honest consequence, stated as a cost rather than a footnote: a host booted against an empty `public.stacks` shows an empty corpus even after `POST /stacks` succeeds, while the mutation path and `/api/reviews?stackId=` already serve the new Stack.

Evidence:
- `packages/wiki/src/viewer/snapshot.ts:82-95` — the four Stack-scoped reads (page source, compile state, freshness corpus, review count) that a Stack-less boot must not attempt; the T5 shortcut answers `unresolvedStackSnapshot` instead.
- `packages/wiki/src/freshness/index.ts:180-191` — the freshness snapshot resolves the same authority through the same reads, so it cannot be per-request either.
- `packages/api/src/main.ts` (T5) — the boot no longer resolves a Stack; it asks `hasNoResolvableStack` and passes `stackUnresolved` instead of a second resolution.

## Tasks

- [ ] T1 — Record the contract reversal in `odd/tasks/boot-precedence-two.md` (S1 rewritten, S3 line reference fixed) and log it here. S12. route: worker. commit: db374c7b95e1620189030f8aec16048249b19955
- [ ] T2 — Add the `active` column by migration and register it in `scripts/apply-schemas.sh`. S4. Also mirrors `active` into the drizzle table (`ts/src/schema.ts`) and replays `migration_stack_active.sql` in `schema-open-classification-harness.ts`. route: worker. commit: 2f3f01317d2069dcf38c3a0c16406ec300185f94
- [ ] T3 — Delete `ensureDefaultStack`, precedence 2 and the default-Stack constants. S1. route: worker. commit: ee738a433fc6c6fc6e716a6bcbcb4deb7a90c375, dc3c3a2ca5bba09d464b8f7542269d7814fcad60, 3dcb924c03399192b197091d2006edd34ccb646a, 3a40fe4de3d5e105881cfebc6b1caa9d44f25f94, ac9d8499ef13897e0b8e8196920ea335093e66df, 558c2f003ba16889b2851e75ff7193bf001b16d8
- [x] T4 — Replace the process-env fallback on the unnamed path with a refusal by name. S3, S10. route: worker. commit: 63bff5cbeaf7c35b462a2cb21973b8e9b2f8685b
- [x] T5 — Resolve authority per request at the viewer seam and drop `stackAuthority` from `startHost`/`viewerDeps`. S6. This includes the boot seam: `packages/api/src/main.ts:306-331` stops resolving authority so a database-configured host with zero Stacks BINDS, which is the half of S6 that T3 cannot deliver. S6 is delivered IN PART: the bind and the per-request write/review path, never the process-wide snapshot (S14, T14). route: worker. commit: 5d05028d74923856fcf5d131ade524e575c02120, 5eae151d646d9e9b716df81accdee53d9323265c, b708fa218be43fe096965c9f933e9bc06cc0a459
- [ ] T6 — Refuse, by name, any ingest job whose `stackId` differs from the Stack the durability registry was bound to. Keying job storage by `stackId` is DEFERRED to its own feature. S11, S6. route: worker. commit: pending. T5 deletes the boot resolution, so there is no bound Stack for a job to differ from; the guard becomes "refuse, by name, any job that names no Stack, and never serve one Stack's job under another".
- [x] T7 — Turn `DELETE` into inactivation and allow reactivation through update. S4, S13. route: worker. commit: 160da4aaa7e1dc63ed4c3141590c62569da3bfef
- [ ] T15 — State the migration-first requirement where an operator deploying this build will read it (release/upgrade notes), so nobody upgrades the code onto an unmigrated database and gets 42703 on every Stack lookup. S4, S13. route: worker. commit: pending
- [ ] T8 — Add the `--stacks-declaration` boot flag, `z.array(StackCreate)` validation and seed-only provisioning. S2, S8. route: worker. commit: pending. This task MUST also pin S2's "seed only, never update an existing row" guarantee: that assertion lived in test/services/stacks/default-stack.test.ts, which T3 deleted, so the guarantee currently has no test.
- [ ] T9 — Make MCP resources fail by name instead of reading the process environment. S5. route: worker. commit: pending
- [x] T10 — ABSORBED BY T3: the nine old-contract pins were rewritten in T3's reversal commits; nothing remains. S12, S1. route: worker. commit: ee738a433fc6c6fc6e716a6bcbcb4deb7a90c375
- [ ] T11 — Pin the acceptance story: empty database, no template, binds, `POST /stacks`, next request uses it with no restart. S6, S9. route: worker. commit: pending. The acceptance story is scoped honestly: POST /stacks followed by a request that NAMES the new Stack must succeed with no restart on the write/mutation surface and on /api/reviews. Reflection of the new Stack in the frozen viewer snapshot is T14's, and T11 must not assert it.
- [ ] T12 — Confirm the 14 file-mode test files are untouched and green. S7. route: verify. commit: pending
- [ ] T13 — Correct comment-only descriptions of default-Stack provisioning that are now false, at packages/wiki/src/services/ingest/service.ts:66,186 and packages/wiki/src/compiler/rule-state.ts:81. S1. route: worker. commit: pending
- [ ] T14 — Build the viewer snapshot per Stack instead of once per process, so a Stack created after boot is visible to viewer reads without a restart. S14, S6. route: worker. commit: pending

## Log

L1 — the human, verbatim:

> se sigue creando un default, un stack default analizemos como podemos hacer que no se cree ningun stack y sea yo el que lo cree via http

L2 — the human, verbatim:

> 1 simplemente fallan 2 no se debe crear el stack y no recurrir al file system 3 como inactivo. talves podamos iniciar con uno default, pero quiero tener una plantilla para crearlo, no crearlo simple sino complejo talves un json indicando lo que quiero como si lo estivrea creando via http

L3 — the human, verbatim:

> 1 solo semilla no se modificara 2 Angosta

L4 — the human, verbatim:

> me tienta la forma de yo crear el primero via API

L5 — evidence from reconnaissance, 2026-11-17, correcting the premises carried into this feature: `packages/wiki/src/dimensions/default-stack.ts` does not exist (real path `packages/wiki/src/services/stacks/default-stack.ts`); `packages/wiki/src/dimensions/stack-authority.ts` is confirmed; the foreign-key count is NINE production tables in `packages/llmwiki-kg/db/schema.sql`, all `on delete cascade`; the file-mode test population is 14, not ~60; `main.test.ts:334` is stale (the refusal is at `:373`, the provisioning pin at `:229`); `odd/tasks/boot-precedence-two.md` is present and tracked at 18,476 bytes, added by `ef6cc674`. Three of these four were the manager's brief, reproduced as "reported, not re-read"; the fourth ("~60 file-mode test files") was the manager's own number, not a measurement.

L6 — decision, from the Manager relay: `POST /stacks` is the PRIMARY bootstrap path and the JSON template is an OPTIONAL convenience justified only by an unattended container deploy.

L7 — decision: the declaration path is an explicit boot FLAG (`--stacks-declaration <path>`), not an environment variable, because a flag is explicit at the call site while an env var is ambient and inherited; and because the declaration is a PROVISIONING input, never a RESOLUTION input — it only creates rows that every request then reads from the database like any other Stack.

L8 — decision: nine cascading foreign keys mean a physical delete silently destroys rows today, so inactivation is a data-destruction guard, and a per-request authority that reads the database on every call is the mechanism, not a cache with invalidations.

L9 — the manager, on the resource decision, verbatim: "The decision was 'do not invent ambient resolution', and the cost of it is the resources — say the cost, not just the decision." Recorded as S5's price line and the named URI contract break.

L10 — the manager, on T6, verbatim: "`durableRegistryFor` / `durableJobReadsFor` must REFUSE a job whose `stackId` differs from the Stack they were bound to, by name, instead of accepting it." And the closure sentence that must appear in the document: jobs are the only remaining process-level authority and they refuse rather than mis-serve. Without the guard, deferring leaves a fact whose authority is chosen by entry point alive — the exact defect this feature exists to end.

L11 — the manager, on the delete defect, verbatim: "That is a live data-loss defect in `routes/stacks.ts:495-499`, not a consequence of this feature." Decision 1.3 is the repair of something broken, not a preference; the inactivation change gets its own work-unit commit and its own Risk line naming data loss.

L12 — evidence: T1 is held in db374c7b95e1620189030f8aec16048249b19955; T2 is held in 2f3f01317d2069dcf38c3a0c16406ec300185f94. The gate of record for both was the full CI-shaped suite plus gates:static and build; counts in the assignment report.

L13 — sequencing decision: T3 lands S1 (boot refuses and provisions nothing) and cannot land S6 (boot binds with zero Stacks), because the bind requires deleting the boot resolution at main.ts:327, which is T5's seam. T5 therefore absorbs the boot seam and T11 pins the acceptance story end to end. Splitting this way keeps S1 and S6 in separate reviewable slices instead of hiding a boot-seam deletion inside a test-repoint commit.

L14 — evidence, T3: held in six commits. `ee738a43` source deletion (S1: `ensureDefaultStack`, precedence 2, `DEFAULT_STACK_DOMAIN`/`DEFAULT_STACK_NAME`, and with them the `{kind:"default", domain}` selection); `dc3c3a2c` the S1 pins at the resolver and the authority, plus the deletion of `test/services/stacks/default-stack.test.ts` (all three of its cases tested the deleted function) and `test/fixtures/stack-rollback.ts` (its only purpose was freeing the single global `default` domain); `3dcb924c` the ingest, retirement, selection and masquerade reversals; `3a40fe4d` the boot pin, which asserts the refusal and ABSENT announcement rather than a bind, with the other three boot cases repointed to a Stack created explicitly before boot; `ac9d8499` and `558c2f00` the 11 dependent suites that leaned on implicit provisioning, plus the one shared env builder they all use.

Measured population: T3 changed 29 files and 1,620 lines (782 insertions, 838 deletions excluding the baseline entry), so the ~400-line slice ceiling could not hold and the owner re-cut the delivery into six reviewable commits rather than three. Test-first: RED observed before the deletion (3 cases, `expected undefined to be an instance of StackAuthorityError` / `of Error`, the resolver having provisioned and returned an id), GREEN after it (17 passed in the two pin files). Gate at the tip: `pnpm exec tsc --noEmit` exit 0; `pnpm run gates:static` all 6 passed (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint); CI-shaped suite `Test Files 859 passed | 5 skipped (864)`, `Tests 6440 passed | 12 skipped (6452)`, `Tasks: 1 successful`, 5m58s. The population is 5 files and 5 tests smaller than T2's: exactly the three deleted `ensureDefaultStack` cases, one resolver case, and one default-identity case.

T3 does NOT deliver S6 and must not be read as a bound host: a database-configured host with zero Stacks still refuses at `packages/api/src/main.ts:327` and exits 1. S6 is T5's, per L13.

L15 — deliberate public-surface break: T3 removed DEFAULT_STACK_DOMAIN, DEFAULT_STACK_NAME and selectStack's {kind:"default", domain} from the @repo/wiki barrel. In-repo consumers are repointed and pinned, but this package is published (test/sdk/packaging.test.ts), so it is a breaking export removal for any out-of-repo consumer — recorded as a contract break, not a refactor.

L16 — consequence of T5: T6's original guard ("refuse a job whose stackId differs from the Stack they were bound to") presupposed a Stack bound at construction. Once boot resolves nothing, that premise is gone, so the guard is restated as "refuse, by name, any job that names no Stack, and never serve one Stack's job under another". The intent — refuse rather than mis-serve — is unchanged and stronger.

L17 — evidence, T5: held in three commits. `5d05028d` the durability pair stops refusing at CONSTRUCTION and refuses per JOB (removed `jobAuthorityFor` and the `authority` parameter of both entries; added `boundJobStackId`, `unboundStackRegistry`, `createNamedJob`, and the host-own-view refusal in `durableJobReadsFor`), with `durable-jobs-authority.test.ts` reversed on purpose: it asserted that such a registry refuses to build, and now asserts that it builds, refuses a job naming no Stack, serves one naming a Stack, and keeps `forStack` open while `list`/`get` refuse. `5eae151d` the boot seam: `resolveBootAuthority` deleted from `packages/api/src/main.ts`, `HostOptions.stackAuthority` and `viewerDeps.stackAuthority` deleted, `stackUnresolved` added to `buildViewerSnapshot` (an EMPTY snapshot — no pages, no state, no candidates, no source listing, every count zero — never the checkout, S3), and `hasNoResolvableStack` added to the authority module (a predicate over the resolver's own `settledAuthority`, deliberately not a third authority kind); `main.test.ts` reversed on purpose twice — the empty-database case now asserts the S6 bind with zero reviews and zero source files while a candidate file is planted in the checkout, and the `UNREACHABLE_DSN` case asserts a bind with no reachable database. `b708fa21` the viewer seam: `authorityFrom` deleted, the `SNAPSHOT_ONLY_HANDLERS` map hands each entry the parsed URL, `/api/reviews` resolves `?stackId=` and validates it through `stackExists` (one query, no cache), an unnamed request with a database configured answers 409 `stack_unnamed` in the existing `{error:{code,message}}` envelope, and `boot-review-surfaces.test.ts` adds the per-request case: one boot, two Stacks, each request reading its OWN row with no restart, an unknown id refused 404, and an unnamed request never listing the checkout's planted candidate.

Test-first evidence: RED observed for both halves before their code landed — job durability `expected ... to throw` (the registry threw at construction; the new assertions failed) and the reviews seam `expected [ 'row-first' ] to deeply equal [ 'row-second' ]` against 22b156f6's handler, which ignored `?stackId=`. GREEN after: `durable-jobs-authority` 6 passed, `main.test.ts` 13 passed, `boot-review-surfaces` 4 passed. Differential check for the shared map signature, against a copy of 22b156f6 built in a scratch directory: `/api/pages`, `/api/health`, `/api/graph`, `/api/index`, `/api/search?q=alpha` and `/api/reviews` all answered the same status, and byte-identical bodies after normalising the snapshot's `generatedAt`/`updatedAt`; no unrequested difference. Gate at the tip: `pnpm exec tsc --noEmit` exit 0; `pnpm run gates:static` all 6 passed (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint); CI-shaped suite `Test Files 859 passed | 5 skipped (864)`, `Tests 6443 passed | 12 skipped (6455)`, `Tasks: 1 successful, 1 total`. The population is 3 tests larger than T3's tip: two new durability cases and one new per-request reviews case.

L18 — finding, and the second named obstacle: `buildViewerSnapshot` builds one Stack-scoped corpus at boot and serves it process-wide, so it is a process-level authority artifact of the same class as the durability registry in S11. T5 makes boot tolerate a resolved-nothing state; per-Stack snapshots are deferred to T14. Recorded because S6 must not be read as fully delivered by T5, and because a boot-frozen snapshot showing an empty corpus after a Stack exists is exactly the staleness this campaign exists to end.

L19 — operator note, found by a red gate: `stackExists` now selects `active`, so this build FAILS with PostgresError 42703 (column "active" does not exist) against any database that has not had `migration_stack_active.sql` applied. There is no graceful degradation — every Stack lookup errors, not just lookups of inactive Stacks. A long-lived development database (`llmwiki-kg-db-1`, localhost:5434) demonstrated exactly this: `test/mcp/stack-id-guard.test.ts` failed only because that database predated T2. CI is unaffected because it provisions from `scripts/apply-schemas.sh`, which replays the registered migration. Any real deployment must apply the migration BEFORE the new code runs, and the release note must say so. Filed as T15.

Measured, and it corrects the first attribution: the suite that failed does not read `llmwiki-kg-db-1`. It reads `AKS_DATABASE_URL`, which this environment resolves to the ADOPTED test container (`hardcore_borg`, localhost:32802, database `test`) — probed read-only, whose `public.stacks` columns were `id,name,domain,description,scope,compilation_strategy,created_at,updated_at,synthesize_descriptions,ontology,type_catalog,catalog_version`, i.e. no `active`. BOTH databases were migrated, each with the documented idempotent statement and `ON_ERROR_STOP=1`: `llmwiki-kg-db-1`/`aks` went from 4753 to 4753 rows with 0 rows not active, and `hardcore_borg`/`test` from 1 to 1 rows with 0 rows not active (`alter table stacks add column if not exists active boolean not null default true`, so no row could have been touched).

L20 — evidence, T7: held in `160da4aaa7e1dc63ed4c3141590c62569da3bfef` (11 files, 443 insertions, 55 deletions — the branch-wide slice counter reads 3402 authored lines over 15 commits, which includes T1-T5).

What landed: `DELETE /stacks/:id` sets `active = false, updated_at = now()` guarded by `and active`, so a live Stack is retired with the same 204 and the same empty body, an already-inactive Stack is an idempotent 204 that writes nothing, and an unknown id keeps the exact 404 it always answered (`Stack <id> not found`) via one follow-up existence read that tells the two zero-row cases apart. `PATCH /stacks/:id` accepts `active` (`StackUpdate` field appended last, `.optional()` and not `.nullable()` because the column is `not null`, so `{"active":null}` is a 422 on the field rather than a 500 from the constraint), which is the only way back because `domain` is `unique` and the inactive row keeps it — pinned: `POST /stacks` with that domain answers 409 while the Stack is inactive. `active` is APPENDED to `StackResponse` and to `STACK_COLUMNS` (last in both), and the `RESPONSE_KEYS` pin in `stacks-harness.ts` is updated with it as a deliberate contract addition. `stackResolution` in `packages/wiki/src/services/stacks/stack-store.ts` answers `active` / `inactive` / `absent` in one query, which is what S10's `stack_inactive` vs `unknown_stack` distinction will consume (T4); `stackExists` stays a boolean wrapper, so all five of its callers compile unchanged and an inactive Stack now reads as unresolvable there (`viewer/server.ts:569`, `mcp/tenant-db.ts:112` and `:202`, `host/server.ts:264`, `host/api.ts:342`). `listStacks` deliberately keeps listing inactive rows.

Test-first: RED observed as `AssertionError: expected 404 to be 200` — the row was GONE after DELETE, and its `stack_documents` row with it — not as a compile error, and the response's missing `active` was the second RED (`expected undefined to be false`), not the first. GREEN: `stacks-delete` 4 passed, `stacks-update` 5 passed, `stack-selection-shared` 7 passed, the DTO suites 54 passed. PRESERVE: the 204-with-an-empty-body case and the unknown-id 404 case are in the same file and unchanged in substance; the update suite gained one case proving `PATCH` without `active` leaves a Stack active and that `null`/non-boolean `active` are refused with nothing written. One pin was reversed ON PURPOSE rather than retargeted: `stacks-delete.test.ts` used to assert that a second `DELETE` answers 404, which is exactly what decision 1 forbids.

Differential check for the shared `stackExists`, as one script: the base commit `ef6cc674` extracted into a `mktemp -d` scratch with its own `@repo` links, both trees run from source under tsx against two identical throwaway databases (one each, same schema, one ACTIVE Stack), comparing status and normalized body — `GET /api/reviews?stackId=<active>` 200 `{"reviews":[],"total":0}` SAME, `GET /api/ingest/jobs?stackId=<active>` 200 `{"jobs":[]}` SAME, `POST /api/ingest?stackId=<active>` 202 `{"jobId":"<job>","status":"queued",…}` SAME; 0 differences, so the boolean wrapper changed no sibling route's answer for a Stack that stays active.

Gate: `pnpm exec tsc --noEmit` exit 0; `pnpm run gates:static` all 6 passed in 23.2 s (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint — "no regression"); `corepack pnpm exec turbo run test --filter=//` → `Test Files 859 passed | 5 skipped (864)`, `Tests 6448 passed | 12 skipped (6460)`, `Tasks: 1 successful, 1 total`, 6m08s. The population is 5 tests larger than T5's tip (6443/6455): four delete cases where there was one, one update case, one tri-state resolution case.

HONEST DEPENDENCY: that green depends on the two hand-migrated databases named in L19. On an unmigrated database `test/mcp/stack-id-guard.test.ts` is red on two cases for a reason that has nothing to do with this change's logic — it reads `AKS_DATABASE_URL` directly instead of a per-run database, which is why it was the one suite that could see the stale schema at all. After the migration its two failing cases pass BY NAME ("reports an unknown id as unknown, not as an empty result", "returns the unknown marker from the helper a tool actually calls"), 7 of 7 in the file. This was verified explicitly rather than inferred from the aggregate, so the two failures cannot have been masked by the rest of the suite.

L21 — evidence, T4 (S3 and the envelope half of S10): held in `63bff5cbeaf7c35b462a2cb21973b8e9b2f8685b` (10 files, 541 insertions, 93 deletions; the branch-wide slice counter reads 4106 authored lines over 18 commits, T1-T7 included). RED, observed before any implementation and failing on status/body rather than on a compile error, through `startHost` with a Stack exported in the process environment: `expected 202 to be 409` (the async route ACCEPTED a job under the environment's Stack, and the durable mirror then failed on the insert, which is the silent substitution itself), `expected 200 to be 409` (the synchronous route ran the ingest and would have written under it), `expected 500 to be 204` (the inactivation step, see the deviation below) and, on the unbound host, a thrown `StackAuthorityError` out of `buildViewerSnapshot` where the case expected the named envelope. GREEN: the six new cases in `packages/api/src/host/stack-refusal-envelope.test.ts`, plus 31 in the four sibling suites whose unnamed-ingest pins were reversed on purpose.

The refusal now has ONE definition: `unnamedStackRefusal()` in `packages/wiki/src/viewer/respond.ts` (409 `stack_unnamed`, message "This request named no Stack, and a database is configured: name one with ?stackId=."), beside `namedStackRefusal()` (the `stackResolution` tri-state mapping: active -> none, inactive -> 404 `stack_inactive`, absent -> 404 `unknown_stack`) and `stackLookupFailedRefusal()` (503). Its three consumers are `packages/api/src/host/api.ts` (`POST /api/ingest`), `packages/wiki/src/viewer/api-ingest-jobs.ts` (`GET /api/ingest/jobs`) and `packages/wiki/src/viewer/server.ts` (`/api/reviews`, whose local copy from T5 is deleted). `buildIngestEnv(undefined)` was NOT made to refuse: the route refuses first, so the `undefined` branch is unreachable FROM A REQUEST while remaining legitimate for a CLI run reading its own configured Stack — the distinction is now stated in that module's header. `/api/ingest/jobs` had no catch at all; the `StackAuthorityError` from the host's own durable view now becomes the shared 409 instead of a bodiless 500.

Deliberate contract changes recorded as such: `stack_not_found` -> `unknown_stack` on the job reads (one fact, one spelling per surface family, S10); a named Stack's validation on the job reads now goes through the shared tri-state lookup instead of the injected boolean `exists()`, which is why `api-ingest-jobs-stack.test.ts` had to name a REAL foreign Stack — a fabricated id is now refused before the durable-only rule is reached. T5's `DurableJobReads.forStack().exists()` is consequently no longer consulted by the route (kept as the host's own capability, documented in place); replacing it with a tri-state capability on the host side is a one-line follow-up in `packages/api/src/host/server.ts`, which is outside T4's surfaces.

Deviation, named: the inactive case sets the flag with `update stacks set active = false ... where id = …`, the statement `DELETE /stacks/:id` performs, instead of calling that route through the host. The host's graph sub-app resolves its own pool from the KG-side `DATABASE_URL`, which no vitest worker sets, so `GET /stacks` answers 500 inside a test process for that reason alone and the route cannot reach the row there. T7's own suite drives the route over a real pool and T4's case measures the answer for a retired Stack, not the transition.

Differential check, one script: base `ef6cc674cce5e9761a84fd0af0717677b3bc0876` extracted into a `mktemp -d` scratch with its own `@repo` links, both trees driven through `handleApiRequest` against a probe Stack provisioned in each run's own database, comparing status and normalized body — `POST /api/ingest?stackId=<active>` base 200 `{"filename":"offered.md","charCount":86,"truncated":false,"sourceType":"file","writeStatus":"created"}` vs mine identical SAME; file-mode `POST /api/ingest` (no database configured) base 200 identical vs mine identical SAME; 0 differences, so nothing the request did not name moved.

Gate: `pnpm exec tsc --noEmit` exit 0; `pnpm run gates:static` all 6 passed in 22.5 s (tsc, typecheck:kg, typecheck:tests, fallow:ci, fallow:kg, lint — 1717 files scanned, 558 baseline violations, no regression); `corepack pnpm exec turbo run test --filter=//` -> `Test Files 860 passed | 5 skipped (865)`, `Tests 6454 passed | 12 skipped (6466)`, `Tasks: 1 successful, 1 total`, 5m56s. The population is 1 file and 6 tests larger than T7's tip (864/6460). STEP 2 and the file-mode guard population (S7) were run first and are green: `main.test.ts` + `boot-review-surfaces.test.ts` 17, `viewer-reviews-api.test.ts` 8, `resolve-stack.test.ts` + `stack-authority.test.ts` 17, and `rule-validation` + `rule-candidates` + `candidate-store-confinement` + `rule-candidate-store-confinement` + `stack-authority` 41. No file-mode file was modified.

Incident, recorded because it cost time and because it is a hazard for the next differential: running `pnpm exec` inside the extracted-commit scratch (whose `node_modules` symlinks point into this worktree) made pnpm rewrite nested dependencies THROUGH those links, replacing `node_modules/vitest/node_modules/@vitest/utils` and ~20 other nested copies. The tree was restored with `rm -rf node_modules && pnpm install --frozen-lockfile` under Node 24 (lockfile unchanged, verified), and every gate above was run after that repair. The lesson is in the shape of the failure, not in the dependencies: drive a scratch tree's tests with an absolute `node .../node_modules/vitest/vitest.mjs`, never with `pnpm exec`.
