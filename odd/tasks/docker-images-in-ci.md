# Both container images assembled and exercised in CI

Branch `fix/docker-images-in-ci`. Objective: make CI assemble and exercise both container images the repository ships, without publishing them.

## Specs

- **S1 — Both images are assembled in CI and never pushed.** Quote:
  > Both images assembled in CI, **not pushed anywhere** — publishing an image is the owner's decision and is out of scope.

  Decided: the script lives under `.github/scripts/` and not `scripts/`, because `.dockerignore:59` excludes `.github` from every build context, so the runtime image's `/app/scripts` stays byte-identical and no published artefact changes.

- **S2 — The build goes into the existing `build-and-test` job as steps; no job is created and nothing is renamed.** Quote:
  > **Add steps to the existing `build-and-test` job, do not create a new job.** A step inherits the job's required check name; a new job name has no branch-protection entry and its red result could be merged past. `test-typecheck`, `codebase-health` and `build-and-test (24)` must all still exist and pass. Do not rename anything.

- **S3 — Added wall time is measured, and past roughly +180 s the slice stops and proposes a separate job as the owner's action.** Quote:
  > **Measure the added wall time** and report it. If cold image build pushes the job's duration past roughly **+180 s**, **stop and propose** a separate job plus the matching branch-protection change as the owner's action — do not silently make CI slow, and do not take that decision yourself.

  Resolution for this slice: measured cold 64 s root + 58 s KG = 122 s sequential on the reference host at `5260d423963bd84911c239bfa5e57d2eec02bffe` with `--no-cache`, which is under the line, so the step stays inside `build-and-test`.

- **S4 — The KG image's partial workspace-manifest set gets a definitive verdict.** Quote:
  > The KG Dockerfile copies **2 of 4** workspace manifests (`packages/wiki/package.json`, `packages/api/package.json` absent) while its own header asserts every remaining member declares its manifest where `workspaces` names it. Whether `--frozen-lockfile` tolerates that was reported as **`unverified — not met, not unmet`** because it could not be decided read-only.

  Quote:
  > **Your CI job is that measurement.** Report definitively whether the KG image installs cleanly, and if it does, say whether it is *correct* or merely *tolerated* — a lockfile that happens to satisfy a partial manifest set today is one member away from the `packages/foundation/package.json` defect that already cost this project a broken image.

- **S5 — Root image, `host` mode, four HTTP assertions.** Quote:
  > **root image, `host` mode**: `/health` **200**; `/` **200** with the container's own `Host`; `/` **403** with a wrong `Host` (and confirm a control request with `localhost:4173` also 403, proving the value is mandatory)

- **S6 — Root image, `serve` mode, stdio MCP handshake.** Quote:
  > **root image, `serve` mode**: stdio `initialize` → `serverInfo.name: "llmwiki"`, exit **0**

- **S7 — The KG image's own health surface is read, not assumed.** Quote:
  > **KG image**: whatever its own health surface is — read its `src/config.ts` and routes; do not assume the root's endpoints.

- **S8 — An execution RED first, or an honest statement of why it could not be staged.** Quote:
  > An execution **RED first**: build before the workflow change and observe the CI job red, or state honestly why you could not stage one.

- **S9 — Recorded, not fixed: two shipped migration files that no runner applies.** Quote:
  > Root `Dockerfile:188` ships `migration_open_kg_classification.sql` and `migration_drop_ingest_outbox.sql`, neither of which appears in any `SCHEMA_FILES` entry (`scripts/apply-schemas.sh:61–93`, grep count 0) — files present in the image that no runner applies, which **suggests migration coverage that does not exist**. Whether they should be applied is a schema question; record it.

- **S10 — Recorded, not fixed: no shared base stage between the two Dockerfiles.** Quote:
  > No shared base stage exists between the two Dockerfiles, and the rationale prose is duplicated (`Dockerfile:34–44` vs KG `:17–29`). Two independent enable/install/prune sequences is a drift channel that has already fired once. Record; do not unify in this slice.

- **S11 — Scope: the workflow, at most a small script and a doc; stop above ~6 files.** Quote:
  > Report the file set before writing; **stop above ~6 files**. Expect `.github/workflows/ci.yml` plus at most a small script and a doc.

  Decided file set for this slice: `odd/tasks/docker-images-in-ci.md`, `.github/scripts/docker-images-check.sh`, `.github/workflows/ci.yml`, `odd/tasks/kg-task-parity.md` (append-only) — four files, under the cap.

- **S12 — Gates, with literal exit codes.** Quote:
  > `npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**; a decrease needs `lint:update`, an increase is forbidden) · `npm run fallow:ci` · `npm run test:affected` (literal exit; **78** is the documented full-tier decline) · `npm test` with its literal exit code and load average if you touch suite-wide state. `.github/` has suite-wide reach — if `test:affected` escalates, say so.

- **S13 — Hard prohibitions.** Quote:
  > No history rewriting, no `--amend`, no `--no-verify`, no `HUSKY=0`, no hook bypass, no `cp -a` of this worktree, **no push, no image publication**. `odd/tasks/**` append-only. Leave `/tmp` scratch in place. Do not commit an unexplained stray file.

- **S14 — The report's required contents.** Quote:
  > The file set; the workflow diff and **which check name it runs under**; the measured added wall time cold and cached; the definitive KG-manifest verdict; every runtime assertion with its observed status code or output; the staged RED or why not; both recorded findings; every gate exit literal with the lint triple and suite exit plus load; full 40-character SHAs; `git status --short`; and a `Risk:` line — **item 5** is live (delivery and environment), and item 3 if anything about the published artefact's contents changes.

## Tasks

| ID | S# | route | commit |
| --- | --- | --- | --- |
| T1 | S1, S5, S6, S7, S11 | gentle-ai-worker | pending |
| T2 | S2, S3, S11 | gentle-ai-worker | pending |
| T3 | S1-S8, S12 | gentle-ai-verify | pending |
| T4 | S4, S9, S10 | gentle-ai-worker | pending |

- T1 — `.github/scripts/docker-images-check.sh` builds both images and asserts every runtime claim in S5, S6 and S7, failing loudly rather than skipping when Docker is unavailable.
- T2 — one new step in the existing `build-and-test` job calls that script, and no job is added, renamed or removed.
- T3 — independent verification of the whole document against S1–S8 and S12.
- T4 — both recorded findings, the KG-manifest verdict and this slice's evidence are appended to `odd/tasks/kg-task-parity.md`.

## Log

### L1

The user's original request, verbatim and complete:

```
Project assignment for branch fix/docker-images-in-ci:

Make CI prove both container images exist. Today `grep -rn "docker" .github/workflows/` matches **nothing** — the repository ships two images that no workflow builds.

Repo: llm-wiki-compiler, base `main` = **`5260d423963bd84911c239bfa5e57d2eec02bffe`**. Read `AGENTS.md` and `odd/tasks/kg-task-parity.md` (the slice that found this; its gaps are yours to close or record). Node 24 ONLY: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" <cmd>`. pnpm; bare `pnpm` → 127, use `corepack pnpm`. **`corepack pnpm install --frozen-lockfile` first — this checkout may be uninstalled.**

## The two images, already measured

| | `/Dockerfile` (226 lines, 3 stages) | `packages/llmwiki-kg/Dockerfile` (123 lines, 3 stages) |
|---|---|---|
| artefact | `dist/` via tsup | `packages/llmwiki-kg/ts/dist` via `tsc -p tsconfig.build.json` |
| install | whole workspace prod closure | `--filter @repo/kg` → `@repo/kg` + `@repo/foundation` |
| manifests copied | 4 of 4 | **2 of 4** |
| entry | `entry.sh` (host / serve) | `CMD node …/ts/dist/index.js` |
| user / port | `USER node`, 4173 | root, 8000 |

## What to build

Both images assembled in CI, **not pushed anywhere** — publishing an image is the owner's decision and is out of scope.

**Add steps to the existing `build-and-test` job, do not create a new job.** A step inherits the job's required check name; a new job name has no branch-protection entry and its red result could be merged past. `test-typecheck`, `codebase-health` and `build-and-test (24)` must all still exist and pass. Do not rename anything.

**Measure the added wall time** and report it. If cold image build pushes the job's duration past roughly **+180 s**, **stop and propose** a separate job plus the matching branch-protection change as the owner's action — do not silently make CI slow, and do not take that decision yourself. Cached timings for reference: root image 995 MB / 54 s cold / 6 s cached; KG image 895 MB.

## The measurement the CI build finally answers

The KG Dockerfile copies **2 of 4** workspace manifests (`packages/wiki/package.json`, `packages/api/package.json` absent) while its own header asserts every remaining member declares its manifest where `workspaces` names it. Whether `--frozen-lockfile` tolerates that was reported as **`unverified — not met, not unmet`** because it could not be decided read-only.

**Your CI job is that measurement.** Report definitively whether the KG image installs cleanly, and if it does, say whether it is *correct* or merely *tolerated* — a lockfile that happens to satisfy a partial manifest set today is one member away from the `packages/foundation/package.json` defect that already cost this project a broken image.

## Prove the images actually run, not merely assemble

Assembling is not the claim. Inside each image, assert and report:

- **root image, `host` mode**: `/health` **200**; `/` **200** with the container's own `Host`; `/` **403** with a wrong `Host` (and confirm a control request with `localhost:4173` also 403, proving the value is mandatory);
- **root image, `serve` mode**: stdio `initialize` → `serverInfo.name: "llmwiki"`, exit **0**;
- **KG image**: whatever its own health surface is — read its `src/config.ts` and routes; do not assume the root's endpoints.

An execution **RED first**: build before the workflow change and observe the CI job red, or state honestly why you could not stage one.

## Two findings to record, not fix

- Root `Dockerfile:188` ships `migration_open_kg_classification.sql` and `migration_drop_ingest_outbox.sql`, neither of which appears in any `SCHEMA_FILES` entry (`scripts/apply-schemas.sh:61–93`, grep count 0) — files present in the image that no runner applies, which **suggests migration coverage that does not exist**. Whether they should be applied is a schema question; record it.
- No shared base stage exists between the two Dockerfiles, and the rationale prose is duplicated (`Dockerfile:34–44` vs KG `:17–29`). Two independent enable/install/prune sequences is a drift channel that has already fired once. Record; do not unify in this slice.

## Scope
Report the file set before writing; **stop above ~6 files**. Expect `.github/workflows/ci.yml` plus at most a small script and a doc.

## Gates
`npx tsc --noEmit` · `npm run typecheck:tests` · `npm run lint` (ceiling **`558 / 396 / 423`**; a decrease needs `lint:update`, an increase is forbidden) · `npm run fallow:ci` · `npm run test:affected` (literal exit; **78** is the documented full-tier decline) · `npm test` with its literal exit code and load average if you touch suite-wide state. `.github/` has suite-wide reach — if `test:affected` escalates, say so.

## Hard prohibitions
No history rewriting, no `--amend`, no `--no-verify`, no `HUSKY=0`, no hook bypass, no `cp -a` of this worktree, **no push, no image publication**. `odd/tasks/**` append-only. Leave `/tmp` scratch in place. Do not commit an unexplained stray file.

## Report
The file set; the workflow diff and **which check name it runs under**; the measured added wall time cold and cached; the definitive KG-manifest verdict; every runtime assertion with its observed status code or output; the staged RED or why not; both recorded findings; every gate exit literal with the lint triple and suite exit plus load; full 40-character SHAs; `git status --short`; and a `Risk:` line — **item 5** is live (delivery and environment), and item 3 if anything about the published artefact's contents changes.
```

### L2

**Decisions fixed before the first write, so the slice could not drift.** The file set was fixed at four files — `odd/tasks/docker-images-in-ci.md`, `.github/scripts/docker-images-check.sh`, `.github/workflows/ci.yml`, `odd/tasks/kg-task-parity.md` (append-only) — before any write; the script lives in `.github/scripts/` rather than `scripts/` because `.dockerignore:59` excludes `.github` from every build context, so the runtime image's `/app/scripts` stays byte-identical and no published artefact changes; and the measured cold build of 122 s (64 s root + 58 s KG, sequential, `--no-cache`) stays under the +180 s line, so the work stays inside `build-and-test` instead of proposing a separate job and its branch-protection change.
