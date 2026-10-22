# Contributing

Thanks for your interest in the AKS Reference Server. This project exists to demonstrate the [AKS specification](https://github.com/your-username/aks-spec). Contributions that strengthen that demonstration — clarity, conformance, real-world usability — are especially welcome.

## What we're looking for

**Bug reports.** If something doesn't work as documented, open an issue with:
- What you ran (the exact command or request)
- What you expected to happen
- What actually happened (including any error output)
- Your environment (OS, Docker version, Python version if running outside Docker)

**Documentation improvements.** The README is the front door. If something is unclear, missing, or wrong, fixing it is genuinely helpful. PRs welcome without prior discussion.

**Format extractors.** Currently UTF-8 text only. PDF, DOCX, and HTML support would expand who can use the server with real documents.

**Chunking strategy variants.** The default `SentenceSplitter` is fine for prose. Markdown-aware (headings as boundaries) and code-aware (tree-sitter AST) splitters would meaningfully improve extraction quality on those formats.

**Alternative extraction backends.** LlamaIndex is the current default. LangChain, Instructor (pydantic-based structured output), and hand-written Anthropic-SDK extractors are all reasonable alternatives. Adding one as an option (selectable via env var) without breaking the default would be a clean contribution.

**Embedding provider additions.** Voyage AI, Cohere, sentence-transformers (local), Bedrock — anything that presents a reasonable Python interface and produces dense vectors.

**MCP tool additions.** Any AKS endpoint that would benefit from being callable by an MCP client. Pages? Bundle export? Ingestion status? Open an issue to discuss before sending a PR.

## What we're not looking for

**Tightly-coupled production features.** Authentication backends, billing integrations, multi-tenancy. These belong in commercial products built on AKS, not in the reference server. The reference server is meant to be small and clear.

**Performance optimizations that obscure the code.** This is a teaching codebase as much as a working one. A 2x speedup that triples the line count and adds three new dependencies probably doesn't belong here.

**Wholesale architectural rewrites.** If you think the design is wrong in a fundamental way, open an issue first to discuss before writing code.

## Pull request process

1. Fork the repo and create a branch from `main`
2. Make your changes, with comments where the why isn't obvious from the code
3. Add or update tests if you've changed behavior (we don't have a deep test suite, but cover what you can)
4. Make sure `docker compose up --build` still works end-to-end
5. Open a PR against `main` with a clear description of what changed and why

Small typo fixes and obvious bug fixes can skip the issue-first step. For anything substantial (new feature, architectural change), please open an issue first so we can talk through the design before you spend time on it.

## Code style

- Python 3.13, type hints encouraged but not required where clarity is better served without them
- Match the existing style: descriptive variable names, comments that explain why (not what), prefer explicit over clever
- SQL queries inline in the routers are fine — that's the convention here
- Keep public function signatures stable when possible; isolate library-specific code (LlamaIndex, etc.) to the modules that import them

## License of contributions

By contributing, you agree that your contributions are licensed under the Apache 2.0 license matching the project. No CLA required.