# schema-parity-guard

A database check that a live schema's columns match what the repo's SQL declares, plus the evidence
that a database built only by `scripts/apply-schemas.sh` is complete and that the production row reader
works against it. Branch `fix/schema-parity-guard-and-fresh-db`, baseline `054e6b16a627cc812fcc5d1454fb3b39d8730d35`.

## Specs

S1. A database created empty and built by `scripts/apply-schemas.sh` and nothing else holds every table
and every column declared by the SQL files that script registers. Measured on the fresh database
`parityfresh_1794543960`: declared **30 tables / 308 columns** == present **30 tables / 308 columns**,
with "declared but missing" and "present but undeclared" both empty. Re-running the script is idempotent
(second run exit `0`, zero error lines, database unchanged).

S2. "If that script cannot build a complete database from empty, **that is a finding, not something to
work around**: report exactly which migration it misses." It applies 17 of the 19 `.sql` files on disk;
the two omissions must stay omissions and be justified: `packages/llmwiki-kg/db/migration_drop_ingest_outbox.sql`
is operator-only by its own header and declares nothing, and `packages/llmwiki-kg/db/migration_open_kg_classification.sql`
declares only `public.kg_evidence` / `public.kg_classification_log`, which `packages/llmwiki-kg/db/schema.sql:527`
and `:558` already create (61/61 of its columns are present in the fresh database). Do not edit
`scripts/apply-schemas.sh`'s file list and do not add those migrations to it.

S3. "`createPageContentSource(db, stackId)` must succeed against the fresh database — on an empty stack is
enough — where it fails against `aks`." Fresh database: succeeds, `listSlugs("concepts")` returns `[]`,
exit `0`. Same call against `aks`: fails with `PostgresError code=42703 | column "aliases" does not exist`,
exit `1`.

S4. The deliverable is "a check that a database's columns match `schema.sql`'s declarations, failing loudly
with the names of the missing columns and the migration that likely provides them". It "must be runnable
against any database by passing a connection, so CI and a developer can both use it". **Location
requirement (owner directive L7):** the column comparison is carried by the EXISTING check invocation —
`CHECK_ONLY=true ./scripts/apply-schemas.sh` — so that a green from that one command is a green on
columns, and there is no second check anyone can run by mistake. `scripts/apply-schemas.sh` invokes
`scripts/schema-parity-check.ts` from its check mode, inheriting the same connection (`DATABASE_URL` or the
`PSQL` wrapper), and the whole invocation fails when parity fails. The RLS check stays as it is.

S5. "It must fail on exactly the defect above: a database missing `wiki.pages.aliases` exits non-zero and
names the column."

S6. "It must not require fixtures or a corpus — an empty, correctly-migrated database passes."

S7. "Test it twice over: the parity logic against a **known-good** fresh database (pass) and against a
deliberately **reduced** one — drop one column in a throwaway schema or table and prove the check names it.
**A check that cannot fail is decoration.**"

S8. "Report the class this guard does and does not cover. It catches *column* drift. It does not catch a
wrong type, a missing index, a missing constraint, or a migration applied out of order. Say so rather than
implying completeness. If indexes and constraints are cheap to include, include them and say which."

S9. "One check script plus its wiring, and the clean-database verification as evidence. **No production
read-path change, no migration edit, no data migration, no `aks` write.**" If `apply-schemas.sh` is found
incomplete, "report it and do not fix it".

S10. Gates: `npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**) ·
`npm run fallow:ci` — "if it prints 'compared nothing', say so" · and, because this change touches
`scripts/`, the CI form of the suite:
`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec turbo run test --filter=//`,
"asserting the population from its own summary rather than the exit code".

S11. Prohibitions, absolute: no `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` read, no
credential in any output, no provider call, **no write of any kind to `aks`**, no `drop` outside the
database you created.

S12. **Do not soften the 86.** "**The guard's first run against `aks` reporting 86 missing columns and 5
missing tables is correct behaviour**, not a false positive to tune down. Include the full list in the
report, grouped by table, with the migration that provides each. **A check whose first real finding gets
filtered is a check that will be trusted for the wrong reasons.**" `aks` "is **not** to be brought current.
The owner has declared it disposable test data; the fresh database is the forward path, and it now
demonstrably works." So the check reports every declared-but-absent table and column on the database it is
pointed at, without a threshold, an ignore list or a baseline.

S13. Three findings are reported as SETTLED, phrased as settled rather than open: (1) `scripts/apply-schemas.sh`
is complete — 30/308 declared == 30/308 present, 0 drift both ways, idempotent on re-run, and the evidence is
that it builds a database the production reader can open; (2) both omitted `.sql` files are correctly omitted,
with the reason recorded for each — `migration_drop_ingest_outbox.sql` is operator-only by its own header, and
`migration_open_kg_classification.sql` declares only tables `schema.sql:527`/`:558` already create, 61 of 61
columns present — so what was carried as debt is not debt; (3) the reader proof both ways
(`listSlugs → []` exit 0 on fresh, `42703` exit 1 on `aks`) is the end-to-end evidence and is worth more than
the column count, because it is what a user experiences.

## Architecture decisions (Lead)

D1. The guard is a TypeScript checker under `scripts/`, matching the repo's convention that every
`scripts/*` check is TypeScript. It reads the declared surface from the same `SCHEMA_FILES` list that
`scripts/apply-schemas.sh` registers, so there is one source of truth and no second manifest to drift.

D2. Error vs warning. A **declared table or column missing from the database is an error** (exit `1`).
A **present-but-undeclared table or column is a warning** (reported, exit unaffected), because `aks`
legitimately carries seven legacy tables (`wiki.artifact`, `artifact_manifest`, `artifact_member`,
`profile`, `relation_edges`, `template_lock`, `public.ingest_outbox`) and a guard that fails on those is a
guard nobody can run against a real deployment.

D3. Wiring runs through the check mode that already exists, so a single invocation covers developer and
CI use and `.github/` needs no change: CI already runs `CHECK_ONLY=true ./scripts/apply-schemas.sh`.

D4. Column names only. Types, defaults, nullability, constraints and migration ordering stay out of scope
and are documented as out of scope per S8, not silently omitted.

D5. There is ONE check. Its entry point is the existing check mode: `CHECK_ONLY=true ./scripts/apply-schemas.sh`
invokes a TypeScript checker. The logic cannot live in bash because it must parse `create table (...)` /
`add column` bodies across 17 SQL files — depth-0 comma splitting, comments, quoted identifiers — so the
parser is TypeScript, exactly as `node scripts/lint-ratchet.ts` is the repo's shape for a check. There is NO
new `package.json` entry and NO `.github/` change: CI already runs that command, so wiring it there means CI
covers parity with no workflow edit.

D6. The checker reaches the database through `psql`, honoring the same `PSQL` wrapper and `DATABASE_URL` it
already honors — no new driver dependency, and it works with the `docker exec` form as well as a DSN.

D7. Attribution prefers the derived source: if a registered migration adds the column, name that migration;
otherwise name the file whose `create table[ ... ]` declares it.

D8. No `package.json` script, no CI workflow edit (see D5).

## Tasks

T1 — this file. Route: worker (doc only). S: none. Commit: same work unit as T2.
T2 — parity checker: declared surface parsed from `SCHEMA_FILES`, present surface from `information_schema.columns` through `psql` (`PSQL` wrapper or `DATABASE_URL`), diff with missing=error and undeclared=warning, CLI takes a connection. No `package.json` entry (D5, D8). S: S4, S5, S6, S8, D1, D2, D4, D5, D6, D7, D8. Route: worker, test-first. Commit: W1.
T3 — wiring: the checker is wired into the existing check mode, so `CHECK_ONLY=true ./scripts/apply-schemas.sh` covers columns and fails the whole invocation on drift; `node` unavailable fails loudly rather than skipping. S: S4, D3, D5, D8. Route: worker. Commit: W1.
T4 — proof it can fail: focused tests for the diff logic, plus an end-to-end run against the known-good fresh database (exit `0`) and against a reduced copy with one column dropped (exit `1`, naming that column). S: S5, S7. Route: worker. Commit: W1.
T5 — documentation: the parity check and its coverage limits, in the doc that describes the schema/apply path. S: S8. Route: worker. Commit: W1.
T6 — gates S10 and the work-unit commit. S: S10, S11. Route: worker, then independent verify. Commit: W1.
T7 — clean-database evidence, already gathered. S: S1, S2, S3. Route: verify (done). Commit: none (evidence only).
T8 — the report states S12 (the 86 reported in full, grouped by table with the providing migration, `aks` not brought current) and the three S13 items as settled. S: S12, S13. Route: parent. Commit: none.

## Log

L1 (user request, verbatim):

> Project assignment for branch fix/schema-parity-guard-and-fresh-db:
>
> **Stand up a clean database, and add the check whose absence let a deployment run a schema it did not
> have.** No migration of existing data — the owner has declared the current database disposable test
> data. **Blank slate.**
>
> Repo: primary `/home/urgosxd/Desktop/ofk/llm-wiki-compiler`, `main` = **`054e6b16a627cc812fcc5d1454fb3b39d8730d35`**.
> Node 24 ONLY, and **`git commit` itself must carry the PATH prefix** or the pre-commit hook refuses
> under v22. Read `AGENTS.md` in full. Docker is reachable. **No provider call, no network, no paid
> compile, no `.env*` read.**
>
> ## The defect, measured
>
> `createPageContentSource(db, stackId)` — the production row reader — fails against the live `aks`
> database with:
>
> ```
> PostgresError 42703: column "aliases" does not exist
> ```
>
> because `page-store.ts` selects `aliases` and `attribution_gaps` (lines 214/264/291/348), `schema.sql:101`/`:104`
> declare them, and **`migration_wiki_db_parity.sql` is in the repo but was never applied to that
> database**. Every row-backed page read in that deployment is broken, and nothing noticed.
>
> **The fix for the data is "do not migrate; start clean" — the owner's decision.** The fix for the
> *class* is a check that a database's actual columns match what `schema.sql` declares.
>
> ## Part 1 — a clean database, built only by the repo's own script
>
> 1. **Create a fresh database** separate from `aks` (a new container or a new database in one — your
>    choice, but **do not touch `aks` and do not drop anything**). Leave the existing data alone; other
>    agents are reading it.
> 2. **Apply the schema using `scripts/apply-schemas.sh` and nothing else** — the repo's own path, every
>    migration it registers, in its own order. If that script cannot build a complete database from empty,
>    **that is a finding, not something to work around**: report exactly which migration it misses.
> 3. **Verify the result against `schema.sql`**: for the `wiki` (and `kg` if the script covers it) schemas,
>    compare **every table and every column** declared in the SQL files against `information_schema.columns`.
>    Report a table of **declared but missing** and **present but undeclared**, both empty being the pass.
> 4. **Prove the reader works**: `createPageContentSource(db, stackId)` must succeed against the fresh
>    database — on an empty stack is enough — where it fails against `aks`. That is the end-to-end evidence.
>
> ## Part 2 — the guard, which is the real deliverable
>
> **A check that a database's columns match `schema.sql`'s declarations**, failing loudly with the names of
> the missing columns and the migration that likely provides them.
>
> - **Where it belongs**: if `scripts/apply-schemas.sh` is the thing that builds a database, the check
>   belongs next to it — either as a step it runs, or as a script it invokes. **Decide from the code, not
>   from my prose.**
> - **It must be runnable against any database** by passing a connection, so CI and a developer can both
>   use it.
> - **It must fail on exactly the defect above**: a database missing `wiki.pages.aliases` exits non-zero
>   and names the column.
> - **It must not require fixtures or a corpus** — an empty, correctly-migrated database passes.
> - **Test it twice over**: the parity logic against a **known-good** fresh database (pass) and against a
>   deliberately **reduced** one — drop one column in a throwaway schema or table and prove the check
>   names it. **A check that cannot fail is decoration.**
>
> **Report the class this guard does and does not cover.** It catches *column* drift. It does not catch a
> wrong type, a missing index, a missing constraint, or a migration applied out of order. Say so rather
> than implying completeness. If indexes and constraints are cheap to include, include them and say which.
>
> ## Scope
> One check script plus its wiring, and the clean-database verification as evidence. **No production
> read-path change, no migration edit, no data migration, no `aks` write.** If you find `apply-schemas.sh`
> itself is incomplete, **report it and do not fix it** — that is a separate decision.
>
> ## Gates
> `npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**) ·
> `npm run fallow:ci` — if it prints "compared nothing", say so · **`pnpm test` under the CI form** if you
> touch anything under `scripts/`: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm exec
> turbo run test --filter=//`, asserting the population from its own summary rather than the exit code.
>
> ## Prohibitions
> No `--no-verify`, no `HUSKY=0`, no `--amend`, no push, no `.env*` read, no credential in any output, no
> provider call, **no write of any kind to `aks`**, no `drop` outside the database you created.
>
> ## Report
> The clean-database creation with the command used and the apply-schemas output · **the declared-vs-present
> comparison, both directions** · the reader succeeding where it failed · what the guard covers and does
> not · how the guard was proven to fail · whether `apply-schemas.sh` was complete and what it missed if
> not · the count of columns the fresh database has versus what `aks` had · gate exits with the lint
> triple · full 40-char SHA · `git status --short` · `Risk:` line · and **confirmation that `aks` was not
> written to**.

L2 (Lead evidence: environment). Worktree clean at `054e6b16a627cc812fcc5d1454fb3b39d8730d35`, branch
`fix/schema-parity-guard-and-fresh-db`. Install `corepack pnpm install --frozen-lockfile` exit `0`; build
exit `0`, `dist/api.js` present. Baseline gates all exit `0`: `tsc`, `typecheck:tests` (238 baseline
diagnostics, no regression), `lint` — triple **558 / 396 / 423**, exactly at the ceiling, so the change has
**zero lint headroom** — and `fallow:ci`, which printed "compared nothing" because local `main` equals
`HEAD`. Node 24 must be prefixed on every gate command (`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`).

L3 (Lead evidence: clean database, Part 1 PASS). Database `parityfresh_1794543960` created in container
`llmwiki-kg-db-1` (pgvector/pg16, `127.0.0.1:5434`, user `aks`); built only by
`PSQL="docker exec -i llmwiki-kg-db-1 psql -U aks -d parityfresh_1794543960" bash scripts/apply-schemas.sh`,
exit `0`, 17 files applied in the script's own order. Declared `30 tables / 308 columns` == present
`30 / 308`; both diff directions empty. `wiki` = 20 tables / 164 columns, `public` = 10 tables / 144
columns and all ten are KG-owned (`schema.sql` declares them unqualified, so there is no `kg` schema
anywhere). Reader proof: succeeds on the fresh database, fails on `aks` with `42703`. `aks` was not written
(its counters identical before and after: 12 databases | 32 tables | 271 columns | 4753 stacks rows |
619 pages rows).

L4 (Lead evidence: `aks` drift, wider than the brief). `aks` vs the same declaration set: 5 missing tables
(`public.kg_classification_log`, `public.kg_evidence`, `wiki.categories`, `wiki.category_members`,
`wiki.curated_links`) and **86 missing columns** across 10 tables — including `wiki.pages.aliases` and
`wiki.pages.attribution_gaps`, and the whole classification block (`kg_classification_log` 16,
`kg_evidence` 16, `ontology_relationships` 14, `ontology_entities` 13, `curated_links` 9, `categories` 7,
`category_members` 5, `stacks` 2, `embedding_store_meta` 2). Present but undeclared: 7 legacy tables and
49 columns. Arithmetic: 308 = 222 shared + 86 missing; 271 = 222 shared + 49 undeclared. `aks` 271 columns
vs fresh 308; `aks` wiki 23 tables / 178 columns vs fresh 20 / 164.

L5 (Lead evidence: why nothing noticed). The existing gate
`CHECK_ONLY=true ./scripts/apply-schemas.sh` validates row-level security over `REQUIRED_TENANT_TABLES`
(25 entries) and never compares columns, so **it passes on `aks` as it stands**. It also omits 5 of the 30
declared tables (`public.kg_evidence`, `public.kg_classification_log`, `wiki.activity_log`,
`wiki.derived_artifact`, `wiki.ingest_job`). This is the gap S4 closes.

L6 (Lead evidence: reader reachability). `@repo/wiki`'s `exports` map has no `"."` entry and no entrypoint
re-exports `createPageContentSource`, so proving S3 from outside the package required bundling a probe with
the repo's own esbuild against its sources. The committed tests must therefore not depend on importing that
symbol from a package specifier; the parity checker's own CLI is the seam the tests use.

L7 (owner directive, verbatim):

> **Now extend the check that exists, rather than adding a second one beside it.**
>
> `CHECK_ONLY=true ./scripts/apply-schemas.sh` checks **RLS on 25 of 30 tables and never compares columns, so it passes on `aks` as it stands.** That is not a missing feature — **it is a live check that answers a narrower question than a reader will assume it answers.** A second script next to it means someone runs the wrong one and reads a green. **If `CHECK_ONLY` can carry the column comparison structurally, put it there.** If you conclude it cannot without distorting the script, say so and build the separate check — but say why, not just that.
>
> ## And do not soften the 86
>
> **The guard's first run against `aks` reporting 86 missing columns and 5 missing tables is correct behaviour**, not a false positive to tune down. Include the full list in the report, grouped by table, with the migration that provides each. **A check whose first real finding gets filtered is a check that will be trusted for the wrong reasons.**
>
> ## Three things your report settles, and should be phrased as settled
> 1. **`apply-schemas.sh` is complete** — 30/308 declared == 30/308 present, 0 drift both ways, idempotent on re-run. That closes a standing board item, and the evidence is the strongest available: **it builds a database that the production reader can open.**
> 2. **Both omitted `.sql` files are correctly omitted**, with the reason for each recorded — `migration_drop_ingest_outbox.sql` is operator-only by its own header, and `migration_open_kg_classification.sql` declares only tables `schema.sql:527/:558` already creates, **61 of 61 columns present**. That was carried as debt; it is not debt, and the report should say so rather than leaving it open.
> 3. **The reader proof both ways** — `listSlugs → []` exit 0 on fresh, `42703` exit 1 on `aks` — is the end-to-end evidence, and it is worth more than the column count because it is what a user experiences.
>
> ## What I want from the guard, restated narrowly
> **One check. It fails on exactly the defect above and names the column and the migration that likely provides it.** It catches column drift; **say plainly what it does not catch** — wrong type, missing index, missing constraint, wrong order — unless you can include some of those cheaply, in which case say which.
>
> `aks` is **not** to be brought current. The owner has declared it disposable test data; the fresh database is the forward path, and it now demonstrably works.

L8 (independent verify, then a bounded fix pass). The verifier returned **MET on every spec item
(S1-S13, D1-D8)** and reported one **blocking defect** plus one **documentation gap**. Four fixes applied,
none of them a redesign.

**FIX 1 (blocking, a REAL defect caught before the commit).** `scripts/schema-parity-check.ts` ended with an
unconditional `process.exitCode = main(process.argv.slice(2))` at module scope, and the committed suite
imports that module. Measured twice: `node --input-type=module -e 'await import(<checker>)'` exited `2` with
`error: schema parity needs a connection: pass one as an argument, or set DATABASE_URL (or PSQL).`, and inside
vitest the same import printed `schema parity: FAIL - ...` into the suite output and set `process.exitCode = 1`
on a run where 10/10 assertions passed. A checker whose `import` runs the CLI makes every importer a caller of
the CLI — the class of defect this work unit exists to remove, sitting inside the guard itself.
RED first: a new test spawns `process.execPath --input-type=module -e 'await import(<abs path>)'` and asserts
`status === 0` and `stderr === ""`; it failed with `expected 'error: schema parity needs a connecti…' to be ''`.
GREEN after guarding the entry point: `main()` now runs only when the module is the program Node was told to
run — `process.argv[1]` (absent under `node -e`) resolved through `realpathSync` and compared with
`import.meta.url` via `pathToFileURL`. `node scripts/schema-parity-check.ts` and the runner's `PSQL`/`psql`
path keep working: the end-to-end run below proves it (exit `0` clean, exit `1` on drift).

**FIX 2 (documentation gap).** `COMPARED_SCHEMAS = ["public","wiki"]` bounds the comparison, so a declaration
in any other schema would be invisible rather than reported — unreachable today (every `create table` in the 17
registered files qualifies `wiki` or nothing) but nowhere stated. Added to the checker's coverage header (a
dedicated section, plus a line in the "Does NOT catch" list) and to the "What it does NOT catch" paragraph of
`docs/guides/wiki-db-parity-migration.mdx`.

**FIX 3.** The drop-one-column end-to-end test asserted `afterDrop.status` `not.toBe(0)`, which a crash (exit
`2`) could satisfy as if it were a parity failure. Tightened to `toBe(1)`.

**FIX 4 (regression pins for the `--check` behavior this change touches).** Three tests appended: node absent
from `PATH` fails loudly with both exact messages and exit `2` (a `mkdtemp` directory symlinking `bash`,
`docker`, `psql`, `tr`, `dirname`, `cat` and deliberately no `node`, removed in `finally`); an undeclared
column (`alter table wiki.pages add column legacy_probe int`) is a warning, exit `0`, printed as
`undeclared (1, warning only, exit unaffected):` + `column wiki.pages.legacy_probe`; and
`alter table wiki.lint_cache disable row level security` keeps the RLS half's exact answer — exit `1`, stdout
still `schema parity: ok`, stderr `  MISSING RLS: wiki.lint_cache` + `drift detected.`, and no
`ok: every tenant table enforces row-level security.` line. Each mutating case mints its own per-run database
through a `withFreshDatabase` helper (`createSuiteDatabase(...).drop()` in `finally`), because one adds a
column and another disables RLS and a shared database would make each depend on the other's order. The three
pins passed on first run: they pin behavior already implemented earlier in this uncommitted unit (T3), so no
RED was reproducible without a copy of the base tree, which the parent owns.

**A size finding from the gate, recorded rather than hidden.** The house rule is < 400 code lines and
`scripts/schema-parity-check.ts` was already at 395, so the entry-point guard pushed it to 410 and
`pnpm run lint` failed with `max-lines File has too many lines (410)`. Resolved inside the same file: the
guard was written as five code lines and two purely mechanical line joins (`formatReport`'s spread array,
`quotedPaths`'s `flatMap`) brought the file to 398 code lines. No behavior changed. The file is one refactor
away from the ceiling and that debt is real, not closed here. `pnpm run lint` then reported
`558 baseline violations in 396 files across 423 rule/file entries; no regression` — exactly the ceiling
`558 / 396 / 423`, so the change still has zero lint headroom.

**Validation of the pass.** `vitest run test/schema-parity-check.test.ts test/apply-schemas-check-flag.test.ts`
exit `0`, 2 files / 17 tests passed. `tsc --noEmit` exit `0`; `typecheck:tests` exit `0` (1600 files checked,
238 baseline diagnostics in 86 files, no regression); `lint` exit `0`; `fallow:ci` exit `0` and it printed
"compared nothing" (merge-base of local `main` and `HEAD` is `HEAD`); `bash -n scripts/apply-schemas.sh`
exit `0`. End-to-end on a throwaway database this pass created (`parityfix_1794545966`, dropped afterwards):
apply exit `0`, `CHECK_ONLY=true` exit `0` with `schema parity: 308 declared columns all present.` +
`schema parity: ok` + `ok: every tenant table enforces row-level security.`; after
`alter table wiki.pages drop column aliases`, exit `1` with
`    wiki.pages.aliases  provided by packages/wiki/src/dimensions/wiki/migration_wiki_db_parity.sql`,
`schema parity: FAIL - 1 missing columns in 1 tables, 0 missing tables.` and `drift detected.`. `aks` was not
written to. Leftover probe directories `/tmp/gpaNywqo` and `/tmp/parity-verify-qqLcxh` removed.

L9 (work unit). Commit W1 holds T1-T5: `2b99ba9552c080907c71deffb798e6f4a8f6b2b3`. Gates, all re-run on the
exact tree committed: tsc exit `0`; typecheck:tests exit `0` (1600 files, 238 baseline diagnostics in 86
files, no regression); build exit `0`; lint exit `0` (triple **558 / 396 / 423**, no regression); fallow:ci
exit `0`, and it printed "compared nothing" because merge-base(local `main`, `HEAD`) is `HEAD`; the CI-form
suite `turbo run test --filter=//` exit `0` with **838 files (834 passed, 4 skipped)** and **6280 tests
(6269 passed, 11 skipped)** read from its own summary, plus `1 successful`. `test:affected` exited `78`: it
reports that scope resolves to the full unit tier and names the CI form, which is the suite run above, so the
full suite is the substitute rather than a skipped gate.

L10 (final slice: the last silent-green path). An independent verifier confirmed L8's fixes but found ONE
residual silent-green path — the exact class this guard exists to prevent — and one weak pin. Both are closed.

**The hole, reproduced.** `node < scripts/schema-parity-check.ts` (the source piped in as the program) leaves
`process.argv[1]` undefined, so the L8 entrypoint guard judged the module "imported", skipped `main()`, and
the process **exited `0` with no output at all**: a silent no-op pass from the one command whose job is to
refuse silent no-op passes. Measured: `node < scripts/schema-parity-check.ts; echo $?` → no output, exit `0`.
RED first, a new test in `test/schema-parity-check.test.ts` spawns
`spawnSync(process.execPath, [], { input: readFileSync(CHECKER), cwd: REPO_ROOT, env: baseEnv() })` and asserts
`stdout === ""`, `status === 2`, `stderr` containing `error: schema parity needs a connection`. Observed RED on
the committed tree: `AssertionError: expected +0 to be 2 // Object.is equality` — the `stdout === ""`
assertion passed *because* the run printed nothing at all, which is the defect stated as an assertion.

**`import.meta.main` was tried and rejected on measured evidence, not by a gate.** The brief expected it to be
`true` for the stdin form on Node 24. It is not. Probed on this exact runtime (`v24.21.0`) with a three-line
module printing `process.argv` and `import.meta.main`: direct `node probe.ts` → `argv[1]` set, `main` **true**;
`node < probe.ts` → `argv[1]` **absent**, `main` **false**; `node --input-type=module -e 'await import(...)'` →
`argv[1]` absent, `main` **false**. So `import.meta.main` cannot tell the piped-in program from an import and
would have left the hole open. `tsc`/`lint` never had to reject it: measurement did. What does distinguish them
is where the module itself lives — a piped-in program is an eval-style module whose `import.meta.url` is a
pseudo-URL ending `[eval1]` under the cwd, while an imported file keeps its own file URL. The predicate is now
one hoisted constant, `EVAL_MODULE = /\[eval\d*\]$/`, used by `isEntryPoint()` for the absent-`argv[1]` case and
unchanged `realpathSync`/`pathToFileURL` comparison when `argv[1]` is present, so all four forms are covered:
direct `node scripts/schema-parity-check.ts`, absolute path, and a `/tmp` symlink each exit `2` naming the
missing connection (measured by hand), the piped-in form the same, and
`node --input-type=module -e 'await import("<abs>/scripts/schema-parity-check.ts")'` still exits `0` with
stdout and stderr both empty.

**A second consequence of the same pseudo-URL, found by the RED test.** `REPO_ROOT` was
`fileURLToPath(new URL("..", import.meta.url))`; under the piped-in form that resolves to the *parent of the
cwd*, so the checker read the runner from `../scripts/apply-schemas.sh` and died with
`error: ENOENT: no such file or directory, open '.../llm-wiki-compiler/scripts/apply-schemas.sh'` — loud, but
for the wrong reason and not the connection message. `REPO_ROOT` now takes `process.cwd()` in exactly that
eval case and keeps the file-relative resolution otherwise, and its docblock says so: piped in from anywhere
but the repository root it fails loudly on the runner it cannot read (exit `2`) rather than passing on a
surface it never compared.

**The weak pin is now a full pin.** The import pin asserted `stderr` and the exit code but not stdout; it now
asserts `status === 0`, `stdout === ""`, `stdout` not containing `schema parity:`, and `stderr === ""`.

**Size, measured.** `scripts/schema-parity-check.ts` was at 398 of 399 permitted code lines, so the change had
to pay for itself: `EVAL_MODULE` (+1), the one-line `REPO_ROOT` ternary (net 0) and one mechanical line join in
`formatMissingTables`' spread (-2) leave the file at **397** code lines, and `isEntryPoint` is still 4. No
behavior changed in the joined line.

**Validation of this slice.** `vitest run test/schema-parity-check.test.ts test/apply-schemas-check-flag.test.ts`
exit `0`, 2 files / 18 tests passed (RED above, then GREEN). `tsc --noEmit` exit `0`; `typecheck:tests` exit `0`
(1600 files, 238 baseline diagnostics in 86 files, no regression); `lint` exit `0` — `558 baseline violations in
396 files across 423 rule/file entries; no regression`, the ceiling exactly; `fallow:ci` exit `0` and it did
**not** print "compared nothing" (it compared against local `main` as its base ref and reported `0 dead-code, 0
complexity, 0 duplication introduced`); `bash -n scripts/apply-schemas.sh` exit `0`. End-to-end on a
`paritystdin_<epoch>` database this slice created and dropped: apply exit `0`, `CHECK_ONLY=true` exit `0` with
`schema parity: 308 declared columns all present.` / `schema parity: ok` / `ok: every tenant table enforces
row-level security.`; `alter table wiki.pages drop column aliases` then `CHECK_ONLY=true` exit `1` with
`    wiki.pages.aliases  provided by packages/wiki/src/dimensions/wiki/migration_wiki_db_parity.sql`,
`schema parity: FAIL - 1 missing columns in 1 tables, 0 missing tables.` and `drift detected.`; re-apply exit `0`
and the check exit `0` again. CI-form suite `turbo run test --filter=//` exit `0`, **838 files (834 passed, 4
skipped)** and **6281 tests (6270 passed, 11 skipped)** from its own summary, `1 successful` — one test more
than L9, which is this slice's new case. `aks` was not written to (counters identical at 12 | 32 | 271 | 4753 |
619 before and after).

L11 (rebase). The branch was rebased onto `d7d46b94778817614939c2a500aef84486bdd150` (local `main`), which
**supersedes the SHAs recorded in L9 and L10**: every commit below is the same tree replayed on the new base,
and the L9/L10 hashes no longer name anything reachable from this branch. The owner verified beforehand that the
target commit touches exactly `packages/wiki/src/compiler/link-anchoring.ts`,
`test/compiler/link-anchoring.test.ts` and `odd/tasks/fix-anchoring-accepts-honest-short-labels.md` — disjoint
from this work unit's five paths — and `git rebase` confirmed it: **no conflict**, working tree clean after.

- `6dd2b66a236bb9914845bee1a1e659458b629de1` feat(schema): fail the database check when declared columns are missing (was `2b99ba9552c080907c71deffb798e6f4a8f6b2b3`)
- `b0746f375e76b73a9d5d2d07b95402a92cffd83f` docs(odd): record the schema-parity-guard work unit (was `02e2e44566d2e4e57135293724ff07f5e54cf858`)
- `6f5b32183be7e1b3c32f42b6e12963e13e026dcd` fix(schema): refuse to pass silently when the check is not given a connection (was `6b53881238e7aa25435d85389537b71b9c8643e2`)
- `66c92ed3e685befdb8fa17dc203d71e556579a7a` docs(schema): record why the entrypoint probe is not import.meta.main (pre-rebase `cde5545c4054ff1b08920e7f6a2757445537f0c8`)

The header comment in `scripts/schema-parity-check.ts` now carries the measurement in the file itself: on Node
v24.21.0 `import.meta.main` is `false` for a program piped in as `node < script.ts`, so it is NOT a substitute
for the `[eval]` pseudo-URL predicate, and the committed test `fails loudly when its source is piped in as the
program, never passing silently` is what goes red if a future Node release changes that naming.

The checker sits at **397 of 399 permitted code lines**; the owner recorded that budget as **the next slice's
first task**, explicitly not to be refactored in this one.
