# pnpm phantom dependencies — bounded cleanup

Three small fixes the pnpm migration discovered about itself: dead `.npmrc` config,
`drizzle-orm` declared only by the KG package but imported from root `src/`, and
`tsup` used by `packages/llmwiki-core` without being declared there.

## Specs

### S1 — Prove which `.npmrc` keys are honored before touching anything

"pnpm 11 does not read `node-linker` or `onlyBuiltDependencies` from `.npmrc`" — with the requirement "Prove which keys are honored before touching anything": "for each key in `.npmrc`, run the corresponding `pnpm config get <key>` and report the value. Then remove the keys pnpm does not read, keeping only what genuinely binds (npm-level keys matter because `npm publish` and `npm pack` are still npm's job here — leave those alone and say which they are). If `.npmrc` ends up empty, deleting the file is correct; state that rather than keeping an empty shell."

### S2 — Declare `drizzle-orm` in the root `package.json`

"`drizzle-orm` is imported by ~24 files under root `src/`, yet declared only in `packages/llmwiki-kg/ts/package.json`. It resolves today purely because `nodeLinker: hoisted` flattens the tree."

Requirement: "Declare it in the root `package.json` at the exact same semver range the KG manifest already uses — copying the range, not choosing one. No version movement is authorized: after the change, the resolved version in `pnpm-lock.yaml` must be byte-identical for every package."

### S3 — Declare `tsup` in `packages/llmwiki-core`

"`packages/llmwiki-core/tsup.config.ts` uses `tsup`, but that package declares no devDependencies for it. Declare it there, again copying the existing range from whatever manifest already has it. Same rule: resolved version unchanged."

### S4 — Out of scope (explicitly not this delivery)

"Do not touch `.fallowrc.json`." and "Do not remove `nodeLinker: hoisted`." and "Do not touch `eslint-baseline.json`." and "Do not fix the ~40 stale `npm` references in scripts/comments/docs; that is a separate prose pass."

### S5 — Install and resolve proof

"`pnpm install --frozen-lockfile` from a clean state, exit 0." and "`node -e \"require.resolve('drizzle-orm/package.json')\"` from the repo root after install (or the pnpm equivalent) proving it resolves without relying on another package's node_modules."

### S6 — Gates

"`pnpm exec tsc --noEmit` · `pnpm run lint` (**650/498/526**, must not move) · `pnpm run typecheck:tests` · `pnpm run typecheck:kg` · `pnpm run build` · `pnpm run fallow:ci` · `pnpm run test:affected` · and `pnpm test` only if `pgrep -af vitest` is empty, otherwise NOT RUN with the reason."

### S7 — Move `ajv` ownership to the package that imports it

Lead requirement, verbatim: "declare `ajv` in the KG package copying the existing root
range verbatim, remove it from root `dependencies`, and delete the `.fallowrc.json`
ignore entry — with the invariant 'no version may move'".

Defect it fixes, as stated by the Lead: `packages/llmwiki-kg/ts/src/routes/aks/export-conformance.test.ts:27-28`
imports `ajv/dist/2020.js` but the KG manifest declares no `ajv` — the same phantom class
as `drizzle-orm`. It resolved only via `nodeLinker: hoisted`. Meanwhile ajv's last ROOT
importer (`src/providers/codex-agent.ts`) was deleted by main's `66fc76d`, which also
added an `"ajv"` entry to `.fallowrc.json` `ignoreDependencies` to silence the now-unused
root declaration. "Move ownership to where the import lives and delete the ignore."

## Tasks

- T1 (S1) — `.npmrc` proof via `pnpm config get` / `pnpm config list`, then removal of unread keys or deletion of the file. **status: done (L2/L3/L9) — file DELETED, not stripped; no keys retained.** commit: `9da4a18152876aa302c16ebe8cada703fef3e25d` (pre-rebase) → `993df6bb3c8ce5de689d08c50818bdc88525ad96` (post-rebase, unit 1)
- T2 (S2) — root `package.json`: declare `drizzle-orm` copying the KG range. **status: done (L4).** commit: `9da4a18152876aa302c16ebe8cada703fef3e25d` (pre-rebase) → `993df6bb3c8ce5de689d08c50818bdc88525ad96` (post-rebase, unit 1)
- T3 (S3) — `packages/llmwiki-core/package.json`: declare `tsup` devDependency copying the root range. **status: done (L5).** commit: `9da4a18152876aa302c16ebe8cada703fef3e25d` (pre-rebase) → `993df6bb3c8ce5de689d08c50818bdc88525ad96` (post-rebase, unit 1)
- T4 (S5-S6) — lockfile absorption with zero version movement, clean `--frozen-lockfile` install, `require.resolve` proof, and all gates. **status: done (L6/L7/L10).** commit: `9da4a18152876aa302c16ebe8cada703fef3e25d` (pre-rebase) → `993df6bb3c8ce5de689d08c50818bdc88525ad96` (post-rebase, unit 1)
- T5 (S7) — move `ajv` ownership: declare it in `packages/llmwiki-kg/ts/package.json` devDependencies at the root range copied verbatim, delete the root `dependencies` entry, delete the `.fallowrc.json` `ignoreDependencies` entry and the KG baseline `unlisted_dependencies` line, correct the stale comment in the conformance test, extend `test/declared-dependencies-wiring.test.ts`, and re-prove the lockfile invariant. **status: done (L11).** commit: `856bf3a4403bb6fca966a3ed018076e801cd0859`

## Log

### L1 — Original request (verbatim)

Fenced as a code block because the quoted assignment contains `##` heading lines
(`## Allowed edit surfaces`, `## Phase 0`, …). Unfenced they parsed as sections of
this document, which put sections after `## Log`. The bytes inside the fence are
the request verbatim, headings included.

```text
Task:
Bounded ODD implementation in Pi worktree: /home/urgosxd/.herdr/worktrees/llm-wiki-compiler/chore-pnpm-phantom-deps — branch chore/pnpm-phantom-deps, HEAD dafa32bf42c6ed24d83baf3e1d9b5e49bf8a6dd4.

## Allowed edit surfaces
- package.json
- packages/llmwiki-core/package.json
- pnpm-lock.yaml (only as produced by pnpm itself)
- .npmrc (delete only if Phase 1 proves every key is unread)
- odd/tasks/pnpm-phantom-deps.md (new file)

Nothing else. Do NOT touch `.fallowrc.json`, `eslint-baseline.json`, `pnpm-workspace.yaml`, or any source file.

## Environment
Every command MUST be prefixed: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. Report `node --version` and `pnpm --version` (expect Node v24.x, pnpm 11.5.0).

## Hard constraints (violating any = stop and report, do not proceed)
1. No version movement anywhere. After your change, every resolved version in `pnpm-lock.yaml` must be byte-identical. The lockfile diff must contain ONLY new importer/edge entries for the two declarations below. If any package's resolved version moves, REVERT and report instead of proceeding.
2. Do NOT remove or alter `nodeLinker: hoisted` (it lives in `pnpm-workspace.yaml`, which you must not edit).
3. Do not upgrade, downgrade, add or remove any dependency other than the two declarations in fix 2 and fix 3. Copy ranges exactly; never choose one.
4. Do not modify the ~40 stale `npm` prose references in scripts/comments/docs.
5. Do not commit. Leave the tree dirty for the Lead.

---

## Phase 0 — feature document (before ANY source or manifest write)
Create `odd/tasks/pnpm-phantom-deps.md` with:
- a 2-3 line header.
- `## Specs` with numbered S1..S6 quoting the requirements below VERBATIM (copy these strings literally, do not paraphrase):
  - S1: "pnpm 11 does not read `node-linker` or `onlyBuiltDependencies` from `.npmrc`" — with the requirement "Prove which keys are honored before touching anything": "for each key in `.npmrc`, run the corresponding `pnpm config get <key>` and report the value. Then remove the keys pnpm does not read, keeping only what genuinely binds (npm-level keys matter because `npm publish` and `npm pack` are still npm's job here — leave those alone and say which they are). If `.npmrc` ends up empty, deleting the file is correct; state that rather than keeping an empty shell."
  - S2: "`drizzle-orm` is imported by ~24 files under root `src/`, yet declared only in `packages/llmwiki-kg/ts/package.json`. It resolves today purely because `nodeLinker: hoisted` flattens the tree." Requirement: "Declare it in the root `package.json` at the exact same semver range the KG manifest already uses — copying the range, not choosing one. No version movement is authorized: after the change, the resolved version in `pnpm-lock.yaml` must be byte-identical for every package."
  - S3: "`packages/llmwiki-core/tsup.config.ts` uses `tsup`, but that package declares no devDependencies for it. Declare it there, again copying the existing range from whatever manifest already has it. Same rule: resolved version unchanged."
  - S4: "Do not touch `.fallowrc.json`." and "Do not remove `nodeLinker: hoisted`." and "Do not touch `eslint-baseline.json`." and "Do not fix the ~40 stale `npm` references in scripts/comments/docs; that is a separate prose pass."
  - S5: "`pnpm install --frozen-lockfile` from a clean state, exit 0." and "`node -e \"require.resolve('drizzle-orm/package.json')\"` from the repo root after install (or the pnpm equivalent) proving it resolves without relying on another package's node_modules."
  - S6: Gates: "`pnpm exec tsc --noEmit` · `pnpm run lint` (**650/498/526**, must not move) · `pnpm run typecheck:tests` · `pnpm run typecheck:kg` · `pnpm run build` · `pnpm run fallow:ci` · `pnpm run test:affected` · and `pnpm test` only if `pgrep -af vitest` is empty, otherwise NOT RUN with the reason."
- `## Tasks` — one line each: T1 (S1, .npmrc proof + removal), T2 (S2, root drizzle-orm declaration), T3 (S3, llmwiki-core tsup declaration), T4 (S5-S6, install/resolve proof + gates).
- `## Log` LAST, with `L1` = this assignment's request text verbatim.

---

## Phase 1 — PROVE FIRST, before removing anything
For EACH key present in root `.npmrc` (recon says there are exactly two: `node-linker` and `link-workspace-packages`; confirm by reading the file), run the corresponding config read and capture the EXACT stdout:
- `PATH=... pnpm config get node-linker`
- `PATH=... pnpm config get link-workspace-packages`
Also run for control/cross-check and report each value: `pnpm config get nodeLinker`, `pnpm config get linkWorkspacePackages`, `pnpm config get preferWorkspacePackages`, `pnpm config get onlyBuiltDependencies`, `pnpm config get allowBuilds`, `pnpm config get registry`, `pnpm config get save-exact`. Mark unresolvable keys `undefined` and say so explicitly.
Additionally, to make the proof decisive rather than circumstantial: run `PATH=... pnpm config list` and report whether the `.npmrc` values appear in it, and report the output of `PATH=... pnpm config get node-linker` while temporarily pointing at a copy with the key removed if you need a differential (use a mktemp dir, never commit scratch files).

**STOP CONDITION:** if `pnpm config get node-linker` returns a real value (`hoisted`) rather than `undefined`, or if `pnpm config get link-workspace-packages` returns `true`, then the `.npmrc` DOES bind — do NOT delete it, stop the fix-1 work, and report the actual values. Only remove a key whose `pnpm config get` proves unread.

Then, for the surviving decision, state explicitly which `.npmrc` keys were removed, which were kept, and which keys (if any) are npm-level (npm's own `publish`/`pack` surface). Recon reports the file has NO npm-level keys — verify that yourself. If every key is unread and no npm-level keys remain, DELETE `.npmrc` entirely and record that in the task doc (do not leave an empty shell). Before deleting, record the file's full original contents in the `## Log` of the task document so the record survives the deletion — the current file describes itself as "the documented record", so preserve that record in the feature doc instead.

## Phase 2 — Fix 2: drizzle-orm in root package.json
- Read `packages/llmwiki-kg/ts/package.json`, find which section holds `drizzle-orm` (dependencies vs devDependencies) and its exact range (recon reports `^0.45.4` — verify).
- Add `"drizzle-orm": "<that exact range string>"` to the SAME section of root `package.json`. Keep alphabetical/key order consistent with the existing file.
- Record in the task doc: the range, and the file+section it was copied from.

## Phase 3 — Fix 3: tsup in packages/llmwiki-core
- Recon reports `packages/llmwiki-core/tsup.config.ts` imports from "tsup", the package's `build` script runs `tsup`, but no devDependency declares it. Verify all three claims.
- Copy the exact range from root `package.json` devDependencies (recon: `^8.0.0`) into `packages/llmwiki-core/package.json` devDependencies.
- Record the range and its source in the task doc.

## Phase 4 — lockfile + proof
1. Before editing, save a pristine copy of the original lockfile: `cp pnpm-lock.yaml /tmp/lock-<timestamp>.orig` (or use `git show HEAD:pnpm-lock.yaml > /tmp/lock.orig`).
2. Update the lockfile WITHOUT touching node_modules: `PATH=... pnpm install --lockfile-only` (expect the declarations to be absorbed with no version movement).
3. Produce the proof diff: `git diff pnpm-lock.yaml` — capture it in full if under ~80 lines, else capture `git diff --stat pnpm-lock.yaml` plus every hunk header plus the exact added/removed lines. Then prove zero version movement mechanically, for example:
   `diff <(grep -E "^\s+[a-z@][^:]*: ?[0-9]" /tmp/lock.orig | sort) <(grep -E ... pnpm-lock.yaml | sort)` — or simpler and preferred: extract all `packages:`/`snapshots:` keys from both files with `grep -oE "^  [^ ].*:$" ` style, sort, and diff them; the only differences allowed are none at all in the `packages:`/`snapshots:` region. Report the actual command and its actual exit code/output.
4. `PATH=... pnpm install --frozen-lockfile` from a clean state: `rm -rf node_modules packages/*/node_modules packages/llmwiki-kg/ts/node_modules` then `PATH=... pnpm install --frozen-lockfile`; report exit code and last ~15 lines.
5. Resolve proof from repo root: `PATH=... node -e "console.log(require.resolve('drizzle-orm/package.json'))"` — report the printed path and exit code. Also `PATH=... pnpm ls --depth 0 drizzle-orm -r` and `PATH=... pnpm why drizzle-orm` (bounded output) to show drizzle-orm as a DIRECT root dependency and not merely hoisted in from the KG importer.

## Phase 5 — gates (report each exit code + the number the gate prints)
Run in this order, capturing exit codes:
- `PATH=... pnpm exec tsc --noEmit`
- `PATH=... pnpm run lint` — MUST print 650/498/526 (or whatever the baseline triple actually is); it must not move. Quote the exact line it prints.
- `PATH=... pnpm run typecheck:tests`
- `PATH=... pnpm run typecheck:kg`
- `PATH=... pnpm run build`
- `PATH=... pnpm run fallow:ci`
- `PATH=... pnpm run test:affected` (this is the required test scope; it escalates to the unit tier on suite-wide reach)
- `pnpm test` ONLY IF `pgrep -af vitest` is empty. If vitest processes are running, do NOT run it and report `NOT RUN — vitest already running: <pgrep output>`.
Note: on a suite-wide change `test:affected` may take several minutes; that is expected, let it finish.

## Report back
1. Phase 1 proof: the EXACT stdout of each `pnpm config get` call, one line per key, plus `pnpm config list` verdict.
2. Which `.npmrc` keys bind, which were removed, which npm-level keys exist (or state there are none), and whether the file was deleted.
3. Fix 2 and Fix 3: the range copied, and the file+section each was copied from.
4. The lockfile diff (or stat + hunk headers + added lines) and the mechanical zero-version-movement proof with its command and exit code.
5. `pnpm install --frozen-lockfile` exit code; the `require.resolve` path; the `pnpm ls`/`pnpm why` evidence.
6. Every gate exit code and the lint triple exactly as printed.
7. `git status --short` and `git diff --stat`.
8. Which `S#` you covered.
9. Whether you observed RED before GREEN — for this change there is no behaviour to RED: say so explicitly instead of inventing a lifecycle, and state that verification here is structural (install/config proof) rather than behavioural.

Report honestly. If a gate fails, report the failure; do not claim completion. If a stop condition triggers, stop and say so.
```

### L2 — Phase 1 proof: which `.npmrc` keys actually bind

Toolchain (the `pnpm` shim at `~/.local/share/pnpm/bin/pnpm` is broken in this environment —
it execs a missing `@pnpm/exe/pnpm` — so pnpm 11.5.0 was invoked from the corepack cache,
which is the exact `packageManager` version this repo pins):

```
node --version  -> v24.21.0
pnpm --version  -> 11.5.0   (node $HOME/.cache/node/corepack/v1/pnpm/11.5.0/bin/pnpm.cjs)
```

`pnpm config get <key>` run from the repo root (`.npmrc` present), exact stdout:

```
pnpm config get node-linker             -> hoisted      (EXIT=0)
pnpm config get link-workspace-packages -> true         (EXIT=0)
pnpm config get nodeLinker              -> hoisted      (EXIT=0)
pnpm config get linkWorkspacePackages   -> true         (EXIT=0)
pnpm config get preferWorkspacePackages -> true         (EXIT=0)
pnpm config get onlyBuiltDependencies   -> ["cpu-features","esbuild","protobufjs","ssh2"] (EXIT=0)
pnpm config get allowBuilds             -> {"cpu-features":true,"esbuild":true,"protobufjs":true,"ssh2":true} (EXIT=0)
pnpm config get registry                -> https://registry.npmjs.org/ (EXIT=0)
pnpm config get save-exact              -> undefined    (EXIT=0)
```

`pnpm config list` (repo root) reports `"nodeLinker": "hoisted"`, `"linkWorkspacePackages": true`,
`"preferWorkspacePackages": true`, `"allowBuilds": {...}`, `"onlyBuiltDependencies": [...]`,
`"packages": [...]`, `"overrides": {...}`, `"registry": "https://registry.npmjs.org/"`.

**The two kebab-case reads above are aliases onto the camelCase settings in
`pnpm-workspace.yaml`, not reads of `.npmrc`.** Three differentials in `mktemp` directories prove it:

| scratch dir | contents | `get node-linker` | `get link-workspace-packages` |
| --- | --- | --- | --- |
| A | `.npmrc` only (`node-linker=hoisted`, `link-workspace-packages=true`), no workspace yaml | `undefined` | `undefined` |
| B | `pnpm-workspace.yaml` only (`nodeLinker: hoisted`, `linkWorkspacePackages: true`), no `.npmrc` | `hoisted` | `true` |
| C | `.npmrc` only, canary `registry=https://canary.example/` | — | `pnpm config get registry` -> `https://canary.example/` |

Dir A: the exact two `.npmrc` keys, present, and pnpm reports `undefined` for both.
Dir B: the workspace yaml alone produces `hoisted` / `true`. Dir C: `.npmrc` **is** read, for
npm-level keys — so the file is live, its pnpm-specific entries are not.

Repo-replica differential (real root `package.json` + `pnpm-workspace.yaml`, `config list` with
`.npmrc` present vs. `.npmrc` deleted in the scratch copy): the two outputs are byte-identical,
`diff` exit 0, empty output.

**Stop condition: TRIGGERED, literally.** `pnpm config get node-linker` returns the real value
`hoisted` and `pnpm config get link-workspace-packages` returns `true`, so the literal stop condition
fires and `.npmrc` was **not** deleted and **not** modified. Its stated rationale ("then the `.npmrc`
DOES bind") is, however, falsified by the differentials above: the binding source is
`pnpm-workspace.yaml`, and the `.npmrc` entries are inert. Deleting the file is provably a no-op;
the decision to act on that belongs to the human, not to this worker.

### L3 — `.npmrc` inventory and original contents (preserved before any deletion)

Non-comment lines — that is the complete key inventory, verified by reading the file:

```
node-linker=hoisted
link-workspace-packages=true
```

Both are pnpm-specific keys and both are proven unread by pnpm 11.5.0 (L2). **There are no npm-level
keys in this file** — no `registry`, no `save-exact`, no `_authToken`, no `//registry/:_auth`, no
`package-lock`, no `legacy-peer-deps`. Nothing here is npm's `publish`/`pack` surface, so nothing in
this file needs to survive for `npm publish` / `npm pack`.

Full original contents (the file describes itself as "docs/documentation of intent", so the record is
preserved here verbatim; the decision recorded in this entry was superseded — see L9, where the file
was deleted on Lead approval, so the block below is history, not live configuration):

```
# NOTE: pnpm 11.5.0 does NOT read pnpm-specific settings from this file
# (`pnpm config get node-linker` returns `undefined` with this file present).
# The live values for these two keys are in `pnpm-workspace.yaml`; this file is
# kept as documentation of intent and for tools that still read `.npmrc`.

# DELIBERATE TEMPORARY CHOICE, not the layout this repository wants long term.
#
# pnpm's default strict layout would surface phantom dependencies — imports that
# npm's flat `node_modules` satisfied implicitly — all at once, and this delivery
# changes exactly one variable: the package manager. Probing what hoisting hides
# is a follow-up, not this delivery.
node-linker=hoisted

# npm records `node_modules/@atomicstrata/llmwiki-core` as
# {"resolved":"packages/llmwiki-core","link":true} in `package-lock.json`.
# Without this, pnpm would resolve that development version from the registry and
# change what the root package actually imports.
link-workspace-packages=true
```

Note the file's own header comment claims `pnpm config get node-linker` returns `undefined` with the
file present. That is only true when `pnpm-workspace.yaml` is absent (scratch dir A); in this repo
the workspace yaml supplies the value, which is why the repo-root read returns `hoisted`.

### L4 — T2 record: `drizzle-orm` in the root `package.json`

- Import evidence: 24 files under root `src/` import `drizzle-orm` (grep over `src/`), e.g.
  `src/dimensions/wiki/database.ts`, `src/services/stacks/stack-store.ts`, `src/mcp/tenant-db.ts`.
- Declared before the change in exactly one manifest: `packages/llmwiki-kg/ts/package.json` line 21.
- Section copied from: **`dependencies`** of `packages/llmwiki-kg/ts/package.json`.
- Range copied **verbatim**: **`^0.45.4`** (not chosen, not re-ranged).
- Section written to: **`dependencies`** of root `package.json`, inserted alphabetically between
  `dotenv` and `js-yaml`.

### L5 — T3 record: `tsup` in `packages/llmwiki-core`

All three recon claims verified before the write:

1. `packages/llmwiki-core/tsup.config.ts:5` — `import { defineConfig } from "tsup";`
2. `packages/llmwiki-core/package.json` scripts — `"build": "tsup"`
3. No `devDependencies` section existed in that manifest at all (grep for `"tsup"` matched only the
   `build` script line, plus the root manifest).

- Section copied from: **`devDependencies`** of the root `package.json` (line 117).

**Correction (see L10.2): the root `tsup` entry is at `package.json:118`, not 117.**
Verified: `grep -n '"tsup"' package.json` → `24:    "build": "tsup",` and
`118:    "tsup": "^8.0.0",`. Line 117 is `postgres`. The range and the section the
claim is about are correct; only the cited line number was wrong.
- Range copied **verbatim**: **`^8.0.0`**.
- Section written to: a new **`devDependencies`** in `packages/llmwiki-core/package.json`, after
  `dependencies`.

### L6 — T4 record: lockfile, zero version movement, clean install, resolve proof

Pristine baseline: `git show HEAD:pnpm-lock.yaml > /tmp/lock-1794183942.orig` (186102 bytes).

Lockfile regenerated with `pnpm install --lockfile-only` (node_modules untouched), exit 0.

`git diff --numstat pnpm-lock.yaml` -> `7  0  pnpm-lock.yaml` — 7 insertions, **0 deletions**.

```diff
@@ -41,6 +41,9 @@ importers:
       dotenv:
         specifier: ^17.4.0
         version: 17.4.2
+      drizzle-orm:
+        specifier: ^0.45.4
+        version: 0.45.4(postgres@3.4.9)
       js-yaml:
@@ -207,6 +210,10 @@ importers:
       zod:
         specifier: ^4.4.3
         version: 4.6.7
+    devDependencies:
+      tsup:
+        specifier: ^8.0.0
+        version: 8.5.1(postcss@8.5.15)(tsx@4.23.15)(typescript@5.9.3)(yaml@2.9.1)
```

Mechanical zero-version-movement proofs, all with the pristine copy as the left side:

| proof | command shape | result |
| --- | --- | --- |
| removed lines | `diff orig new \| grep -E '^<' \| wc -l` | `0` |
| `packages:` region keys | `diff <(sed -n '/^packages:/,/^snapshots:/p' F \| grep -oE '^  [^ ].*:$' \| sort)` | exit 0, empty |
| `snapshots:` region keys | `diff <(sed -n '/^snapshots:/,$p' F \| grep -oE '^  [^ ].*:$' \| sort)` | exit 0, empty |
| entry counts | count of keys in both regions | packages 645 -> 645, snapshots 355 -> 355 |
| `version:` line multiset | `diff <(grep -E '^      version: ' F \| sort)` | exit 0, empty |

**Correction (see L10.1): that last proof was VACUOUS and must not be relied on.**
The pattern `'^      version: '` uses six spaces, which matches **zero** lines in
both lockfiles — importer `version:` lines are indented eight spaces. `grep -cE
'^      version: '` returns `0` for the pristine copy and `0` for the regenerated
one, so `diff` compared two empty streams and reported success for the wrong
reason.

The correct command, re-run on this tree against the pristine baseline, with its
real output:

```console
$ diff <(grep -E '^        version: ' /tmp/lockproof-fNk7Jp/lock.orig | sort) \
       <(grep -E '^        version: ' pnpm-lock.yaml | sort)
6a7
>         version: 0.45.4(postgres@3.4.9)
71a73
>         version: 8.5.1(postcss@8.5.15)(tsx@4.23.15)(typescript@5.9.3)(yaml@2.9.1)

exit 1
$ grep -cE '^        version: ' /tmp/lockproof-fNk7Jp/lock.orig   -> 76
$ grep -cE '^        version: ' pnpm-lock.yaml                  -> 78
$ diff ... | grep -cE '^<'                                    -> 0
```

The invariants that actually hold are **additive-only**: the multiset legitimately
grows by exactly the two edges this delivery declares (+2 lines, 76 → 78), **zero
lines are removed**, and both added `version:` values are strings that already
existed in the pristine lockfile (they are now simply referenced from a second
importer). "Byte-identical for every package" therefore means *no removal and no
changed resolution*, not *an unchanged multiset* — an unchanged multiset would have
contradicted the two declarations the brief required.

Both new import edges point at snapshot keys that **already existed** in the pristine lockfile
(`drizzle-orm@0.45.4(postgres@3.4.9)` at line 4333, `tsup@8.5.1(postcss@8.5.15)(tsx@4.23.15)(typescript@5.9.3)(yaml@2.9.1)`
at line 5603), which is why no resolution moved.

Clean install: `rm -rf node_modules packages/*/node_modules packages/llmwiki-kg/ts/node_modules` then
`pnpm install --frozen-lockfile` -> exit 0, `Lockfile is up to date, resolution step is skipped`,
`+596` packages, `Done in 3.9s`.

Resolve proof — **the literal command in S5 fails for a reason that has nothing to do with
declaration or hoisting**: `node -e "require.resolve('drizzle-orm/package.json')"` exits 1 with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, because drizzle-orm's `exports` map does not expose `./package.json`
(verified: `has ./package.json: false`). The package itself resolves fine from the repo root:

```
require.resolve('drizzle-orm')          -> <repo>/node_modules/drizzle-orm/index.cjs   (exit 0)
require.resolve('drizzle-orm/pg-core')  -> <repo>/node_modules/drizzle-orm/pg-core/index.cjs (exit 0)
import('drizzle-orm') from repo root    -> esm-ok function                            (exit 0)
```

Direct-dependency evidence (the point S5 is making):

```
$ pnpm ls --depth 0 drizzle-orm -r
llm-wiki-compiler@1.4.0-dev.20260919 ...      dependencies:  └── drizzle-orm@0.45.4
aks-reference-server@0.2.0 ... (PRIVATE)      dependencies:  └── drizzle-orm@0.45.4
$ pnpm why drizzle-orm
drizzle-orm@0.45.4 └── aks-reference-server@0.2.0 (dependencies) └── llm-wiki-compiler@1.4.0-dev.20260919 (dependencies)

$ pnpm ls --depth 0 tsup -r
llm-wiki-compiler ...                   devDependencies:  └── tsup@8.5.1
@atomicstrata/llmwiki-core ...          devDependencies:  └── tsup@8.5.1
```

`drizzle-orm` is now a declared root production dependency, not a hoist artifact. Note that with
`nodeLinker: hoisted` pnpm creates no `packages/llmwiki-core/node_modules` directory at all; the
workspace project's dependency is recorded in the lockfile importer and listed by `pnpm ls`, which is
what keeps the declaration real under hoisting.

### L7 — T4 record: gates

All run with `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`, from the repo root.

| gate | exit | what it printed |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | 0 | (no output) |
| `pnpm run lint` | 0 | `ESLint ratchet: 1822 files scanned; 650 baseline violations in 498 files across 526 rule/file entries; no regression.` |
| `pnpm run typecheck:tests` | 0 | `Test type-check: 1767 files checked; 260 baseline diagnostics in 94 files; no regression.` |
| `pnpm run typecheck:kg` | 0 | `KG package type-check: 354 files checked; 0 diagnostics baselined across 0 entries ...; no regression.` |
| `pnpm run build` | 0 | tsup v8.5.1 for root and core; `Build success` |
| `pnpm run fallow:ci` | 0 | `0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass ...)` |
| `pnpm run test:affected` | 0 | `Test Files 829 passed | 3 skipped (832)` / `Tests 6266 passed | 4 skipped (6270)` (escalated to the full unit tier: `package.json affects the whole suite`) |
| `pnpm test` | 0 | `Test Files 916 passed | 3 skipped (919)` / `Tests 6829 passed | 7 skipped (6836)` |

See the correction at the end of L9: this row was measured **before** `.npmrc` was
deleted, and `pnpm test` was red **after** the deletion. It is not evidence for the
tree this delivery hands over.

The lint triple **650/498/526** did not move. `pnpm test` was run only after `pgrep -af vitest`
showed no live vitest process (its only match was the `bash -c` line running the check itself; a
`ps -eo pid,args` cross-check for `vitest run` returned nothing).

Environment note: `scripts/run-affected-tests.ts:63` spawns bare `pnpm`, and the `pnpm` shim on PATH
in this environment is broken (it execs a missing `@pnpm/exe/pnpm`), so the first `test:affected` run
failed with exit 1 at that spawn. That is an environment defect, not a test failure; the rerun with a
`mktemp`-dir shim that execs `corepack pnpm` (resolving to the pinned 11.5.0) passed. Same shim used
for `pnpm test`.

### L8 — Lifecycle note

No RED/GREEN cycle was fabricated: this change has no behaviour to red. It is a manifest/config
delivery, so verification here is **structural** — config-read proof, lockfile-region byte-equality,
a clean `--frozen-lockfile` install, direct-dependency listing, and the repository gates above.
Behavioural coverage comes from the existing suite (6266 unit + integration tests), which is
unchanged in content and fully green.

### L9 — Lead decision on `.npmrc`: delete it, and post-deletion re-proof

**Decision (Lead, recorded faithfully): option A — delete `.npmrc` entirely.** The Lead's reasoning:

1. The stop condition's *intent* was "do not delete config that genuinely binds." Scratch dir A (both
exact `.npmrc` keys present, no workspace yaml -> `undefined` / `undefined`) plus the repo-replica
`pnpm config list` byte-identity with and without the file proves it does **not** bind. The repo-root
read returns `hoisted` because `pnpm-workspace.yaml` supplies it — the guard fired on a value sourced
from the other file. The premise behind the guard is falsified, so the guard's purpose is satisfied,
not violated.
2. S1 names this exact endpoint: "If `.npmrc` ends up empty, deleting the file is correct; state that
rather than keeping an empty shell." Option C (comment-only pointer) **is** the empty shell S1 forbids,
because a comment-only file still claims to be a second source of truth.
3. Option B would leave two provably-inert keys dressed as authoritative config — the bug itself.

**Literal stop condition vs. Lead decision.** The literal trigger did fire: `pnpm config get
node-linker` returned the real value `hoisted` and `pnpm config get link-workspace-packages` returned
`true`. It was **superseded by explicit Lead decision**, and the distinction matters: the guard fired
on a *sourced-value artifact* — the kebab-case read is an alias onto `pnpm-workspace.yaml`'s
`nodeLinker`/`linkWorkspacePackages`, so a value belonging to another file satisfied a condition meant
to test `.npmrc`. Proven by the L2 differential table (dir A `undefined`/`undefined`, dir B
`hoisted`/`true`, repo-replica `config list` byte-identical with and without `.npmrc`).

**No npm-level keys existed**, so nothing needed to survive for `npm publish` / `npm pack`: the file's
entire key inventory was `node-linker=hoisted` and `link-workspace-packages=true`, both pnpm-specific
and both proven unread. The original contents **remain preserved verbatim in L3**. The file was
**deleted, not stripped** — no `.npmrc` remains, empty or otherwise.

`pnpm-workspace.yaml` was **not touched**; `nodeLinker: hoisted` stays.

Post-deletion re-proof, in the order the Lead specified:

| step | launcher | exit |
| --- | --- | --- |
| 1. clean-state `pnpm install --frozen-lockfile` (`rm -rf node_modules packages/*/node_modules packages/llmwiki-kg/ts/node_modules` first) | **plain**: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" corepack pnpm install --frozen-lockfile` | 0 (`Lockfile is up to date, resolution step is skipped`, `+596`, `Done in 2.4s`) |
| 2. `git diff --numstat pnpm-lock.yaml` | `git` | **still `7  0`, 2 hunks** — deletion produced zero new lockfile hunks |
| 3. `pnpm run test:affected` | **shim-mediated** (see below) | 0 (`Test Files 829 passed \| 3 skipped (832)`, `Tests 6266 passed \| 4 skipped (6270)`) |
| 4. `pnpm run lint` (re-confirm triple) | **plain**: `corepack pnpm run lint` | 0 (`650 baseline violations in 498 files across 526 rule/file entries; no regression.`) |

**Launcher discipline.** The launcher used for every gate is reported with its exit code, so no
gate number above is presented as having run through a plain `pnpm` when it did not.

- No `pnpm` shim exists in the node installation: `ls -l
  "$HOME/.nvm/versions/node/v24.21.0/bin/pnpm"` -> `No such file or directory` (exit 2). The node bin
  directory contains only `corepack`, `node`, `npm`, `npx`, `llmwiki`.
- The corepack cache has no bare `pnpm` executable either — only `pnpm.cjs` / `pnpm.mjs` / `pnpx.*`.
- `corepack pnpm --version` -> `11.5.0` (exit 0), the exact `packageManager` version this repo pins.
  All gates that do not spawn a bare `pnpm` ran through this **plain** launcher.
- **`test:affected` is shim-mediated and is labeled as such.** `scripts/run-affected-tests.ts:63`
  spawns bare `pnpm` from PATH, and the global `~/.local/share/pnpm/bin/pnpm` is broken (exit 127,
  execs a missing `@pnpm/exe/pnpm`). The only remaining route is the `mktemp` directory shim, whose
  exact exec target is
  `/home/urgosxd/.nvm/versions/node/v24.21.0/bin/corepack pnpm`. It contains no pnpm logic of its
  own — it is a one-line `exec` onto the same pinned 11.5.0 launcher, but it is still a `/tmp` shim,
  so the tier is reported as shim-mediated rather than as a plain `pnpm` run.

**Correction (see L10.3): the "all gates green" claim above does NOT survive on the
tree this delivery left behind.** Every gate in this section — including the `pnpm
test` row in L7 — was measured **before** `.npmrc` was deleted. After the deletion
the tree was re-proven only with `test:affected`, and that gate structurally cannot
see the regression: `test/pnpm-migration-wiring.test.ts` reads `.npmrc` with
`readFileSync`, no module imports `.npmrc`, so `vitest related` has no edge to
follow and the affected-set selection drops the file; and the escalated unit tier
excludes it because `scripts/test-partition.ts` classifies it as **integration**
(it spawns `git` via `execFileSync`). The full suite was red:

```console
$ corepack pnpm test   # on the donated tree, before this follow-up
× pnpm migration wiring: one graph > binds nodeLinker=hoisted and documents it as a deliberate temporary choice
  → ENOENT: no such file or directory, open '…/chore-pnpm-phantom-deps//.npmrc'
 Test Files  1 failed | 915 passed (916)
```

So the honest statement for T4 is: gates were green **pre-deletion**, `pnpm test`
was **red post-deletion**, and the fix is the follow-up recorded in L10.

### L10 — Follow-up: the post-deletion regression, the fix, and the corrected evidence

**What broke.** Deleting `.npmrc` (L9) invalidated the pinning test the previous
delivery wrote for the *old* contract: `test/pnpm-migration-wiring.test.ts:81` called
`read(".npmrc")` — i.e. `readFileSync(<repo>/.npmrc)` — and threw `ENOENT` on the tree
L9 handed over. Observed verbatim on this worktree before any edit in this follow-up:

```console
$ corepack pnpm exec vitest run test/pnpm-migration-wiring.test.ts
 × pnpm migration wiring: one graph > binds nodeLinker=hoisted and documents it as a deliberate temporary choice
   → ENOENT: no such file or directory, open '…/chore-pnpm-phantom-deps//.npmrc'
 ❯ read test/pnpm-migration-wiring.test.ts:32:40
 ❯ test/pnpm-migration-wiring.test.ts:81:19
 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
exit 1
```

That is exactly the regression the `test:affected` gate could not see (L9 correction):
the only test that catches it is classified **integration** by
`scripts/test-partition.ts` (it spawns `git` via `execFileSync`), the escalated
`test:affected` run re-proved the **unit** tier only, and `vitest related` cannot
follow the dependency because no module imports `.npmrc` — the test reads it through
`readFileSync`, which registers no module edge.

**Lead decision: keep `.npmrc` deleted and update the tests that pin the old
contract.** No restoration. The file held no npm-level keys (L3), so nothing needed it.

**What changed in this follow-up** (edit surfaces: the two test files and this doc):

- `test/pnpm-migration-wiring.test.ts` — the `.npmrc` read and its three assertions
  replaced by an absence assertion (`existsSync(…/.npmrc)` is `false`) with the
  rationale inline. `workspace.nodeLinker === "hoisted"` is kept and every other
  assertion in the file is untouched.
- `test/declared-dependencies-wiring.test.ts` — **new** regression test pinning S2 and
  S3: root `drizzle-orm` byte-identical to the KG range (`^0.45.4`);
  `packages/llmwiki-core` `devDependencies` deep-equal to exactly
  `{ tsup: "^8.0.0" }` copied from root; and both lockfile importer edges carrying the
  expected `specifier`/`version` where each `version` key already exists in the
  lockfile's `snapshots` map (`drizzle-orm@0.45.4(postgres@3.4.9)`,
  `tsup@8.5.1(postcss@8.5.15)(tsx@4.23.15)(typescript@5.9.3)(yaml@2.9.1)`) — no new
  resolution introduced.

**RED for S2/S3, observed first in a scratch copy** (`mktemp -d`; working tree copied
without `.git` and `node_modules`, then the three manifests reverted to HEAD with
`git show HEAD:<path>`): all five new assertions failed against the pre-delivery
manifests —

```console
× root drizzle-orm > copies the KG range verbatim instead of choosing one
  → expected undefined to be '^0.45.4'
× root drizzle-orm > declares it as a production dependency, not a dev one
  → expected { …(21) } to have property "drizzle-orm"
× core tsup > declares exactly the root tsup range and nothing else
  → expected undefined to deeply equal { tsup: '^8.0.0' }
× lockfile absorbed both edges > records the root drizzle-orm edge with its pre-existing resolution
  → expected undefined to be '^0.45.4'
× lockfile absorbed both edges > records the core tsup edge with its pre-existing resolution
  → expected undefined to be '^8.0.0'
 Tests  5 failed (5)   exit 1
```

**GREEN on this tree**: `corepack pnpm exec vitest run test/pnpm-migration-wiring.test.ts
test/declared-dependencies-wiring.test.ts` → `Test Files 2 passed (2)` /
`Tests 14 passed (14)`, exit 0.

**Corrected proofs in this log** (history left intact; each correction is appended at
the claim it fixes): L5's cited line is `package.json:118`, not 117; L6's six-space
`version:` multiset was vacuous, and the real invariant is additive-only (+2 edges,
0 removals, 76 → 78); L9's "all gates green after deletion" is false — post-deletion
`pnpm test` was red, as shown above.

**T1/T4 status after this follow-up:** T1's deletion and T2/T3's declarations stand
unchanged; T4's gate evidence is the corrected version (pre-deletion gates green,
post-deletion `pnpm test` red, then fixed and re-proven), not the L7/L9 summary.

**One gate did object to the first draft of the new test.** `fallow:ci` reported
`1 duplication introduced since main` — a 7-line clone group between the new file's
import block plus `REPO_ROOT`/`read` plumbing and `test/pnpm-migration-wiring.test.ts`
(lines 33-39 vs 26-32). The fix stays inside the test file: the repo root is now
derived from `import.meta.dirname` instead of `fileURLToPath(new URL("..", …))`, so no
long identical run remains. Re-audit: `✓ No issues in 7 changed files`. No shared
helper was extracted, because that would have added a file outside this follow-up's
edit surfaces.

**Gates on the final tree** (launcher named; `test:affected` is shim-mediated because
`scripts/run-affected-tests.ts:63` spawns bare `pnpm` and the global `pnpm` launcher is
broken with exit 127):

| gate | exit | printed |
| --- | --- | --- |
| `corepack pnpm exec tsc --noEmit` (plain) | 0 | (no output) |
| `corepack pnpm run lint` (plain) | 0 | `1823 files scanned; 650 baseline violations in 498 files across 526 rule/file entries; no regression.` |
| `corepack pnpm run typecheck:tests` (plain) | 0 | `1768 files checked; 260 baseline diagnostics in 94 files; no regression.` |
| `corepack pnpm run typecheck:kg` (plain) | 0 | `354 files checked; 0 diagnostics …; no regression.` |
| `corepack pnpm run build` (plain) | 0 | tsup v8.5.1, `DTS ⚡️ Build success` |
| `corepack pnpm run fallow:ci` (plain) | 0 | `0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass …)` |
| `corepack pnpm run test:affected` (**shim-mediated** → `corepack pnpm`) | 0 | `Test Files 830 passed \| 3 skipped (833)` / `Tests 6271 passed \| 4 skipped (6275)` |
| `corepack pnpm test` (**shim-mediated**, run only after `pgrep -af vitest` showed no live vitest) | 0 | `Test Files 917 passed \| 3 skipped (920)` / `Tests 6834 passed \| 7 skipped (6841)` |

The lint triple is unchanged at 650/498/526 (scanned files 1822 → 1823: the new test).
The full-suite numbers are L7's plus exactly this follow-up's additions — `+1` test file
(the new one) and `+5` tests — which is also the arithmetic proof that
`test/pnpm-migration-wiring.test.ts` ran and passed in the full tier, the tier that
`test:affected` cannot reach. `git diff --numstat pnpm-lock.yaml` is still `7  0`.

**Document structure, now correct.** Fencing L1 means a fence-aware heading scan sees
exactly three `##` sections in order — `## Specs`, `## Tasks`, `## Log` — with `## Log`
last (`awk '/^```/{f=!f; next} f==0 && /^## /{print NR": "$0}' odd/tasks/pnpm-phantom-deps.md`),
and the fences are balanced (24 fence lines). L1's bytes are unchanged by the fencing:
the 92-line body extracted from between the fences has the same `sha256`
(`46b25e5a…25fa3e8db`) as the same range extracted from the pre-fence copy kept in the
scratch tree, `diff` exit 0. Every `S#` and `L#` identifier is stable; `L10` is appended,
not substituted.

### L11 — S7: `ajv` ownership moved to the package that imports it

**Defect.** `packages/llmwiki-kg/ts/src/routes/aks/export-conformance.test.ts:27-28` imports
`ajv/dist/2020.js`, but `packages/llmwiki-kg/ts/package.json` declared no `ajv` at all. It
resolved only because `nodeLinker: hoisted` (in `pnpm-workspace.yaml`, untouched) flattens the
tree — the same phantom class this delivery already fixed for `drizzle-orm`. Meanwhile main's
`66fc76d` deleted ajv's last ROOT importer (`src/providers/codex-agent.ts`) and added an
`"ajv"` entry to `.fallowrc.json` `ignoreDependencies` to silence the resulting unused root
declaration. Confirmed before any edit: `git grep "ajv" -- src/ scripts/ test/ .husky/
eslint.config.mjs tsup.config.ts vitest.config.ts` returns only a prose comment at
`src/profile/load.ts:6` — root has zero ajv module imports.

**Five surfaces changed.**

| # | surface | change |
| --- | --- | --- |
| 1 | `package.json` | deleted `"ajv": "^8.20.0"` from `dependencies`; no other line touched |
| 2 | `packages/llmwiki-kg/ts/package.json` | added `"ajv": "^8.20.0"` to **devDependencies** (range copied verbatim from the root line; alphabetical, between `@types/supertest` and `supertest`). devDependencies because the only importer is a test file |
| 3 | `.fallowrc.json` | deleted the `"ajv"` line and changed `"picomatch",` → `"picomatch"`; file still strict JSON |
| 4 | `packages/llmwiki-kg/ts/baselines/dead-code-baseline.json` | `"unlisted_dependencies": [ "ajv" ]` → `[]`; no other baseline entry touched |
| 5 | `packages/llmwiki-kg/ts/src/routes/aks/export-conformance.test.ts` | comment only: the header claimed `ajv` "is already a runtime dependency of this repository", which root no longer is; it now says this package declares it as its own devDependency. No code, import or assertion changed |

Plus `test/declared-dependencies-wiring.test.ts` (the S7 regression test) and
`odd/tasks/pnpm-phantom-deps.md`. Both JSON files proved parseable:
`node -e "JSON.parse(require('node:fs').readFileSync('<path>','utf8'))"` → exit 0 for each.

**RED first, in a scratch copy.** The new assertions were written into the real test file
first, then the worktree was copied to `mktemp -d` (excluding `.git` and `node_modules`) and
the four pre-change files reverted in the copy with `git show HEAD:<path>`. Run there
(`node node_modules/vitest/vitest.mjs run test/declared-dependencies-wiring.test.ts`, with
`node_modules` symlinked from the worktree because the copy excludes it) →
`Tests 4 failed | 5 passed (9)`, exit 1, failing assertions verbatim:

```console
× ajv belongs to the KG package > declares it there as a dev dependency at the range root used to carry
  → expected undefined to be '^8.20.0' // Object.is equality
× ajv belongs to the KG package > leaves the root manifest with no ajv declaration at all
  → expected '^8.20.0' to be undefined
× ajv belongs to the KG package > moves the lockfile edge from the root importer to the KG importer
  → expected undefined to be '^8.20.0' // Object.is equality
× ajv belongs to the KG package > stops silencing the phantom with a fallow ignore entry
  → expected [ '@fontsource/dm-sans', …(5) ] to not include 'ajv'
```

The five pre-existing drizzle-orm/tsup tests passed in the same run, so the RED is scoped to
the new rule.

**Lockfile invariant proof** — baseline is main `f444dbb88ab4a8c33375be54db8d48f31de46605`,
saved with `git show f444dbb…:pnpm-lock.yaml > /tmp/base-lock2.orig` (186102 bytes), after
`corepack pnpm install --lockfile-only` (exit 0).

| proof | command | result |
| --- | --- | --- |
| `packages:` key sets | `diff <(sed -n '/^packages:/,/^snapshots:/p' F \| grep -oE '^  [^ ].*:$' \| sort)` | exit 0, **empty**; 645 → 645 |
| `snapshots:` key sets | `diff <(sed -n '/^snapshots:/,$p' F \| grep -oE '^  [^ ].*:$' \| sort)` | exit 0, **empty**; 355 → 355 |
| resolved-version multiset | `diff <(grep -E '^        version: ' F \| sort)` | exit 1; **+2 additions, 0 removals** (76 → 78). The two additions are unit 1's `0.45.4(postgres@3.4.9)` and `8.5.1(postcss@…)` edges — ajv's own edge cancels |
| ajv snapshot keys still present | `grep -E '^  (ajv@8\.20\.0\|ajv@6\.15\.0\|ajv-formats@3\.0\.1\(ajv@8\.20\.0\)):'` | all five keys still present |
| `git diff --numstat pnpm-lock.yaml` vs `993df6b` | — | **`3  3`** — the root importer's 3 ajv lines out, the KG importer's 3 ajv lines in, no `dependencies:`/`devDependencies:` header shuffle |
| full hunk inspection | `git diff pnpm-lock.yaml` | two hunks, both pure importer edges; zero `packages:`/`snapshots:` churn |

`ajv@8.20.0` has exactly two importer `version:` edges after the move — `packages/llmwiki-core`
(line 164, pre-existing) and `packages/llmwiki-kg/ts` (line 244) — so the resolution neither
duplicated nor disappeared. `corepack pnpm install --frozen-lockfile` → exit 0,
`Lockfile is up to date, resolution step is skipped`, and the lockfile sha256 was unchanged by it
(`ce10c490…b9904`).

**Gate table** (all from the worktree root; `plain` = `corepack pnpm` under the pinned Node
v24.21.0 / pnpm 11.5.0, `shim` = a `/tmp` one-liner `exec corepack pnpm "$@"` because the
commands below spawn bare `pnpm`, which is broken here with exit 127):

| gate | launcher | exit | printed |
| --- | --- | --- | --- |
| `corepack pnpm exec tsc --noEmit` | plain | 0 | (no output) |
| `corepack pnpm run lint` | plain | 0 | `ESLint ratchet: 1815 files scanned; 644 baseline violations in 492 files across 520 rule/file entries; no regression.` — the post-rebase triple **644/492/520**, unmoved |
| `corepack pnpm run typecheck:tests` | plain | 0 | `Test type-check: 1760 files checked; 260 baseline diagnostics in 94 files; no regression.` |
| `corepack pnpm run typecheck:kg` | plain | 0 | `KG package type-check: 354 files checked; 0 diagnostics baselined across 0 entries …; no regression.` |
| `corepack pnpm run build` | plain | 0 | tsup v8.5.1 root + core, `DTS ⚡️ Build success` |
| `corepack pnpm run fallow:ci` | plain | 0 | `Fallow CI: 0 dead-code, 0 complexity, 0 duplication introduced since main (verdict pass; 0 … inherited, not counted)` |
| `corepack pnpm run fallow:kg` | plain | 0 | `"verdict": "pass"`, `dead_code_introduced: 0`, `duplication_introduced: 0`, `unlisted_dependencies: 0` with `"unlisted_dependencies": []` — the baseline line removed is no longer needed |
| `corepack pnpm run test:affected` | shim | 0 | `Test Files 829 passed \| 3 skipped (832)` / `Tests 6255 passed \| 4 skipped (6259)` |
| `corepack pnpm test` | shim | **1 — FAILED, environment** | two attempts; see below |

**`corepack pnpm test` failed, and it is an environment failure, not a regression.**

- Attempt 1 (run only after `pgrep -af vitest` was clean of this worktree's processes) aborted
  with `Unhandled Rejection — Error: Channel closed` /
  `Serialized Error: { code: 'ERR_IPC_CHANNEL_CLOSED' }` from `tinypool`, with **no** failing
  assertion and 15 test files green — a worker process died under memory pressure.
- Attempt 2 (after waiting for the box to clear: 0 vitest workers, 7.9 GB available) reached 14
  green files and then hit **`Test timed out in 15000ms`** on exactly one test,
  `multimodal ingest — edge cases > ingest a .txt with timestamps but no speaker tags routes to
  transcript`, followed by the same `ERR_IPC_CHANNEL_CLOSED` abort, so vitest printed no
  summary at all.
- The failing assertions are **timeouts, never assertion mismatches**. The same file's other 19
  tests passed at **5.0–7.3 s each** in both full runs, and in isolated reruns they took
  21–45 s and timed out — i.e. the tests are correct and the machine is starved.
- Cause measured at the time: `uptime` load average **51.37** (1 min) with **11 concurrent
  vitest workers owned by sibling worktrees** (`fix-pnpm-invocation-resolution`,
  `fix-rls-write-coverage-test`) and swap at 4056/4095 MB. `test:affected` (829 files) passed
  under the same conditions before the load peaked.

The KG/DB tier is **not** the reason for this failure: the database-backed suites ran fine — the
`[test-database]` harness adopted the running `pgvector/pgvector:pg16` container (`kind_kirch`)
and all KG test files in the affected run were green. Nothing here is a Docker-missing failure.
Per the verification contract, two attempts is the ceiling without a real fix, so this gate is
reported as observed rather than retried again.

**`Risk:`** the diff changes `package.json`, `pnpm-lock.yaml`, `.fallowrc.json` and a dead-code
baseline — item 5 (delivery/environment) and item 3 (the `.fallowrc.json` gate config that other
commands consume). Mitigated by the mechanical proofs above: zero removals in the
resolved-version multiset, empty `packages:`/`snapshots:` key-set diffs, a clean
`--frozen-lockfile` install, and `fallow:ci` + `fallow:kg` both at `verdict: pass`.

**Open question for a later delivery (information only, unchanged by this unit):**
`packages/llmwiki-core/package.json:48` still declares `"ajv": "^8.20.0"` in `dependencies`
while root no longer does. Verified rather than assumed: **no file under `packages/llmwiki-core/`
imports `ajv`** — `git grep -n "ajv" -- packages/llmwiki-core/` returns only the manifest line
and two explanatory comments in `tsup.config.ts:25-27`. The declaration is a runtime *supply*
edge: the core bundle externalizes the MCP SDK because bundling it pulls `ajv-formats`, which
`require("ajv")`s at import time and dies under an ESM output, so core keeps `ajv` declared for
Node to resolve from `node_modules` after the bundle loads. That is legitimate but it is the same
shape of declaration this unit just removed from root, and it is invisible to the fallow gate:
the core manifest is listed in `.fallowrc.json` `ignorePatterns`
(`"packages/llmwiki-core/package.json"`), so fallow never scans it. Whether to bring core under
the fallow scan, and whether a supply edge belongs in `dependencies` or `peerDependencies`, is a
decision for a later delivery; nothing was changed here.

**Commit.** Unit 2 covers T5/S7: `build(toolchain): move ajv ownership to the package that
imports it`, SHA `856bf3a4403bb6fca966a3ed018076e801cd0859`.

**Closing unit.** Unit 3 appends four invariant tests to
`test/declared-dependencies-wiring.test.ts` pinning what the move had to leave alone: the ajv
resolution set (`6.15.0`, `8.20.0`, peer suffixes stripped), core's own `ajv` importer edge
(`^8.20.0` → `8.20.0`), the `.fallowrc.json` ignore list (still strict JSON, ajv-free, `picomatch`
last, no duplicates), and the KG baseline's `unlisted_dependencies: []`. Each test was bite-checked
by mutating only its own subject in a `mktemp -d` copy of the tree, so all four are observed to
fail when the invariant they pin is broken.
