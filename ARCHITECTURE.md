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
- `@atomicstrata/llmwiki-core` is the one published scoped package. Its manifest
  directory holds only `package.json`, `tsup.config.ts`, `README.md` and
  `LICENSE`: it publishes the built wiki sources as
  `@atomicstrata/llmwiki-core` and `@atomicstrata/llmwiki-core/compiler-sdk`. The
  root and `@repo/wiki` manifests pin the same exact version of it.

`@atomicstrata/llmwiki-core/compiler-sdk` is the composition entry for an
embedder that constructs the core itself: it exports `createWikiCoreAtRoot`,
`withQuiet`, and the published option types. `CreateWikiOptions.dimensionsPort`
is part of that contract, so an embedder can hand the wiki ingest path a port it
already holds.

The build compiles `packages/llmwiki-core` first and then the root `tsup` entries
(`tsup.config.ts`): the library bundle from `packages/wiki/src/index.ts`, and the
container launcher emitted as `dist/api.js` from `packages/api/src/main.ts`.
`npm run dev` watches the wiki sources and rebuilds. Installed-package smoke
checks are a separate packaging suite (`pnpm run test:pack`).

## Package analysis conventions

Compiler source lives in `packages/wiki/src`; there is no root `src/` tree. Fallow
is configured by `.fallowrc.json`, whose `ignorePatterns` excludes
`packages/llmwiki-core/package.json`, `docs/**` and generated viewer assets.
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
