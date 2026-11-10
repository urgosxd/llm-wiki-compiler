# llmwiki

[![CI](https://img.shields.io/github/actions/workflow/status/atomicstrata/llm-wiki-compiler/ci.yml?branch=main&logo=github&label=CI)](https://github.com/atomicstrata/llm-wiki-compiler/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-wiki-compiler?logo=npm&label=npm)](https://www.npmjs.com/package/llm-wiki-compiler)
[![docs](https://img.shields.io/badge/docs-llmwiki.atomicstrata.ai-blue)](https://llmwiki.atomicstrata.ai)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## New in 1.3 — A fresh look for your wiki.

Meet Scientific Clay, with soft surfaces and rounded typography, and Minimal, which follows your system’s light or dark setting. Switch instantly between four themes, including Nebula Light and Dark.

<table>
  <tr><th>Scientific Clay</th><th>Minimal</th></tr>
  <tr>
    <td width="50%"><a href="docs/images/viewer-scientific-clay.png"><img src="docs/images/viewer-scientific-clay.png" alt="Knowledge compilation page in Scientific Clay, with soft lavender surfaces and rounded typography" /></a></td>
    <td width="50%"><a href="docs/images/viewer-minimal.png"><img src="docs/images/viewer-minimal.png" alt="The same populated Knowledge compilation page in Minimal, following the system light setting" /></a></td>
  </tr>
</table>

The same page in a demonstration wiki. Click either screenshot for a closer look.

Recursive source folders, path exclusions, project-specific compile instructions, and storage for larger embedding indexes.

---

## What llmwiki does

Compile raw sources into an interlinked, citation-traceable markdown wiki that agents and humans can browse, query, lint, export, and reuse. The default profile preserves the classic concepts-and-queries layout.

llmwiki implements the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: instead of re-discovering knowledge from raw files at query time, compile it once into durable pages that accumulate structure, provenance, review state, and retrieval metadata over time.

## When to use this repo

Use llmwiki when you need a persistent knowledge base from raw material:

- Compile papers, notes, READMEs, transcripts, PDFs, images, or web pages into typed wiki pages.
- Give agents a stable, citation-aware context pack instead of a pile of loose files.
- Keep generated knowledge auditable with source citations, review queues, freshness checks, and quality gates.
- Browse the result locally, query it from TypeScript, drive it from an agent over MCP, or run the whole pipeline in the container.
- Exchange compiled knowledge with other tools using Open Knowledge Format (OKF), JSON, JSON-LD, GraphML, Marp, and `llms.txt`.

Do not use llmwiki as a general static-site generator, a heavy ontology database, or a replacement for ad-hoc search over fast-changing raw logs. It is strongest when source knowledge is worth compiling, reviewing, and reusing.

## What you get

- **Compiled wiki, not chunks.** A two-phase LLM pipeline extracts concepts, then generates typed pages: `concept`, `entity`, `comparison`, and `overview`.
- **Runtime trust gates.** Every page write is path-confined, size-capped before parsing, blocked from overwriting an existing target unless the caller declares an upsert, and rejected on malformed frontmatter rather than left to prompt convention; standing lint detects drift after the fact.
- **Citation-traceable output.** Paragraphs and claims cite source files and line ranges, and the lint rules (`wiki.lint()`, MCP `lint_wiki`) validate the links.
- **Hybrid retrieval.** Semantic chunk search, BM25 reranking, and wikilink graph expansion build compact evidence packs for queries and agents.
- **Local viewer.** The launcher's `host` mode serves a read-only browser UI with search, page metadata, graph exploration, source-freshness badges, and citation chips.
- **Review policy.** Generated pages can be auto-held for review when confidence, contradiction, schema, or provenance rules trip.
- **Freshness repair.** `wiki.lint()` and `wiki.status()` surface stale and orphaned pages so a recompile can target them.
- **Eval harness.** `wiki.runEval()` reports health score, a per-page health distribution that flags the worst pages, wikilink-graph health, citation coverage/precision, corpus stats, regression deltas, and optional judge-model citation support.
- **MCP server.** The launcher's `serve` mode exposes ingest, compile, query, lint, read, status, eval, context-pack, and OKF exchange tools to MCP-compatible agents.
- **SDK.** `createWiki({ root })` drives ingest, compile, query, context, status, export, eval, and OKF import/export from TypeScript without shelling out.
- **Open Knowledge Format exchange.** Export and import OKF bundles for portable, markdown-native knowledge exchange. External OKF imports are staged through the review queue by default; trusted bundles can be written live explicitly.
- **Other portable exports.** Export JSON, JSON-LD, GraphML, Marp slides, and `llms.txt` for downstream systems.
- **Provider portable.** Anthropic, Claude Agent SDK local login, OpenAI-compatible servers, Ollama, GitHub Copilot, Atlas Cloud, OrcaRouter, and local OpenAI-compatible runtimes.

## Karpathy's LLM Wiki pattern

Andrej Karpathy described the LLM Wiki pattern as a way to turn raw material into compiled knowledge that future agents can reuse. llmwiki is a concrete compiler for that pattern.

The key shift is moving work from query time to compile time. Traditional RAG repeatedly retrieves raw chunks and asks the model to reconstruct relationships for each question. llmwiki first turns sources into typed, interlinked pages with citations, metadata, and review state. Queries, context packs, exports, and MCP tools then operate over that compiled artifact.

That makes llmwiki useful when knowledge should compound: concepts shared across sources become one page, saved answers become future context, stale pages can be detected and repaired, and agents can consume a stable evidence pack instead of re-reading the same raw files from scratch.

See [`docs/concepts/karpathy-pattern.mdx`](docs/concepts/karpathy-pattern.mdx) for the deeper explanation.

## Agent decision guide

If an agent is scanning this README, these are the high-signal entry points:

| Goal | Use |
|---|---|
| Create a wiki from one source and inspect it | `createWiki({ root })`, then `ingest({ source })` and `compile()` |
| Add more files or URLs | `wiki.ingest({ source })`, or MCP `ingest_source` |
| Ingest raw text with no network fetch | `wiki.ingestText({ title, text })` |
| Compile or recompile changed sources | `wiki.compile()`, or MCP `compile_wiki` |
| Add project-specific writing guidance | `wiki.compile({ systemPolicy })` |
| Hold generated pages for human approval | a review policy in `.llmwiki/config.json` |
| Ask grounded questions | `wiki.query("question")`, or MCP `query_wiki` |
| Save an answer back into the wiki | `wiki.query("question", { save: true })` |
| Build an evidence pack for another agent | `wiki.getContextPack({ prompt })` or MCP `get_context_pack` |
| Browse the compiled knowledge base | the container's `host` mode (viewer and graph on one listener) |
| Check broken links, citations, confidence, freshness, and quality | `wiki.lint()` and `wiki.runEval({ mode: "fast" })` |
| Drive llmwiki from an agent | the container's default mode, MCP over stdio |
| Drive llmwiki from TypeScript | `createWiki({ root })` |
| Export for another system | `wiki.exportJson()`, or MCP `export_okf` |
| Import an Open Knowledge Format bundle | `wiki.importOkf(dir, { dryRun: true })`, or MCP `import_okf` |
| Remove a bad source and its derived pages | not available — see [The `llmwiki` CLI is gone](#the-llmwiki-cli-is-gone) |

## Quick start

There is no `llmwiki` executable to install: the package is a library, and the launcher
that ships in the container is reached through Docker or a source checkout. Driving the
pipeline from TypeScript is the most direct path:

```bash
npm install llm-wiki-compiler

# or run the launcher without installing anything globally
docker build -t llmwiki .
docker run -i -v "$PWD:/work" llmwiki                        # MCP over stdio, the default mode
docker run --rm --network host -e LLMWIKI_MODE=host -e LLMWIKI_HOST=127.0.0.1 llmwiki  # viewer, graph, /api/ingest
```

```ts
import { createWiki } from "llm-wiki-compiler";

process.env.ANTHROPIC_API_KEY = "sk-..."; // or another provider

const wiki = createWiki({ root: "./my-wiki" });
await wiki.ingest({ source: "./notes.md" });
await wiki.compile();
const { answer } = await wiki.query("what are the key ideas?");
console.log(answer);
```

## Demo

Open [`examples/basic/`](examples/basic/) - it includes a small pre-generated wiki you can inspect without an API key - or point `createWiki` at any article or document and compile it yourself.

## The `llmwiki` CLI is gone

The `llmwiki` executable left the product. The package's `bin` entry is retired, so `npm install -g llm-wiki-compiler` no longer puts anything on your `PATH`; 27 top-level commands and 43 leaf invocations went with it, and 18 of those 43 had no non-CLI entry point at all, so their capability is lost rather than re-surfaced. Six of those eighteen were data-mutating capabilities that had no implementation anywhere else: `rm`, `visualize`, `lint --fix-preview`/`--fix-propose`, `ingest-session`, `eval cache clear` and `review reject`. The remaining commands were facades over modules that survive with their own tests, and are reachable through the surfaces in the table above.

The library surface is unchanged: `createWiki({ root })` is still the supported entry point, and the container still starts the `host` and `serve` modes. [CHANGELOG.md](CHANGELOG.md) records the removal as a breaking change.

## Open Knowledge Format

llmwiki is an Open Knowledge Format (OKF) producer and consumer. OKF is a Google Cloud initiative for sharing compiled knowledge as portable markdown files with structured frontmatter.

```ts
import { createWiki } from "llm-wiki-compiler";

const wiki = createWiki({ root: "./my-wiki" });
await wiki.exportOkf({ out: "./dist/okf" });
await wiki.importOkf("./dist/okf", { dryRun: true });
await wiki.importOkf("./dist/okf");
```

OKF import is intentionally review-first: untrusted bundles become review candidates, not live wiki pages. The importer preserves foreign OKF metadata, stores llmwiki provenance under `x-llmwiki`, and re-exports imported pages honestly after local edits, including safe original nested paths.

See [`docs/guides/open-knowledge-format.mdx`](docs/guides/open-knowledge-format.mdx).

## What llmwiki creates

A project has raw inputs in `sources/`, compiled markdown in `wiki/`, and compiler state under `.llmwiki/`:

```text
sources/
  raw source files
wiki/
  concepts/      compiled pages
  queries/       saved answers
  index.md       generated TOC
.llmwiki/
  config.json    review policy and source selection
  schema.json    page-kind/cross-link policy
  state.json     source hashes and ownership
  candidates/    held review candidates
  eval/          quality history and thresholds
log.md           activity journal
```

Compiled pages are plain markdown with YAML frontmatter, plus enough metadata for agents to reason about citations, freshness, confidence, contradictions, and review state. See [`docs/concepts/wiki-model.mdx`](docs/concepts/wiki-model.mdx).

Sources are top-level Markdown files by default. Nested source folders and exclusions are opt-in project config. Excluding a compiled source retires its contribution on the next ordinary compile without deleting the source file.

## Agent integration

### MCP

Run:

```bash
docker run -i -v "$PWD:/work" llmwiki
```

That is the container's default mode: stdio MCP rooted at the container's `/work`
directory, which the volume mount points at the host project. From a source checkout the
same server runs as `node dist/api.js serve --root /path/to/wiki-project`.

MCP clients can ingest sources, compile, query, search pages, read pages, lint, run eval, inspect status, request context packs, and exchange OKF bundles. Read-only tools work without provider credentials; LLM-backed tools validate provider credentials at call time. The `run_eval` tool runs its fast suite without a provider; its full suite (which LLM-judges citation support) requires one.

Every tool takes a required `stackId` naming the Stack it reads or writes: there is no default Stack and no fallback, so a call that omits the argument is refused instead of inheriting the Stack the server is bound to. `list_stacks` is the one exemption — its `stackId` stays optional and only marks which Stack is current. MCP resources are not tools and have no input schema, so the `llmwiki://` resource templates keep resolving their Stack from the server environment.

See [`docs/guides/mcp-agent-integration.mdx`](docs/guides/mcp-agent-integration.mdx).

### SDK

```ts
import { createWiki } from "llm-wiki-compiler";

const wiki = createWiki({ root: "/path/to/wiki-project" });
await wiki.ingest({ source: "./notes.md" });
await wiki.compile();
const answer = await wiki.query("What changed?");
```

See [`docs/guides/sdk.mdx`](docs/guides/sdk.mdx). `llm-wiki-compiler` is the
supported entry point; its scoped supporting packages are implementation
dependencies. See [SDK package selection](docs/guides/sdk-packages.mdx) and
[SDK upgrade notes](docs/guides/sdk-upgrade.mdx).

## Configuration

Minimum requirement: Node.js 24 or newer.

The default provider is Anthropic:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Provider selection is environment-driven:

| Provider | Typical setup |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| Claude Agent SDK | Local Claude Code login, `LLMWIKI_PROVIDER=claude-agent` |
| OpenAI-compatible | `LLMWIKI_PROVIDER=openai`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |
| Ollama | `LLMWIKI_PROVIDER=ollama`, `OLLAMA_HOST` |
| GitHub Copilot | `LLMWIKI_PROVIDER=copilot`, `GITHUB_TOKEN=$(gh auth token)` |
| Atlas Cloud | `LLMWIKI_PROVIDER=atlascloud`, `ATLASCLOUD_API_KEY` |
| OrcaRouter | `LLMWIKI_PROVIDER=orcarouter`, `ORCAROUTER_API_KEY` |

See [`docs/configuration/providers.mdx`](docs/configuration/providers.mdx) and [`docs/configuration/environment-variables.mdx`](docs/configuration/environment-variables.mdx).

## Quality and safety model

llmwiki is designed for auditable generated knowledge:

- **Review before write.** Use a `.llmwiki/config.json` review policy to hold risky pages as candidates.
- **Fail-closed config.** Invalid review-policy config aborts compile instead of silently disabling review.
- **Source confinement.** Source snippets and import/export paths are confined to the project.
- **Freshness is explicit.** Pages can be fresh, stale, orphaned, or unverified; stale pages are flagged and repairable. The JSON export is active-page-only: it carries freshness for live pages (`fresh`/`stale`/`unverified`); computed-orphaned pages (all sources deleted) surface only as lint and viewer signals and are dropped from the export.
- **Imported compiled knowledge is staged by default.** External bundles go through the review queue unless explicitly trusted.
- **CI gates are supported.** `wiki.lint()` and `wiki.runEval()` can enforce quality thresholds.

See [`docs/configuration/review-policy.mdx`](docs/configuration/review-policy.mdx) and [`docs/troubleshooting/stale-pages.mdx`](docs/troubleshooting/stale-pages.mdx).

## Scale and what works

llmwiki is still early software, but it is no longer a toy pipeline for a handful of notes.

- **Incremental compilation** means unchanged sources do not flow back through the LLM.
- **Parallel compile** runs concept extraction and page generation concurrently under a configurable cap (`compile({ concurrency })` / `LLMWIKI_COMPILE_CONCURRENCY`), cutting wall-clock on large compiles.
- **Chunk-level embeddings** narrow large wikis before BM25 reranking and graph expansion.
- **Content-hash-aware embedding updates** avoid recomputing vectors for unchanged pages and chunks.
- **Batch embedding** sends page and chunk vectors to the provider in batches rather than one request at a time, cutting latency on cold starts and large refreshes.
- **Binary embedding storage** automatically handles stores above the 64 MiB JSON limit; smaller stores can opt in. Binary selection persists, and retrieval still loads the index into memory. See [limits, recovery and downgrade guidance](docs/configuration/environment-variables.mdx#embedding-storage).
- **Cached citation judgements** make repeated full `runEval()` runs cheaper.
- **Lexical fallback** keeps query/context workflows usable when the active provider has no embedding endpoint.
- **Prompt budgeting and ingest truncation metadata** make large sources explicit instead of silently pretending they fit.

The current sweet spot is a durable project or domain wiki: research folders, codebase docs, team handbooks, standards, design notes, decision logs, or curated source packs. The less ideal fit is a high-churn firehose where raw search is enough and compiled structure would go stale faster than it can be reviewed.

## Documentation

The full docs site source is in [`docs/`](docs/):

- Start here: [`docs/introduction.mdx`](docs/introduction.mdx)
- Installation: [`docs/installation.mdx`](docs/installation.mdx)
- Karpathy's LLM Wiki pattern: [`docs/concepts/karpathy-pattern.mdx`](docs/concepts/karpathy-pattern.mdx)
- How the compiler works: [`docs/concepts/how-it-works.mdx`](docs/concepts/how-it-works.mdx)
- Wiki model: [`docs/concepts/wiki-model.mdx`](docs/concepts/wiki-model.mdx)
- Lifecycle profiles are fixed, not configurable: [`docs/concepts/configurable-lifecycle-profiles.mdx`](docs/concepts/configurable-lifecycle-profiles.mdx)
- AutoSci research workflow (not part of this build): [`docs/guides/autosci-research-workflow.mdx`](docs/guides/autosci-research-workflow.mdx)
- Newsroom editorial workflow (not part of this build): [`docs/guides/newsroom-editorial-workflow.mdx`](docs/guides/newsroom-editorial-workflow.mdx)
- Profile templates (not part of this build): [`docs/configuration/profile-templates.mdx`](docs/configuration/profile-templates.mdx)
- Open Knowledge Format: [`docs/guides/open-knowledge-format.mdx`](docs/guides/open-knowledge-format.mdx)
- MCP integration: [`docs/guides/mcp-agent-integration.mdx`](docs/guides/mcp-agent-integration.mdx)
- SDK: [`docs/guides/sdk.mdx`](docs/guides/sdk.mdx)
- SDK packages and upgrade notes: [`docs/guides/sdk-packages.mdx`](docs/guides/sdk-packages.mdx), [`docs/guides/sdk-upgrade.mdx`](docs/guides/sdk-upgrade.mdx)
- Architecture and ownership boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Atomic Memory bridge: [`docs/guides/atomic-memory-bridge.mdx`](docs/guides/atomic-memory-bridge.mdx)

Preview the docs locally with Node 24:

```bash
cd docs
volta run --node 24 npx mint dev --port 3001
```

## Current release

`main` carries the `1.4.0-dev.20260919` development candidate: a local
integration build, not an npm release. The product is a pnpm workspace of five
packages (`@repo/foundation`, `@repo/kg`, `@repo/wiki`, `@repo/api` and
`@atomicstrata/llmwiki-core`): the public compiler and viewer live in `@repo/wiki`,
published behind `llm-wiki-compiler`, and the knowledge and domain services behind
`@atomicstrata/llmwiki-core`. Standalone AutoSci/Newsroom process packages are
not included. See the [changelog](CHANGELOG.md) `Unreleased` section and
[`ARCHITECTURE.md`](ARCHITECTURE.md).

**Released `1.3.0`:**

- Four viewer themes, with Scientific Clay as the new default and Minimal following your system setting. Saved light/dark preferences migrate to Nebula Light/Dark.
- Recursive source discovery, literal path exclusions, and explicit project-specific compile instructions.
- Bounded binary storage for larger embedding indexes, configurable completion budgets, and protected gateway request extensions.
- OrcaRouter embedding routing, retryable rule-language changes, and a public test type-check ratchet.

See the [1.3.0 release summary](https://github.com/atomicstrata/llm-wiki-compiler/releases/tag/v1.3.0) and [changelog](CHANGELOG.md) for migration details, contributor credits, and limits.

**Released `1.2.0`:**

- Profile-aware viewer with document categories, record relationships, provenance, source previews, verified local artifact access, responsive navigation and fitted graphs.
- Additional providers and OpenAI-compatible reasoning-model controls, independent embedding configuration, and SDK embedding opt-out.
- Optional Sources sections and additive SDK system policies with prompt-change invalidation and per-page provenance.
- Shared-page recovery after source removal, citation line-list fixes, and conservative abbreviated-wikilink repair.

Windows path fixes are included, but native Windows validation and CI remain outstanding. Full filesystem-confinement guarantees on Windows remain unverified. Use a supported Linux environment for untrusted projects; see [#217](https://github.com/atomicstrata/llm-wiki-compiler/issues/217).

**Released `1.1.0`:**

- Template distribution ecosystem: publishers author signed, offline distributions with `template publish init | add | build | rotate | revoke` (Ed25519 signing, key rotation, package revocation) and verify them with `template publish verify`.
- Consumers configure explicitly trusted template taps, discover and inspect signed catalogs, and install or update templates with continuity, revocation, and compatibility checks under lock.
- `llmwiki status` command: a readable snapshot of page and source counts, last compile, stale and orphaned pages, pending changes, the review queue, active profile, and state-file health.

**Released `1.0.0`:**

- Configurable Lifecycle Profiles across CLI, SDK, MCP, viewer, context, lint, status, export, and profile-aware OKF exchange.
- Built-in `autosci` and `newsroom` templates, typed workflows and actions, first-class artifacts, typed relations and runtime lifecycle gates, plus a hardened first-party connector substrate with Crossref.
- Typed-page semantic search and retrieval controls, batch embeddings, parallel compile, and fail-closed state recovery.

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Companion: Atomic Memory

llmwiki and [Atomic Memory](https://github.com/atomicstrata/atomicmemory) are complementary open context infrastructure:

- **llmwiki** compiles source material into durable, inspectable knowledge.
- **Atomic Memory** gives agents runtime memory that is searchable, scoped, correctable, and inspectable.

Use them independently or together. The [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki) bridge consumes llmwiki's JSON export (`wiki.exportJson()`, which still accepts a `projectId`) as durable memory records.

## Contributing

Contributions are welcome. If llmwiki is missing something you need, open an issue or PR and describe the workflow you are trying to support - need-driven improvements are often the best ones. If you want to contribute more generally, roadmap items are a good place to start. For larger changes to core compile, review, import/export, or retrieval semantics, please start with an issue or design discussion so we can align on the contract first.

Before committing code changes, run:

```bash
pnpm exec tsc --noEmit
pnpm run typecheck:tests
pnpm run build
pnpm run test:affected
pnpm test
pnpm run fallow:ci
pnpm run lint
```

`pnpm run test:affected` covers the tests for what you changed; `pnpm test` runs the
whole suite and is the one to use for cross-cutting changes or before opening a
pull request. Where they meet, `test:affected` yields rather than duplicating work: it is
local-only tooling — CI's one test verdict is `pnpm test`, and the push hook runs only
`pnpm run build` — and
when your change has suite-wide reach (`package.json`, the lockfile, `vitest.config.ts`,
`tsconfig*.json`, or anything under `scripts/`) it declines to run the full unit tier,
which is a subset of `pnpm test`. It prints
`` affected: scope resolves to the full unit tier; run `pnpm test` instead `` on stderr
and exits `78`, so in that case run `pnpm test` yourself. It exits `69` when the change
set cannot be computed at all (no `origin/main` or `upstream/main`, or a failed
merge-base); exit `0` means a successful computation found nothing relevant.

### Measured verification limits

Two limits here come from measurement on the reference host rather than from core count
or habit, and raising either means re-measuring first.

- **Workers.** `vitest.config.ts` pins `maxWorkers: 4`. One full-suite run per
  configuration, sequential and alone, peak RSS of the whole run's process tree:
  2 workers 809 s / 2808 MB / no swap out, 4 workers 496 s / 3816 MB / ~1 MB, 6 workers
  403 s / 5119 MB / ~400 MB with worst MemAvailable at 2576 MB. Six workers buys 93 s and
  costs the host, which is how concurrent runs start killing each other. The cap is sized
  from the worst case `pnpm test` can actually meet — the integration tier's per-worker
  peak, because those files spawn `node dist/api.js` children at up to 442 MB each — so
  the unit tier deliberately runs below its own optimum. `pnpm run test:integration`
  overrides it lower still, with `--maxWorkers=2`.
- **Static gates.** `pnpm run gates:static` runs `tsc`, `typecheck:tests`, `typecheck:kg`,
  `lint`, `fallow:ci` and `fallow:kg` two at a time, prints each gate's output as its own
  labelled block, and fails if any fails. Measured: 35.6 s serially to ~26.7 s, peak
  ~2.2 GB, no swap added. `build` is deliberately not in the set — it writes `dist/` and
  stays ordered before anything that spawns it.

A local run of the database-backed suites needs Docker: it starts its own pinned
`pgvector/pgvector:pg16` container, where CI instead supplies the same image as a
service. A run that cannot reach or start a database fails instead of skipping.
The `LLMWIKI_TEST_DATABASE_URL` override and the
`LLMWIKI_TEST_ALLOW_NO_DATABASE=1` opt-out are documented in
[`docs/guides/row-backed-wiring-reachability.mdx`](docs/guides/row-backed-wiring-reachability.mdx).

## License

MIT

## Disclaimer

No LLMs were harmed in the making of this repo.
