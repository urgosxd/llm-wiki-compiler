# SDK facade — finish the `env`-threading family

Branch: `fix/facade-env-remaining-sites`, base HEAD `c59228b38ae4bb7fd40d2f0ea3e85c05ad610389`.

HIGH-RISK: tenant isolation — `lint`/`lintByTier` on a Stack-bound handle can answer from the ambient Stack or from the filesystem while the request names a different one. Continues the facade work unit recorded in `odd/tasks/getpage-sql-error.md` (tracker, L3), which carried no `S#` of its own.

## Specs

**S1 — Scope (verbatim).** "Finish the `env`-threading family in the published SDK facade. Four sites were fixed in the last two slices (`ingest`, `ingestText`, `compile`, `status`); **three remain**, and leaving the same defect half-done is the pattern we keep refusing."

**S2 — The three remaining sites (verbatim).** "In `packages/wiki/src/sdk/core.ts`, the previous slices left three:" — "**`:147` `getSource`** — drops `env`." — "**`:164-166` `lint` / `lintByTier`** — drop `env`."

**S3 — First discrimination: is it a defect at all? (verbatim).** "**Verify before fixing, per site.**" — "**Does the operation have a row-aware path at all?** If `lint` only ever reads the filesystem, dropping `env` is **inert**, and the correct outcome is a comment recording that it is inert and why — **not** a threading change that adds a database requirement nobody needed. That distinction is worth as much as the fix."

**S4 — Second discrimination: measure the failure (verbatim).** "**If it does have a row path, what does dropping `env` actually produce?** Measure it: a Stack-bound `createWiki({root, env})` whose operation answers from the ambient or file backend while `ingest` wrote rows. Options are a wrong-tenant read, an empty result, or a silent fallback — say which, with the observation."

**S5 — Fix shape and RED (verbatim).** "**Only then** thread `env`, mirroring exactly the shape the `compile`/`status` fix landed, and **RED first** for each site that is real."

**S6 — All-inert is a successful outcome (verbatim).** "If all three turn out inert, the slice ships as three comments plus a test pinning the inertness, and that is a **successful** outcome — do not manufacture a threading change to justify it."

**S7 — What must not widen (verbatim).** "`listSources()` having no row path at all is the **larger shared defect** recorded by the last slice: a Stack deployment with no `sources/` tree leaves both surfaces agreeing on a number that describes nothing. **Not this slice.** Record only." — "`writeStateFor` with no production caller, `core-types.ts` returning `Promise<unknown>`, the spurious `deleted`+`new` pending pair, the two-tarball install requirement — all recorded, none touched." — "Do not "improve" `status` or `collect.ts`; they were fixed last slice and the count now derives from `listSelectedSourceFiles` deliberately."

**S8 — Database discipline (verbatim).** "Use a **freshly provisioned** database for anything row-backed. **Do not point `LLYWIKI_TEST_DATABASE_URL` or the Testcontainers handoff at `kind_kirch`** — it is schema-stale (missing `aliases` and `attribution_gaps`) and the last slice had two intermediate runs adopt it before re-pinning, which it had to disclose. Read any port with `docker port <name> 5432/tcp`; never hardcode one."

**S9 — Gates (verbatim).** "`gates:static` · `tsc --noEmit` · `typecheck:tests` · `typecheck:kg` · `lint` (**zero headroom**: literal `566 baseline violations in 402 files across 429 rule/file entries`; new code must be violation-free and **`lint:update` is forbidden**) · `fallow:ci` · `fallow:kg` · `build` · `test/artifact/*` · **`pnpm test` alone**. `test/main-subcommand-flags.test.ts:147` has a known SIGTERM flake — name it if it appears, do not absorb it."

**S10 — Hard prohibitions (verbatim).** "No history rewriting (no `git reset`, `git restore --staged`, `--amend`), **no hook bypass of any kind** — `git -c core.hooksPath=/dev/null` is `--no-verify` and has been disclosed twice as a violation already. No push, no `--no-verify`, no `HUSKY=0`, no `cp -a` of this worktree. `odd/tasks/**` append-only except the tracker line."

**S11 — Report (verbatim).** "Per site: inert or real, the observation that decides it, and what the fix is (or the comment recording inertness). The RED/GREEN for each real site. If a fix creates a new database requirement, say so in one searchable sentence — the previous slice's `status()` gained exactly that and it must reach the CHANGELOG. Every gate exit with the literal lint triple; commit SHAs as **full 40 characters**; `git status --short`; and a `Risk:` line — **item 3 if any of these is published surface** (`getSource`/`lint` are on `createWiki`), **item 1 if a dropped `env` means a wrong-tenant read**, **item 6 if the behaviour had no test**, which is how it survived."

## Tasks

- [ ] T1 · S1,S2,S11 · feature document (this file) · route: gentle-ai-worker · commit: tbd
- [ ] T2 · S3,S6 · `getSource`: inert-or-real verdict, the comment recording it, and a test pinning it · route: gentle-ai-worker · commit: tbd
- [ ] T3 · S3,S4,S5 · `lint`/`lintByTier`: measured RED, then thread `env` for GREEN · route: gentle-ai-worker · commit: tbd
- [ ] T4 · S11 · `CHANGELOG.md` entry for any new database requirement this slice introduces · route: gentle-ai-worker · commit: tbd
- [ ] T5 · S7 · non-goals held: nothing widened beyond the three sites · route: lead (review) · commit: n/a
- [ ] T6 · S9,S10 · gates and evidence · route: lead · commit: tbd

Tracker: T1 in progress · base `c59228b38ae4bb7fd40d2f0ea3e85c05ad610389`

## Log

L1 — Assignment verbatim (opening clause): "Finish the `env`-threading family in the published SDK facade." The normative clauses follow verbatim in S1–S11.

L2 — Lead recon evidence, recorded as the starting point every task must re-derive per site rather than trust: `packages/wiki/src/sdk/core.ts:86` resolves `const env = options.env ?? process.env;` once; `:147` is `getSource: (id) => runQuiet(() => getSource(root, id)),`; `:164` is `lint: () => runQuiet(() => lint(root)),`; `:166` is `lintByTier: () => runQuiet(() => lintByTier(root)),`. The callee `packages/wiki/src/linter/index.ts` ALREADY accepts the parameter — `:243-246` `lint(root, env: NodeJS.ProcessEnv = process.env)` and `:280-283` `lintByTier(root, env: NodeJS.ProcessEnv = process.env)` — and `collectGroupsInScope(root, scope, env)` at `:207-211` already resolves both snapshot halves from that `env`, so the dropped facade argument is the only gap. `test/sdk/facade-env-threading.test.ts` (256 lines) covers `compile`/`status` ONLY — neither `getSource` nor `lint`/`lintByTier` has any test, which is how the defect survived.
