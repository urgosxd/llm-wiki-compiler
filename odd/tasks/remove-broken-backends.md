# remove-broken-backends

Deleting two dead, stranded private packages (`llmwiki-dev-backend`,
`llmwiki-limited-isolation-backend`) and every reference that would break or lie
once they are gone. Branch `chore/remove-broken-backends`.

## Specs

S1. Human approval and character of the change, verbatim: "AUTHORIZED DELETION, human-approved verbatim ("borralos"). Two packages are dead code that no longer compiles; remove them and every reference that would break or lie once they are gone. This is not a refactor and not a migration — nothing imports them and nothing builds them."

S2. Package deletion, verbatim: "Delete both packages: `packages/llmwiki-dev-backend` and `packages/llmwiki-limited-isolation-backend`, via `git rm -r` so the deletion is staged and reviewable."

S3. Dockerfile, verbatim: "`Dockerfile:40-41` — the two manifest `COPY` lines. `Dockerfile:35-37` documents that a missing path fails the build, so this must be removed in the same change. Verify every remaining `COPY` source still exists."

S4. TypeScript aliases, verbatim: "`tsconfig.json:33-41` — path aliases to both packages."

S5. Vitest aliases, verbatim: "`vitest.config.ts:40-43` — resolution aliases."

S6. Fallow entries, verbatim: "`.fallowrc.json:8-9` — the two `entry` entries."

S7. Coordination contract, verbatim: "`contract-cordination.json:21-23` — `sharedPaths` entries. Keep the JSON valid."

S8. CI workflow, verbatim: "`.github/workflows/ci.yml:71-79` and `:94-95` area — the **bubblewrap install and the bwrap launch verification step**. Those exist to serve tests that `0374a5f` deleted."

S9. Publish workflow, verbatim: "`publish.yml:253-255` — a comment asserting "the limited-isolation tests refuse to skip on Linux". Those tests do not exist; the sentence is false and it is what justifies the bwrap step. Remove or repair it, and say which you chose."

S10. Whole-repo sweep, verbatim: "Search for anything the audit did not list. `git grep -n -iE 'dev-backend|limited-isolation|bwrap|bubblewrap|sandbox-exec'` across the whole repo, including `docker/`, `docker-compose*.yml`, `.dockerignore`, `.husky/`, `packages/llmwiki-kg/**` (the KG has its own nested workflow that GitHub never reads — check whether it references any of this), and `odd/tasks/*`. For each hit: removed, or kept with a stated reason."

S11. Hard prohibitions, verbatim: "No history rewriting, no `git push`, no `--no-verify`, no `HUSKY=0`, no `npm install`, no `rm -rf` outside the two target directories, and **do not touch `src/`, `test/`, `packages/llmwiki-kg/**`, `packages/llmwiki-core/**`, `.fallowrc.json`'s KG entry, or any lockfile**. If `package-lock.json` changes at all for a package that was never a member, stop and explain why."

S12. Verification, verbatim: "Run and report literal exits: `npx tsc --noEmit`, `npm run typecheck:tests`, `npm run build`, `npm run test:affected`, `npm run fallow:ci` (must be **exit 0**; the local gate now gates on introduced findings, so pre-existing debt will not fail you — if it fails, that is your change), `git grep -n -iE 'dev-backend|limited-isolation'` → the remaining hits, each justified." Also verbatim: "You cannot run Docker or GitHub Actions here; say so explicitly and instead do the static check that every remaining `COPY` source exists on disk and that every YAML file parses." Also verbatim: "the job-key check (`build-and-test (24)`, `codebase-health`, `test-typecheck` must be unchanged — branch protection is keyed on names)".

S13. Report, verbatim: "The audit claim you verified or refuted for each item; the complete reference list with what you did to each; the Dockerfile diff and the COPY-source existence check; the YAML parse result and the job-key check; every gate exit; commit SHAs; `git status --short`; and a `Risk:` line using item 1 data/irreversible, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery/environment, 6 no test would catch a regression — or `Risk: none`."

## Tasks

- T1 — this document, S1-S13. Route: worker. Commit: A (with T2).
- T2 — S2, S3, S4, S5, S6, S7. Route: worker. Commit: A.
- T3 — S8, S9, S10. Route: worker. Commit: B.
- T4 — S12 independent verification. Route: gentle-ai-verify. Commit: none.

## Log

L1 — Manager assignment, verbatim: "AUTHORIZED DELETION, human-approved verbatim ("borralos"). Two packages are dead code that no longer compiles; remove them and every reference that would break or lie once they are gone. This is not a refactor and not a migration — nothing imports them and nothing builds them." Manager-scoped work: delete `packages/llmwiki-dev-backend` and `packages/llmwiki-limited-isolation-backend`; clean `Dockerfile:40-41`, `tsconfig.json:33-41`, `vitest.config.ts:40-43`, `.fallowrc.json:8-9`, `contract-cordination.json:21-23`, the bubblewrap install and bwrap launch verification in `.github/workflows/ci.yml`, and the false "limited-isolation tests refuse to skip on Linux" comment in `publish.yml`; sweep the whole repo for unlisted references.
