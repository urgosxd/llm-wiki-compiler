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

## Tasks

- [ ] T1 — Record the contract reversal in `odd/tasks/boot-precedence-two.md` (S1 rewritten, S3 line reference fixed) and log it here. S12. route: worker. commit: pending
- [ ] T2 — Add the `active` column by migration and register it in `scripts/apply-schemas.sh`. S4. Also mirrors `active` into the drizzle table (`ts/src/schema.ts`) and replays `migration_stack_active.sql` in `schema-open-classification-harness.ts`. route: worker. commit: pending
- [ ] T3 — Delete `ensureDefaultStack`, precedence 2 and the default-Stack constants. S1. route: worker. commit: pending
- [ ] T4 — Replace the process-env fallback on the unnamed path with a refusal by name. S3. route: worker. commit: pending
- [ ] T5 — Resolve authority per request at the viewer seam and drop `stackAuthority` from `startHost`/`viewerDeps`. S6. route: worker. commit: pending
- [ ] T6 — Refuse, by name, any ingest job whose `stackId` differs from the Stack the durability registry was bound to. Keying job storage by `stackId` is DEFERRED to its own feature. S11, S6. route: worker. commit: pending.
- [ ] T7 — Turn `DELETE` into inactivation and allow reactivation through update. S4. route: worker. commit: pending
- [ ] T8 — Add the `--stacks-declaration` boot flag, `z.array(StackCreate)` validation and seed-only provisioning. S2, S8. route: worker. commit: pending
- [ ] T9 — Make MCP resources fail by name instead of reading the process environment. S5. route: worker. commit: pending
- [ ] T10 — Rewrite the pins that assert the old contract. S12, S1. route: worker. commit: pending
- [ ] T11 — Pin the acceptance story: empty database, no template, binds, `POST /stacks`, next request uses it with no restart. S6, S9. route: worker. commit: pending
- [ ] T12 — Confirm the 14 file-mode test files are untouched and green. S7. route: verify. commit: pending

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
