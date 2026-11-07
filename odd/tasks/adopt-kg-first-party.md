# Adopt llmwiki-kg as first-party project code

Branch `chore/adopt-kg-first-party`. Docs/config delivery: prose, git remote and provenance truth only — no behaviour change in `packages/llmwiki-kg` runtime code.

## Specs

- **S1 — Ownership.** `KG debe pertenecer al proyecto, al git ya no como subtree`. `packages/llmwiki-kg` must belong to this project and to this git history, edited here as first-party code, and no longer presented as a `git subtree` vendor.
- **S2 — No history rewriting.** `NO history rewriting.` Never `git filter-branch`, `git filter-repo`, `rebase` of existing commits, `commit --amend` of history, `git replace`, or anything that alters past commits. The 141 commits of local divergence and the subtree-add commit stay exactly as they are; the graph is the record.
- **S3 — Forbidden commands.** No `git push`, no `git merge`, no `git reset --hard`, no `git clean`, no `rm -rf` of tracked paths, no `--no-verify`.
- **S4 — Attribution survives.** `Never delete packages/llmwiki-kg/LICENSE, any NOTICE, or anything under packages/llmwiki-kg/ts/oracle/aks-specification-v0.1.0/.` Apache-2.0 attribution must survive adoption. The oracle's README explicitly says `Do not edit these files` — that stays true, because the oracle is a verbatim copy of an external specification, which is a different thing from the code being first-party.
- **S5 — Out of scope.** `Do NOT touch CONTRIBUTING.md.` It is outside this scope and is handled separately by the Manager. Subtree-related content found there is reported with `path:line` and the work stops at that boundary.
- **S6 — Load-bearing config.** Do NOT change `packages/llmwiki-kg/ts/vitest.config.ts` behaviour. Its `include: ["src/**/*.test.ts"]` is load-bearing for fallow coverage analysis and is addressed in a separate delivery.
- **S7 — Vendor disconnection.** Remove the `aks` remote (`git remote remove aks`); it is local git config, reversible, and keeping it invites an accidental `subtree pull` that would resurrect the vendor model. Record its URL in prose wherever provenance is documented, so nothing is lost. Remove any subtree-specific git metadata that can be removed without touching commits; if it cannot be removed without touching history, report that and leave it.
- **S8 — Provenance prose tells the new truth.** State that this package is part of this project and is edited here as first-party code; its history came in via `git subtree` from the AKS Reference Server at its original URL, recorded as provenance only. Delete claims that it is `vendored`, that nothing in it is authored here, or that it must not be edited. Keep the Apache-2.0 attribution and the derived-from-the-Python/FastAPI-implementation fact: derivation is still true; ownership of maintenance is what changed.
- **S9 — No invented sync procedure.** Where a doc says or implies re-sync is required, replace it with the truth: there is no re-sync; upstream changes are no longer merged in. Do not invent a new sync procedure.
- **S10 — No behaviour change.** Run `npx tsc --noEmit`, `npm run typecheck:kg`, `npm run build`, and `npm run test:affected`, announcing the exact scope run and its result. Never claim the full suite was run.
- **S11 — Evidence recorded.** Commit in reviewable slices with Conventional Commit messages, e.g. `docs(kg): adopt the AKS core as first-party project code`, and record each commit SHA in this document.
- **S12 — Scope boundary on CONTRIBUTING.md from L1.** L1 asks to delete `CONTRIBUTING.md`; the Manager's assignment carves that file out of scope for this delivery (it is handled separately). This feature does not modify or delete it.

## Tasks

| Task | Description | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| [ ] T1 | Enumerate every vendor/subtree binding read-only with `path:line` (remotes, subtree metadata, provenance prose, re-sync docs, attribution inventory). | S1, S4, S7, S8, S9 | gentle-ai-verify (read-only) | none |
| [x] T2 | Remove the `aks` remote and any remove-without-history subtree git metadata; record the URL as prose. | S2, S3, S7 | gentle-ai-worker | no commit of its own: local git config only, evidenced by the delivery commit below |
| [x] T3 | Rewrite provenance prose in `packages/llmwiki-kg/README.md`, `packages/llmwiki-kg/ts/README.md`, `packages/llmwiki-kg/ts/src/core-index.ts`, `odd/tasks/kg-dimension.md`, `docs/configuration/environment-variables.mdx` and `docs/configuration/kg-type-catalog.mdx` to first-party truth, preserving attribution and stating there is no re-sync. `ts/package.json` is excluded by explicit prohibition (no rename, no `repository` field). | S4, S5, S8, S9, S12 | gentle-ai-worker | `docs(kg): adopt the AKS core as first-party project code` |
| [ ] T4 | Verify no behaviour change with the four gates. | S10 | gentle-ai-verify (independent; not the implementing agent) | none |
| [ ] T5 | Record commit SHAs as evidence and close the feature. | S11 | gentle-ai-worker | included in the slice it records |

## Log

- L1 (user, verbatim): Borra CONTRIBUTING.md KG debe pertenecer al proyecto, al git ya no como subtree
- L2 (manager, verbatim): AUTHORIZED CHANGE: adopt `packages/llmwiki-kg` as **first-party project code** — it must belong to this project and this git history, no longer as a `git subtree` vendor.
- L3 (manager, scope decision): CONTRIBUTING.md is out of scope for this delivery; it is being handled separately by the Manager. Subtree content there is reported with path:line and the work stops at that boundary.
- D1 (lead decision): Commits on this branch are authorized work-unit slices of the authorized ODD implementation; push, PR creation and merge remain the user's decisions.
- D2 (lead decision): Removal of subtree metadata must not touch any commit. If it cannot be done without touching history, it is left in place and reported.
- D3 (lead decision): The delivery is committed as two slices on this branch: `docs(odd): track the kg first-party adoption` (this document) and `docs(kg): adopt the AKS core as first-party project code` (the prose). The `aks` remote removal is local git config and produces no commit of its own.
- E1 (T2 evidence, `git remote -v` before): `aks\t/home/urgosxd/Desktop/aks/AKS-Reference-Server (fetch)`, `aks\t/home/urgosxd/Desktop/aks/AKS-Reference-Server (push)`, `origin\thttps://github.com/urgosxd/llm-wiki-compiler.git (fetch)`, `origin\thttps://github.com/urgosxd/llm-wiki-compiler.git (push)`; `git for-each-ref refs/remotes/aks | wc -l` = 5.
- E2 (T2 evidence, `git remote -v` after): only the two `origin` lines above remain; `git for-each-ref refs/remotes/aks | wc -l` = 0.
- E3 (T2 evidence, subtree metadata): no `.git-subtree*` directory, no `subtree.*` git config (`git config --get-regexp subtree` exits 1), no squash refs, no `.gitmodules`. The `git-subtree-*` trailers live inside commits `2a74a21`, `d627d3f` and `796d263` and are untouched, per D2 and S2.
- E4 (T0 inventory): the license file is `packages/llmwiki-kg/LICENSE.md` (there is no `LICENSE` and no `NOTICE`); `packages/llmwiki-kg/ts/oracle/` is untouched, so the reference specification's `Do not edit these files` still holds — it is a verbatim external spec, which is a different thing from the code being first-party.
