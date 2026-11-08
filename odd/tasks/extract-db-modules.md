# Extract modules out of `packages/llmwiki-kg/ts/src/db.ts`

Buy line-count headroom under the `max-lines: 399` ratchet without changing behaviour, so the
most-disputed file in the KG package can be edited again and the planned package split has a
starting point. This delivery extracts the Postgres timestamp block; the lifecycle extraction is
deferred (S3) and recorded below so it cannot be dropped silently.

## Specs

- **S1** — `packages/llmwiki-kg/ts/src/db.ts` must land comfortably below the `max-lines: 399`
  ratchet so the file can be edited again without failing `npm run lint` in CI.
- **S2** — zero behaviour change, no signature changes, no renames, every existing import path
  keeps working.
- **S3** — the lifecycle extraction (`createTransactionRunner`, `withTransaction`,
  `closeDatabase`, `isDatabaseReachable`) is **out of scope for this delivery and deferred**.

## Tasks

- T1 — move `db.ts:43-151` (`TIMESTAMPTZ_OID`, `TIMESTAMP_OID`, `PG_TIMESTAMP_TEXT_RE`,
  `normalizeTimestamptz`, `timestamptzType`) into `packages/llmwiki-kg/ts/src/db-timestamp.ts` and
  re-export `normalizeTimestamptz` from `db.ts` — S1, S2 — commit `refactor(kg): extract Postgres
  timestamp handling out of db.ts`.
- T2 — lifecycle extraction (`createTransactionRunner`, `withTransaction`, `closeDatabase`,
  `isDatabaseReachable`) — S3 — **DEFERRED**, not done. Deferred until the package split, when pool
  ownership becomes explicit; see the follow-up subsection of `## Log`.

## Log

### L1 — original request, as received (verbatim, evidence-capture and per-gate subsections elided)

> Bounded ODD task: mechanical module extraction in the KG package. Read `AGENTS.md` first — it holds
> the canonical six-gate list.
>
> ## Why (do not redesign)
> `packages/llmwiki-kg/ts/src/db.ts` is exactly 399 lines and the landed lint ratchet enforces
> `max-lines: 399`, so the next single-line change to it fails `npm run lint` in CI. This is a pure
> relocation to buy headroom before a planned package split.
>
> ## The move
> Move these four symbols out of `db.ts` into a new sibling module
> `packages/llmwiki-kg/ts/src/db-lifecycle.ts`:
> `createTransactionRunner`, `withTransaction`, `closeDatabase`, `isDatabaseReachable`.
> Everything else in `db.ts` (the client factory and the request-transaction wrapper) stays where it
> is.
>
> Hard constraints:
> 1. **No signature changes, no renames, no behavioural changes, no refactoring while moving.** Bodies
>    must be byte-identical modulo surrounding whitespace and import-path fixups.
> 2. `db.ts` must **re-export** all four symbols so every existing import path keeps working. …
>    the public surface must be identical.
> 3. No caller may need editing. … If any caller would need an edit, STOP and report.
> 4. New file obeys house rules: < 400 lines, functions < 40 lines excluding comments, no `any`,
>    substantial file-header JSDoc, and the KG package may not import root `src/`.
> 5. `db.ts` must land comfortably **below** 399 — not 397/398. …
> 6. Update any file-header JSDoc in the touched files that enumerated the moved symbols, and say
>    exactly which header text you changed.
>
> ## Commit
> One commit on the current branch, Conventional Commit message (e.g. `refactor(kg): extract database
> lifecycle helpers from db.ts`). Never `--no-verify`, never `HUSKY=0`, never `git push`, never
> rewrite history. Hooks must pass on their own.

### L2 — Manager accepts option C with three conditions

The worker reported a blocking fork before editing: three of the four named symbols reach module-private
pool state that the brief keeps in `db.ts` — `withTransaction` → `getDatabase()`, `closeDatabase` →
`resolvedClient`, `isDatabaseReachable` → `getClient()` — so "move the four, byte-identical" has no
form that also satisfies constraints 2 and 3. The Manager chose the third option and attached three
conditions: (1) prove the extraction has no import-time side effect rather than assert it, (2) name the
tests that cover the moved behaviour and say plainly if any branch is uncovered, (3) record the
lifecycle extraction as a deferred follow-up in this document. Authorized surfaces became `db.ts`,
the new `db-timestamp.ts`, and this file; `db-lifecycle.ts` is not to be created.

### Follow-up — deferred lifecycle extraction (T2, S3)

**Status: deferred until the package split, when pool ownership becomes explicit.** No option is
chosen and none is recommended here; both are recorded with their costs so the choice is made when the
package split makes pool ownership a real question.

- **Option A** — extract the four symbols (`createTransactionRunner`, `withTransaction`,
  `closeDatabase`, `isDatabaseReachable`) to `db-lifecycle.ts`, keep the pool in `db.ts`, and add three
  documented internal exports `getClient`/`getDatabase`/`resolvedClient`. Breaks "identical public
  surface": publishes `resolvedClient` as a cross-module live `let` binding. Lands `db.ts` at ~347
  lines, ≈ 52 lines of headroom.
- **Option B** — also move the pool plumbing (`resolvedClient`, `resolvedDatabase`, `getClient`,
  `getDatabase`) into `db-lifecycle.ts`, which creates a real ESM cycle `db.ts ↔ db-lifecycle.ts`
  because `db-lifecycle` needs `createClient`/`createDatabase` from `db.ts`. That cycle would sit on a
  module whose own header forbids import-time work and whose `config.DATABASE_URL` resolution is
  order-sensitive. Lands `db.ts` at ~360 lines.
