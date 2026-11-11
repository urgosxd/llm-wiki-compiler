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
| T1 | S1, S5, S6, S7, S11 | gentle-ai-worker | `4671bc8fb8500e7a7716266c924a31e176e2a564` |
| T2 | S2, S3, S11 | gentle-ai-worker | `4671bc8fb8500e7a7716266c924a31e176e2a564` |
| T3 | S1-S8, S12 | gentle-ai-verify | no commit; PASS (result ref `result:verify-docker-ci#1`) |
| T4 | S4, S9, S10 | gentle-ai-worker | `this commit` — its 40-character SHA is recorded in the close-out handoff, because a commit cannot contain its own SHA; L4 is the entry it appends |

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

### L3

**Independent verification: PASS on every spec it was given, and no defects.** `gentle-ai-verify`, which wrote none of the code under review, verified S1–S8 and S12 at `4671bc8fb8500e7a7716266c924a31e176e2a564` and returned PASS on each with **no defects**. The script exited **0** and printed `root image built in 3s` and `KG image built in 0s`. Every runtime assertion held: `/health` → **200**; `/` with the container's own Host → **200** (`llmwiki viewer`); `/` with `evil.example:4173` → **403**; the `localhost:4173` control → **403**, which is what proves the Host value is mandatory rather than merely checked; `/api/health` with the forged Host → **403**; `initialize -> exit 0` printing `"serverInfo":{"name":"llmwiki"`; the KG image's own `/health` → **200** containing `"service":"aks-reference-server"`. Total wall time was **8 s warm**, with the images at **995 MB** and **895 MB**.

**The committed shape was re-read from git, not from the worktree.** `git show --stat` reported exactly 3 files: the script at 290 lines mode `100755`, `ci.yml` +24, and this feature document +139. The `ci.yml` diff is one hunk of 24 added lines and 0 removed; `build-and-test` went from 15 steps to 16 with the new step at index 10 and nothing removed; the workflow's jobs are still exactly `build-and-test` and `codebase-health`; `test-typecheck` appears once in `typecheck-tests.yml`, `codebase-health` once in `ci.yml`, and `node-version: [24]` once. The container's `--host` is read out of the live process with `docker exec … cat /proc/1/cmdline`, with a `docker inspect` fallback that cannot green silently, because `/` would then 403.

**`/health` is outside the origin gate, and the document says so instead of letting a 200 imply more than it proves.** `packages/api/src/host/server.ts:400` lists `"/health"` in `GRAPH_PATH_PREFIXES` and dispatches the graph app before the viewer, while `/` is gated at `packages/wiki/src/viewer/server.ts:187-190` and `/api/health` at `packages/api/src/host/api.ts:434-441`. So `/health` 200 proves the container *listens*; the gate is proven by the other four assertions.

**RED, as far as this host can stage it.** At base `5260d423963bd84911c239bfa5e57d2eec02bffe`, `git show 5260d423963bd84911c239bfa5e57d2eec02bffe:.github/workflows/ci.yml | grep -n docker | grep -v 'image: pgvector'` printed nothing and exited **1**; at HEAD the same grep finds the new step — the gate genuinely did not exist before this commit. A mutated copy of the script with one expected status flipped 403→200 exited **1**, naming the assertion, both values and the observed body, so the smoke test can fail; the tracked script's `sha256sum` was identical before and after that mutation. A genuinely red CI run could not be observed from this host: `command -v gh` exits **1**.

**Every gate was re-run by the verifier, independently of the implementer's report.** `npx tsc --noEmit` **0**; `npm run typecheck:tests` **0** (1591 files, 238 baseline diagnostics in 86 files, no regression); `npm run lint` **0** printing `558 baseline violations in 396 files across 423 rule/file entries; no regression`, exactly at the `558 / 396 / 423` ceiling — neither increased nor decreased; `npm run fallow:ci` **0**; `npm run test:affected` **78**, with stderr `affected: scope resolves to the full unit tier; run `pnpm test` instead`, the documented full-tier decline rather than a silence. The suite verdict is the implementer's run: `npm test` exit **0**, `Test Files 823 passed | 3 skipped (826)`, `Tests 6132 passed | 4 skipped (6136)`, 324.74 s, `/proc/loadavg` `3.09 4.18 3.26` before and `6.60 5.84 4.31` after.

**Two deviations in the worker's run were judged sound, not defects.** Host mode also passes `--env LLMWIKI_PORT=${PORT}` because `docker/entry.sh:60-69` defaults the listener to 4173, so without it a non-default `PORT` would publish a socket nothing listens on — and the default path is unchanged. And `REPO_ROOT` defaults to `$(cd "$(dirname "$0")/../.." && pwd)`, which is the repository root when the workflow runs `bash .github/scripts/docker-images-check.sh`, with the override used only by probe copies.

**Three advisories were recorded and deliberately not acted on.** The cold timing is host-specific and is not a portable figure. `LLMWIKI_DOCKER_CHECK_SKIP=1` is an exit-0 escape hatch that no workflow sets, and it must never be added to a CI env, because a skip flag in CI is the false green this project keeps removing. And `/health` being Host-insensitive is by design, which is exactly why the gate is proven on `/` and `/api/health` rather than on `/health`.

### L4

**The S4 measurement finally has a verdict: the KG image installs, and it is tolerated, not correct.** The cold build log at base `5260d423963bd84911c239bfa5e57d2eec02bffe` says, verbatim:

```
#14 [build  7/11] RUN pnpm install --frozen-lockfile
#14 2.537 Scope: all 3 workspace projects
#14 10.50 Lockfile is up to date, resolution step is skipped
#14 34.43 + @repo/api 0.0.0 <- packages/api
#14 34.43 + @repo/foundation 0.1.0 <- packages/foundation
#14 34.43 + @repo/kg 0.2.0 <- packages/llmwiki-kg/ts
#14 34.43 + @repo/wiki 0.0.0 <- packages/wiki
#14 34.64 Done in 32.5s using pnpm v11.5.0
```

Set that against the root image's own `#16 2.616 Scope: all 5 workspace projects`. **`--frozen-lockfile` never validated the two absent importers, and `Lockfile is up to date, resolution step is skipped` is not a pass signal — with `--frozen-lockfile` resolution is skipped by construction, so nothing compared the missing manifests against the lockfile.** `Scope: all 3` counts the root project plus the two members whose manifests the KG build stage copies, so it confirms rather than contradicts the brief's table: the KG build stage copies the root manifest and exactly **2 of the 4** member manifests (`packages/llmwiki-kg/ts/package.json`, `packages/foundation/package.json`), while `packages/wiki/package.json` and `packages/api/package.json` are absent. The two absent members were still linked, as dangling symlinks carrying the placeholder version `0.0.0` instead of their real `0.1.0`. The Dockerfile header's claim that every remaining member declares its manifest where `workspaces` names it is therefore false for two members — and this is one deleted manifest away from the `packages/foundation/package.json` defect that already cost this project a broken image.

**The cold timing is recorded as two observations, because one observation is not a margin.** The workflow comment's original figure is a single prior observation — `--no-cache`, 16-core host, base `5260d423963bd84911c239bfa5e57d2eec02bffe`: 64 s root + 58 s KG = **122 s**. An independent re-measure at HEAD gave **73 s root + 74 s KG = 147 s**, still under the +180 s line at which this would have had to become a separate job, but with a 33 s margin rather than 58 s. The margin is host-specific; the decision held on both observations, and the workflow comment now carries both numbers rather than only the friendlier one.

**Recorded finding 1: two shipped migration files no runner applies.** `migration_open_kg_classification.sql` and `migration_drop_ingest_outbox.sql` are copied into the runtime image by the root `Dockerfile`, while no `SCHEMA_FILES` entry in `scripts/apply-schemas.sh` names either, and grepping both across `scripts/`, `src/` and `packages/` returns no match — files present in the image that no runner applies, which suggests migration coverage that does not exist. The honest nuance: `docs/guides/kg-classification-migration.mdx:91` states the classification migration is mirrored inside `packages/llmwiki-kg/db/schema.sql` (`grep -c kg_classification` there returns 7) and applied by hand, and `drop_ingest_outbox` is a one-shot manual migration — so this is a documented manual path rather than proven-missing coverage. Whether either belongs in `SCHEMA_FILES` stays a schema question for its own slice. Not fixed here.

**Recorded finding 2: no shared base stage.** The root `Dockerfile` (226 lines, 3 stages) and `packages/llmwiki-kg/Dockerfile` (123 lines, 3 stages) share no base stage; each carries its own `corepack enable` plus install plus prod-deps sequence; and the rationale prose explaining why neither prunes is duplicated between `Dockerfile:34-44` and the KG Dockerfile's `:17-29`. Two independent enable/install/prune sequences is a drift channel that has already fired once. Not unified here.

**The scope decision is recorded, not taken.** The slice stayed inside `build-and-test` because both cold measurements stayed under +180 s. If a future Dockerfile change pushes a cold run past roughly +180 s, converting this to a separate job requires a matching branch-protection change — an owner decision this slice does not take.

