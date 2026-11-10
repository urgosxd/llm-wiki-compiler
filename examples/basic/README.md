# Basic Example

Real output from running llmwiki on a single source document about knowledge compilation.

## What's here

```
sources/
  knowledge-compilation.md    ← the input (one markdown file)

wiki/
  concepts/                   ← 7 concept pages extracted by the LLM
    change-detection.md
    compilation-pipeline.md
    concept-extraction.md
    cross-source-concepts.md
    incremental-compilation.md
    knowledge-compilation.md
    wikilinks.md
  index.md                    ← auto-generated table of contents
```

One source in, seven interlinked concept pages out. Browse the `wiki/` directory to see the compiled output, or open it in Obsidian for navigable `[[wikilinks]]`.

## Reproduce it yourself

`examples/basic/sources/knowledge-compilation.md` is the input, and `wiki/` is what
`compile()` produced from it. From a repository checkout:

```ts
import { createWiki } from "llm-wiki-compiler";

const wiki = createWiki({ root: "examples/basic" });
await wiki.compile();
const { answer } = await wiki.query("what is knowledge compilation?");
```

Add another input with `wiki.ingest({ source })`, or with the MCP `ingest_source`
tool, and compile through the MCP `compile_wiki` tool when an agent drives llmwiki.

Output will vary since it's LLM-generated, but the structure will match.
