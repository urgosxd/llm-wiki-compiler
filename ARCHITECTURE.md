# Compiler, integrations, and products

llmwiki is a knowledge compiler and an authoritative domain-record substrate.
An application can use it without adopting a particular product ontology or an
external workflow engine. The library surface is `createWiki()`, reached through
the MCP server or the container image; the default profile remains the base
product, not a hidden installation of AutoSci, Newsroom, or any external
orchestration platform.

## Ownership

| Layer | Responsibility | Source boundary |
| --- | --- | --- |
| Base compiler | Ingest sources, compile and query knowledge, link pages, search, lint, export, and view | `packages/wiki/src`: `compiler`, `ingest`, `sources`, `pages`, `search`, `linter`, `export`, `viewer` |
| Configurable domain capabilities | Profiles, typed records, schema policy, provenance, reviewed changes, and operator trust grants | `packages/wiki/src/profile`, `packages/wiki/src/schema`, `packages/wiki/src/trust` |
| External orchestration | Coordinate a product's overall process, human decisions, revisions, repeated occurrences, and operator workbench | An application's own coordinator, outside this repository |
| Product implementation | Domain policy, providers, editorial/scientific decisions, product-specific UI and export assembly | Product packages or modules outside compiler core |

The word `product` in a compiler service denotes a generic declarative package
contract. It does not mean that the service implements Newsroom or AutoSci.

## Integration direction and authority

Applications call the SDK. SDK facades call compiler services. Those services
enforce the active profile, path confinement, operator trust grants, and reviewed
changes.

The wiki dimension and the KG dimension must not import each other. Two ESLint
rules enforce that direction: `no-restricted-imports` for static declarations,
and the local `local/dimension-boundary` rule for the forms it cannot see
(dynamic `import()`, type-level `typeof import()`, and `vi.mock` factories), as
configured in `eslint.config.mjs`. `test/boundary-gate-visible-forms.test.ts`
runs the real repository configuration through the ESLint Node API, so what it
asserts is what `pnpm run lint` enforces rather than a copy of the patterns that
could drift from it. `@repo/foundation` carries the types both dimensions must
name without importing each other.

## Package composition

Applications, including external coordinators, use `llm-wiki-compiler` as the
supported entry point. Its library surface is `createWiki()`, declared in
`packages/wiki/src/sdk/wiki.ts` and exported from `packages/wiki/src/index.ts`.
The workspaces below are installation dependencies, but their direct exports are
internal composition contracts rather than separately supported application APIs.
Contributors work in one repository with root-level workspace installation and
ordered builds; no package publication is needed locally.

- `@repo/foundation` is the bottom layer — the types `@repo/wiki` and `@repo/kg`
  must both name without importing each other — and it depends on no workspace.
- `@repo/wiki` is the wiki dimension: the compiler, its commands, services and
  the viewer. It depends on `@repo/foundation`.
- `@repo/kg` is the KG dimension, the TypeScript port of the AKS reference
  server. It depends on `@repo/foundation`.
- `@repo/api` is the joining package, and the only package permitted to depend on
  both `@repo/wiki` and `@repo/kg`.

There is no fifth member, and no published scoped package. The workspace is those
four, all private, and `llm-wiki-compiler` — declared by the root `package.json` —
is the one published artefact this repository builds. `@atomicstrata/llmwiki-core`
is no longer part of this tree; the section "Retired surface" below records what
it published and where each name went.

`llm-wiki-compiler/compiler-sdk` is the composition entry for an embedder that
constructs the core itself: it exports `createWikiCoreAtRoot`, `withQuiet`, and
the published option types. `CreateWikiOptions.dimensionsPort` is part of that
contract, so an embedder can hand the wiki ingest path a port it already holds.

That subpath's published declaration is an ENUMERATED re-export of `./index.js` —
sixteen names, written out one by one in `dist/compiler-sdk.d.ts` — so the
`export type * from "./core-types.js"` wildcard that
`packages/wiki/src/sdk/compiler-composition.ts` carries internally cannot leak
into the published surface: the declaration is generated from
`packages/wiki/src/index.ts`, not from the composition module. Its runtime half is
a zero-state shim, `dist/compiler-sdk.js`, whose whole body is
`export { createWikiCoreAtRoot, withQuiet } from "./index.js";`. The subpath is
therefore not a second engine copy, and the `AsyncLocalStorage` that carries quiet
output is constructed once, by `dist/index.js`, with `withQuiet` reached through
the subpath being that same instance.

The build compiles the two root `tsup` entries from this repository's own sources
(`tsup.config.ts`): the library bundle from `packages/wiki/src/index.ts`, and the
container launcher emitted as `dist/api.js` from `packages/api/src/main.ts`. There
is no dependency package to build first. `npm run dev` watches the wiki sources
and rebuilds. Installed-package smoke checks are a separate packaging suite
(`pnpm run test:pack`), which packs the root tarball alone and installs it in a
clean project.

## Retired surface: `@atomicstrata/llmwiki-core`

`@atomicstrata/llmwiki-core` is no longer part of this repository. It was collapsed
into `packages/wiki` and the root `llm-wiki-compiler` package: the engine it built
as a second artefact is inlined in the root distribution, and there is one
implementation under one name. `packages/llmwiki-core/` is gone, the root
`tsup.config.ts` no longer externalizes anything named after it, and
`.github/workflows/publish.yml` publishes `PACKAGE_DIRS: "."`, which
`test/sdk/pack-distribution.ts` pins as `PACK_DISTRIBUTION = ["."]`.

**The registry entry was not touched.** Nothing in this work was pushed or
published, and the published `@atomicstrata/llmwiki-core@1.4.0-dev.20260919`
artefact remains installable on npm exactly as before. Running
`npm deprecate @atomicstrata/llmwiki-core …` pointing at `llm-wiki-compiler` is a
decision for the project owner and is explicitly out of scope for this work. The
record below is about what this repository no longer exports; do not read it as a
retirement on the registry.

**The migration, for an embedder, in one line:**
`@atomicstrata/llmwiki-core/compiler-sdk` → `llm-wiki-compiler/compiler-sdk`.

`createWiki` and the `Wiki` type are deliberately NOT part of the inventory below.
They are wiki's own facade names, exported by `llm-wiki-compiler` before the
collapse and after it; nothing about them migrated, and presenting them as
carried over would misattribute a migration burden nobody has.

### The inventory: 95 export entries, 17 carried, 78 internal-only, 0 lost

Measured from the deleted package's two entry sources and checked against the
EMITTED declarations (`dist/index.d.ts`, `dist/compiler-sdk.d.ts`) plus the
runtime `Object.keys()` of both published bundles — never read off the source
alone. Counted per export entry: 88 on the retired `.` entry (25 values, 63 types)
and 7 on `./compiler-sdk` (2 values, 5 types). Three type names —
`CreateWikiOptions`, `SdkCompileOptions` and `WikiCore` — appear on both subpaths,
which is why the 17 carried entries are 14 distinct names; the two subpath counts
add to 95, and every one of the 95 still exists somewhere in this repository.

| Class | Entries |
| --- | --- |
| Carried onto `llm-wiki-compiler` or `llm-wiki-compiler/compiler-sdk` | 17 |
| Reachable only internally, via `@repo/wiki` — published by no subpath | 78 |
| Lost from the repository entirely | 0 |

#### Carried (17)

| Name | Kind | Retired entry | Where it is now |
| --- | --- | --- | --- |
| `ProviderUnavailableError` | value | `.` | `llm-wiki-compiler` |
| `UnknownProviderError` | value | `.` | `llm-wiki-compiler` |
| `activeProfileDigest` | value | `.` | `llm-wiki-compiler` |
| `loadNonDefaultProfile` | value | `.` | `llm-wiki-compiler` |
| `readConfinedCappedBuffer` | value | `.` | `llm-wiki-compiler` |
| `ConfinedCappedRead` | type | `.` | `llm-wiki-compiler` |
| `CreateWikiOptions` | type | `.` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |
| `SdkCompileOptions` | type | `.` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |
| `SlugSafe` | type | `.` | `llm-wiki-compiler` |
| `WikiCore` | type | `.` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |
| `createWikiCoreAtRoot` | value | `./compiler-sdk` | `llm-wiki-compiler/compiler-sdk` (and `llm-wiki-compiler`) |
| `withQuiet` | value | `./compiler-sdk` | `llm-wiki-compiler/compiler-sdk` (and `llm-wiki-compiler`) |
| `CreateWikiOptions` | type | `./compiler-sdk` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |
| `DimensionsPort` | type | `./compiler-sdk` | `llm-wiki-compiler/compiler-sdk` (and `llm-wiki-compiler`) |
| `DimensionsRequest` | type | `./compiler-sdk` | `llm-wiki-compiler/compiler-sdk` (and `llm-wiki-compiler`) |
| `SdkCompileOptions` | type | `./compiler-sdk` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |
| `WikiCore` | type | `./compiler-sdk` | `llm-wiki-compiler` and `llm-wiki-compiler/compiler-sdk` |

#### Reachable only internally (78)

All 78 are reachable through `@repo/wiki/core-index`, the internal composition
subpath of a private workspace member. None is published by any subpath of
`llm-wiki-compiler`, so none has a root successor.

Values (20):

| Name | Kind |
| --- | --- |
| `createWikiCore` | value — NO root successor |
| `LockUnavailableError` | value — NO root successor |
| `atomicWrite` | value — NO root successor |
| `AtomicWriteCollisionError` | value |
| `AtomicWriteCommittedCleanupError` | value |
| `confineUnderRoot` | value |
| `resolveConfinedPrivateDir` | value |
| `releaseLock` | value |
| `confinedFetch` | value |
| `confinedFetchRequest` | value |
| `scaffoldConfinedDirectories` | value |
| `ensureConfinedDirectory` | value |
| `isTrustedWriteGranted` | value |
| `loadProfile` | value |
| `isSlugSafe` | value |
| `parseFrontmatter` | value — NO root successor |
| `slugify` | value |
| `startViewer` | value — NO root successor |
| `collectViewerPages` | value |
| `resolveBareSlug` | value |

Types (58):

| Name | Kind |
| --- | --- |
| `AnswerCitation` | type |
| `AnswerCitationReport` | type |
| `AtomicWriteNoReplaceDurableOptions` | type |
| `AtomicWriteOptions` | type |
| `CandidateKind` | type |
| `CompileResult` | type |
| `ConfinedFetchMethod` | type |
| `ConfinedFetchRequest` | type |
| `ConfinedFetchResult` | type |
| `ConfinedFetchSeams` | type |
| `ContextPack` | type |
| `EntityId` | type |
| `EntityPageRef` | type |
| `EntityPageView` | type |
| `EntityProblemView` | type |
| `EntityRef` | type |
| `EvalReport` | type |
| `ExportJsonOptions` | type |
| `FetchLimits` | type |
| `HeldReasonCode` | type |
| `IngestResult` | type |
| `IngestTextInput` | type |
| `JsonExportDocument` | type |
| `LintSummary` | type |
| `LintTierV1` | type |
| `ListPagesOptions` | type |
| `ListPagesProfileBlock` | type |
| `ListPagesResult` | type |
| `ListSourcesOptions` | type |
| `ListSourcesResult` | type |
| `LoadedProfile` | type |
| `MutationKind` | type |
| `MutationOperation` | type |
| `MutationProvenance` | type |
| `MutationTarget` | type |
| `OkfExportReport` | type |
| `OkfImportReport` | type |
| `OkfImportSkip` | type |
| `OkfImportedPage` | type |
| `Page` | type |
| `PageDirectory` | type |
| `PageRecord` | type |
| `PageRef` | type |
| `PlannedMutation` | type |
| `ProfilePack` | type |
| `QueryResult` | type |
| `RawPageRef` | type |
| `ScaffoldDirectoriesResultV1` | type |
| `SourceRecord` | type |
| `StagedArtifactRef` | type |
| `StagedChange` | type |
| `StagedRelationRef` | type |
| `StartViewerOptions` | type |
| `TieredLintReportV1` | type |
| `TrustDecision` | type |
| `WikiStatus` | type |
| `WorkflowRunRef` | type |
| `WriteStatus` | type |

#### The five names worth naming on their own

The retired `.` entry published `createWikiCore`, `startViewer`, `atomicWrite`,
`parseFrontmatter` and `LockUnavailableError` as ordinary consumer values, so
those five are the ones an embedder most plausibly imported and the ones with no
replacement import path on the published package. They are five of the 20
internal-only values above, not a separate class: every one of the 78 shares the
property, and `0 lost from the repository` is why none of them is a removal
anybody has to absorb inside this repository.

## Why the earlier two-artefact decision no longer applies

`odd/tasks/core-facade-and-packaging.md` records, at `L5` and its correction at
`L20`, the decision that produced the split. Its words:

> Bundling the engine into the root package would give the process a second
> `AsyncLocalStorage`/lock/error-class instance, and `withQuiet` would silently
> stop applying across that boundary.

It cited the composition module's own warning, still in place at
`packages/wiki/src/sdk/compiler-composition.ts`:

> Quiet output must use core's AsyncLocalStorage instance, not a bundled copy.

That decision was correct on the tree it was made on, and this change does not
reverse it: it removes one of the two sides the warning is about. A second
module-instance token can only arise when the root bundle inlines the engine while
a second artefact carrying the same engine is also installed — which is exactly
why the root `tsup` config externalized the core, and why the warning was written
down instead of assumed away. One artefact means one module instance by
construction: the quiet scope is constructed once, by the only bundle that ships,
and there is no boundary left for it to stop applying across. The trade-off the
earlier decision weighed no longer exists, so a reader holding both documents
should see an earlier decision that was right and has become inapplicable, not
somebody changing their mind.

## Package analysis conventions

Compiler source lives in `packages/wiki/src`; there is no root `src/` tree. Fallow
is configured by `.fallowrc.json`, whose `ignorePatterns` excludes `docs/**`,
`packages/llmwiki-kg/**` and the generated viewer assets.
Package entries are explicit analysis entry points. Named duplicate-export
exceptions identify forwarding aliases rather than duplicate implementations —
`packages/wiki/src/utils/output.ts` re-exports `getQuiet` for exactly that reason.
Do not remove compatibility exports to make the dead-code report green.

## Viewer extension boundary

The generic viewer consumes a bounded, verified projection. New providers use
the product-neutral `factPanel` contract, which the generic stage-fact renderer
reads in `packages/wiki/src/viewer/assets/viewer-stage-facts.js`; labels and
values remain text, with closed presentation tones. A provider contributes
facts, not markup or mutation authority.

The older `experimentState` wire field is retained for existing consumers. Its
presentation lives in
`packages/wiki/src/viewer/assets/viewer-experiment-compat.js`, which renders a
row only when the stage carries `verification: "verified"`. The generic
stage-fact renderer does not interpret hypotheses or scientific verdicts. This is
a bounded compatibility exception, not a pattern for adding product-specific
fields.

## Deciding where a new feature belongs

- Keep mechanisms that work across ontologies in the compiler: record contracts,
  evidence references, confinement, verification, and authorized mutation.
- Put process sequencing, revision strategy, and human interaction in the
  application's own coordinator rather than in the compiler.
- Put domain judgments and provider implementations in product or reusable
  external modules. The one built-in compiler profile declares no data contract
  for them, and the compiler does not import their implementation.
- Preserve existing public behavior and API names during structural cleanup.
  Removing a compatibility surface or moving its authority is a separate,
  explicitly reviewed compatibility decision.
