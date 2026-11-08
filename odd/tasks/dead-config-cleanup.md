# Dead configuration cleanup

Branch `chore/dead-config-cleanup`. Removes configuration and documentation that no longer matches the repository, established by a read-only audit performed at `6eef97c4578e8cf92515d6cf8d6efdc9b94d539e`. No topology change, no package manager change, no source-file behaviour change.

## Specs

S1. Human instruction, verbatim: "todos los errores de chore de mantenimiento debemos solucionar".

S2. Delivery constraint, verbatim: "This delivery removes configuration and documentation that no longer matches reality... No topology change, no package manager change, no source-file behaviour change."

S3. `.fallowrc.json` `ignoreExports`: it carries 18 `file` entries of which only `src/utils/output.ts` exists. Keep an entry whose path exists; delete an entry whose path does not.

S4. `tsconfig.json`: remove the path-alias groups that point at the absent `src/local-workflow-host/*`; keep everything reachable.

S5. `package.json`: remove the `madge` devDependency once nothing references it. Evidence must include the lockfile delta (`-`/`+` counts) and an empty `npm ls madge` afterwards.

S6. `package-lock.json`: it must carry no `"extraneous": true` workspace entry and no entry for the deleted `packages/llmwiki-local-workflows`.

S7. `contract-cordination.json`: remove entries whose paths do not exist, keeping the JSON valid. If a dead entry names a file that was renamed rather than deleted, point the entry at the real filename instead of deleting it.

S8. `AGENTS.md:39`, verbatim: "Do not replace it with the correct number — replace it with the command that produces the count (`git ls-files '*.test.ts' | wc -l` or equivalent), because a baked count goes stale the moment someone adds a test. The same lesson applies to item 7."

S9. `scripts/test-partition.ts` header comments, verbatim: "every count in them disagrees with reality... Re-measure every one yourself and either correct it or delete it — deleting a stale oracle is better than fixing a number that will rot again. If you correct instead of delete, add the one-line command that regenerates it."

S10. Out of scope: the `.fallowrc.json` `"packages/llmwiki-kg/**"` entry (deliberate: the repo-wide gate stays KG-free and KG has its own gate), the ESLint baseline and config, `test-typecheck-baseline.json`, the `test:affected` escalation lists, and anything under `src/`, `test/`, `packages/**` except as listed above.

S11. Prohibitions: no history rewriting, no `git push`, no `--no-verify`, no `HUSKY=0`, no `npm install` (removal only), no `rm -rf` of tracked paths.

S12. Gates, run with Node 24: `npx tsc --noEmit`; `npm run lint` must stay 0 with the same frozen counts 650/498/526 — if removing dead config changes the count, report the number and re-anchor reduction-only; `npm run fallow:ci` exit 0; `npm run typecheck:tests`; `npm run test:affected`. State explicitly whether `npm ci` from the modified lockfile still succeeds.

S13. Environment, verbatim: "Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. Run `npm ci` in your worktree first; the pre-commit hook needs `node_modules` to run at all."

S14. The commit hook is `.husky/pre-commit` running `npm run fallow:ci` then `npx tsc --noEmit`; there is no lint-staged in this repository. `.husky/pre-push` runs `npm run build` then `npm run test:affected`.

Measured facts at `6eef97c` (`git`-backed audit, `result:audit-seven-defects#1`):

- `.fallowrc.json` parses as JSON; 18 `ignoreExports` entries, 17 dead, 1 live (`src/utils/output.ts`). Other keys (`entry`, `ignorePatterns`, `ignoreDependencies`, `overrides`) stay untouched.
- `tsconfig.json` dead alias groups: `:21-23` and `:27-29`. `find src -name 'local-workflow*' | wc -l` = 0 and no file imports either alias.
- `madge`: `package.json:114` is the only live reference; the lockfile carries 5 hits (root `devDependencies`, `node_modules/madge`, its `resolved`/`bin`, and `node_modules/madge/node_modules/commander`). One historical prose mention at `odd/tasks/control-gates-ci.md:115` is a past decision record and stays.
- Pre-removal baseline: `npm ls madge` resolved `madge@8.0.0` at depth 0.
- Item 4 / S6 is ALREADY SATISFIED: `git grep -n 'llmwiki-local-workflows' -- package-lock.json` exits 1 with no output, there is no `"extraneous"` key anywhere in the lock, and `packages/llmwiki-local-workflows` was deleted in `0374a5f`. No action is invented for it.
- `contract-cordination.json` has 149 lines; `:48` is `"src/limited-isolation/**"`. Also absent on disk: `CLAUDE.md` (`:11`), `eslint.config.js` (`:16`), `packages/llmwiki-local-workflows/**` (`:22`), `src/local-workflow-host/**` (`:50`).
- Real counts at `6eef97c`: `git ls-files '*.test.ts' | wc -l` = **918**; classifier tiers = **830 unit** / **88 integration**; occurrences across `*.test.ts` = `runCLI(` 239, `execFileSync` 24 (41 raw substring), `spawnSync` 9 (17 raw), `spawn` 7, `execFile` 1, `npm pack` 3 files; header `:10` "75 of the 131" measures 65 of 88; header `:28` "86 files" for `packages/llmwiki-kg` measures 140 `*.test.ts` (412 files total).

## Tasks

- [x] T1 (S3) — `.fallowrc.json`: `ignoreExports` 18 → 1 entry. 17 entries named files that do not exist; 110 deletions, 0 insertions; the survivor `src/utils/output.ts` is byte-identical. Route: worker. Commit: C1.
- [x] T2 (S4) — `tsconfig.json`: both alias groups pointing at the deleted `src/local-workflow-host/` removed; −6 lines; all 6 surviving alias targets existence-tested LIVE. Route: worker. Commit: C1.
- [x] T3 (S5, S6) — `package.json` + `package-lock.json`: `madge` and its 93-package exclusive closure removed. `package.json` is one deleted line; the lock is a provable strict deletion (0 packages added, 0 versions changed, byte-exact reconstruction); `npm ci` exit 0 twice, `npm ls --all` exit 0. S6/audit item 4 refuted: no such entry exists. Route: worker. Commit: C1.
- [x] T4 (S7) — `contract-cordination.json`: dead entries removed, `eslint.config.js` renamed to the real `eslint.config.mjs` rather than deleted. Route: worker. Commit: C1.
- [x] T5 (S8) — `AGENTS.md`: the baked suite size replaced by `git ls-files '*.test.ts' | wc -l`; the spelled-out count at `:74` removed. Route: worker. Commit: C1.
- [x] T6 (S9) — `scripts/test-partition.ts`: every header count deleted, regeneration commands kept, diff is comments-only, classifier output identical (830 unit / 88 integration / exit 2). Route: worker. Commit: C1.
- [x] T7 (S12) — six gates plus independent re-measurement of S3-S9 and the S10 scope boundaries. Route: verify. Commit: none.
- [x] T9 (S7) — `contract-cordination.json`: the remaining 12 dead `sharedPaths` entries removed, 73 → 61, dead count 0 by existence scan. Route: worker. Commit: C1.
- [x] T10 (S4, S12) — `test-typecheck-baseline.json`: configuration digest re-anchored under the Manager's scope exception; one line changes, diagnostics unchanged at 260 in 94 files. Route: worker. Commit: C1.
- [ ] T8 (S1, S12) — one work-unit commit C1 on `chore/dead-config-cleanup`. Route: worker. Commit: C1.

## Log

L1 — human, verbatim: "todos los errores de chore de mantenimiento debemos solucionar"

L2 — manager, verbatim: "AUTHORIZED MAINTENANCE CLEANUP... This delivery removes configuration and documentation that no longer matches reality, all of it measured by a read-only audit of this repository. No topology change, no package manager change, no source-file behaviour change."

L3 — audit at `6eef97c` refuted the brief's item 4 (the stale `packages/llmwiki-local-workflows` lock entry does not exist at HEAD) and corrected two counts (918 test files, not 917; 88 spawner files, not 87). Every count in S8/S9 is therefore replaced by the command that produces it, never by a new baked number.

L4 — the brief's item 3 says `madge` has one hit in the whole repository; measurement found two outside the lockfile. The second, `odd/tasks/control-gates-ci.md:115`, is a historical record of a past measurement and is deliberately left untouched.

L5 — The audit refuted the brief's item 4 and corrected two counts. There is no `packages/llmwiki-local-workflows` lock entry and no `"extraneous"` key anywhere in the lockfile, at the base commit or at the delivered tree; the task is recorded as already satisfied rather than invented. The real counts are 918 `*.test.ts` and 88 integration files, not 917 and 87. No number was baked back in: every count in `AGENTS.md` and in the `scripts/test-partition.ts` header was deleted and replaced by the command that regenerates it, so there is nothing left to rot.

L6 — Independent verification found `npm run typecheck:tests` red at the delivered tree: removing the two dead aliases moved the sha256 configuration digest pinned at `scripts/typecheck-tests.ts:122`, while the diagnostics did not move at all (260 in 94 files). A green gate and an untouched `test-typecheck-baseline.json` were therefore mutually exclusive, so the Manager authorized re-anchoring the baseline. The re-anchor is proven by the diff and not by the tool's report: one line changes, and with the `configuration` field stripped both documents are deeply equal, at the same 94 entries and 260 diagnostics. Cause chain: base commit 0 → base commit with only the delivered `tsconfig.json` 1 → delivered 0.

L7 — The Manager ratified three deviations. Extending item 5 from the one named entry to every dead `sharedPaths` entry is right because a half-cleaned file is the same defect with a smaller count; `eslint.config.js` is renamed rather than deleted because the config exists under `eslint.config.mjs`, so the intent survives; and the word "three" stays out of `AGENTS.md:74`, because a count in prose that nobody re-measures is the same rot class as "1300+ files".

L8 — Verification first judged S7 FAIL against the spec's literal wording, because 12 dead entries survived the first pass. Completed rather than waived: `sharedPaths` 73 → 61 with a dead count of 0 by existence scan. Verification also confirmed no test in the repository reads the content of `.fallowrc.json` or `contract-cordination.json`, and that `test/control-gates.test.ts` still passes against the edited `AGENTS.md` gate list (13 tests).
