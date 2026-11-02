# Remove the profile substrate

## Goal

A wiki has exactly two page namespaces, `concepts` and `queries`, fixed at
build time. There is no `ProfilePack`, no `profile.json`, no declared entity
map, and no project configuration beyond the Stack identifier that names the
database. Everything a project used to configure declaratively is either a
constant or a column.

## What the user decided

- `concepts` and `queries` are the only categories. "no se planea otra cosa."
- "las entities se podrian reducir a lo que te menciono y que no afecten con
  .llmwiki y profile.json ya que toda la config vive en la db ademas no
  necesitara config salvo en stackid."
- `retrieval` (`includeInSearch` / `includeInContext`) is gone as configuration:
  both namespaces always enter search and context. Behavior change, accepted.
- `artifacts` and `relations` are removed (confirmed twice).

## What the exploration established

Three findings drive the staging, and all three are load-bearing:

1. **`resolveActiveProduct()` is a stub.** `src/products/binding/resolve.ts:37`
   returns `{ mode: "legacy" }` unconditionally. The `product`, `conflict` and
   `unavailable` modes of `loadProfile` (`src/profile/load.ts:209-215`) are
   therefore unreachable, along with `ProductAuthorityConflictError` and
   `ActiveProductUnavailableError`. 123 LOC of authority machinery that can
   never run.

2. **The profile already lives in a row, but nothing writes it.**
   `withProfileSource` reads `readDocumentRow(db, "profile", stackId)`
   (`src/dimensions/wiki/profile-store.ts:63`). `saveProfile` is called only
   from `profile-source.ts` itself. There is no `template install` command and
   no producer, so every Stack resolves to `DEFAULT_PROFILE` today. The row path
   is therefore already the only live path — removing the file path is a
   deletion, not a migration.

3. **`ProfilePack` declares far more than anything reads.** Outside `profile/`,
   of 27 consumers the fields actually read are `.directory` (6 sites),
   `.retrieval` (3 sites), and `.contentTiers` / `.fields` / `.lifecycle`
   (1 site each). `requiredFields`, `titleField`, `export.okfType`,
   `artifactTypes`, `ArtifactTypeDef`, `LifecycleDef`, `FieldDef` have no
   surviving reader after the earlier deletion.

`artifact` is still a registered CLI command (`src/cli.ts:330`,
`llmwiki artifact write|verify`), but both subcommands `requiredOption
--type <t>` documented as a "Profile-declared artifact type". With no
`profile.json` and no producer of profile rows, no type can ever be declared, so
the command cannot succeed. It is removed with the subsystem.

## Stages

Ordered by dependency, not by size. Artifacts and relations go FIRST because
they are 19 of the 27 `ProfilePack` consumers and 10 of the 24
`loadNonDefaultProfile` consumers; removing them is what makes stage 3
tractable. Doing stage 3 first would mean keeping half the profile API alive to
feed code that is being deleted.

### Stage 1 — Remove artifacts and relations

**Deleted:** `src/artifacts/` (17 files, 1750 LOC), `src/relations/` (9 files,
1851 LOC), `src/trust/relation-write.ts`, `src/trust/relation-plan.ts`,
`src/trust/relation-apply.ts`, `src/commands/artifact.ts`,
`src/cli/artifact-commands.ts`, `src/viewer/artifact-access.ts`,
`src/viewer/api-artifacts.ts`.

**Profile validators that die with them:** `artifact-lint.ts`,
`artifact-ref-validate.ts`, `validate-artifact-members.ts`,
`validate-artifact-requirements.ts`, `validate-relation-requirements.ts`.

**Executor:** the `relation` and `artifact` kinds leave
`MutationKind` (`src/trust/planner.ts`) and `ApplyResult`
(`src/trust/apply-result.ts`). `applyRelationLocked` and `applyArtifactLocked`
leave `src/trust/executor.ts`. `src/sdk/core.ts:201` loses its artifact write.

**Compatibility rule, same as `workflow-*` and `lifecycle-transition`:** a
`relation` or `artifact` kind persisted by an earlier build must still PARSE and
fail with a `not-implemented:` refusal. It must not become a type error at the
call site and must not silently no-op.

**Tests:** the artifact and relation suites go with them.

### Stage 2 — Remove the unreachable authority path

**Deleted:** `src/products/binding/` (2 files, 123 LOC).

`loadProfile` collapses to: read the Stack's profile row; if there is none,
`DEFAULT_PROFILE`. The `profile.json` leg goes with it:
`resolveConfinedProfileDir`, `openProfileNoFollow`, `parseOrThrow`,
`PROFILE_FILE`, `MAX_PROFILE_BYTES`, and the `assertPrivateDirNotConfinementFault`
branch. `profileExistsAnywhere`'s two-backend conflict check loses its reason to
exist.

`resolveExistingConfinedPrivateDir` stays — it is shared with `readHeadAnchor`
and is not profile-specific.

**Tests:** the conflict / unavailable / binding suites go with them.

### Stage 3 — Reduce `ProfilePack` to the two fixed namespaces

`entities: Record<string, EntityTypeDef>` becomes the two constants that already
exist, `CONCEPTS_DIR` and `QUERIES_DIR`. The 12 `entities[...]` lookup sites
repoint.

`retrieval` is removed as configuration: both namespaces always enter search and
context. This CHANGES behavior for a hypothetical project that set
`includeInSearch: false` — accepted, because no project can set it any more.

`EntityTypeDef` loses `fields`, `requiredFields`, `titleField`, `lifecycle`,
`contentTiers`, `retrieval`, `export`. If nothing reads them, they are not types,
they are residue.

`loadNonDefaultProfile` returns `LoadedProfile | null` and has 14 consumers left
after stage 1. "Non-default" stops meaning anything once there is exactly one
profile, so this is the decision point: either it becomes the plain loader, or
the profiled surface it feeds is itself removed.

## Review workload

Stage 1 alone is roughly −3600 LOC of source plus its tests. It is a separate
review slice from stages 2 and 3. Do not merge the stages into one PR.

## Branch and coordination

`feat/remove-profile-system` already carries 18 commits that made five page
write surfaces row-only and removed the typed-page routing. Stages 1–3 build on
that commit, not on `main`.

`feat/orchestrator-a` carries 8 unrelated concept-identity commits and diverges
from the base at `1f5d5de`. The only file overlap is `src/compiler/index.ts` and
`src/compiler/orphan.ts`, in non-adjacent regions (identity stage vs. the
`transaction` parameter threaded through the page-write seams), so the two
branches merge without conflict. Those 8 commits are NOT brought into this work:
concept identity is a separate concern and would inflate this review.

## Verification per stage

1. `npx tsc --noEmit`
2. `npm run build`
3. `npm run test:affected`
4. `npx fallow` — zero dead code, zero duplication, zero above threshold

A stage is committed only when all four are green. Pre-existing failures on the
base are `codex-agent-environment` (1), `parity-default` (3) and
`review-integration` (1); they must not grow.
