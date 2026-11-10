# @atomicstrata/llmwiki-core

The published scoped package for llmwiki knowledge and domain services.
Applications should import `llm-wiki-compiler` instead.
This package is publicly downloadable but its direct exports are internal
composition contracts, not a separately supported consumer API.

Internal composition example for compiler maintainers:

```js
import { createWikiCore } from "@atomicstrata/llmwiki-core";
const wiki = createWikiCore({ root: "/absolute/project/path" });
```

The manifest directory holds only `package.json`, `tsup.config.ts`, `README.md`
and `LICENSE`. It publishes the built wiki sources as
`@atomicstrata/llmwiki-core` and `@atomicstrata/llmwiki-core/compiler-sdk`.

Core exposes knowledge and domain services, profile loading, confined reads,
viewer collection and the operator trust grant. Existing grants, profile checks,
reviewed mutations and path confinement still apply; choosing core is not a grant.

The standard `llm-wiki-compiler` package remains the full SDK, whose library
surface is `createWiki()`. It composes this same core;
`@atomicstrata/llmwiki-core/compiler-sdk` is the entry for an embedder that
constructs the core itself.

Build from the repository root with `npm run build`. Local installation before
publication must supply matching tarballs explicitly; no runtime downloading or
fallback is provided. See the repository's ARCHITECTURE.md for ownership and
package-analysis conventions. Requires Node 24 or later.
