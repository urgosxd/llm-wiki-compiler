# One container image serves both MCP tool sets

Feature branch: `feat/one-image-both-mcp-surfaces`. Defect: the published image exposes 14 wiki
MCP tools and none of the four KG MCP tools, because the host composes the KG REST app but never
the KG `/mcp` app.

## Specs

- **S1** — The human's requirement, verbatim: "no quiero 2 imágenes docker soluciona debe poder acceder a las tools del mcp de KG"
- **S2** — One published image, one entrypoint, one MCP endpoint. `node dist/api.js` must expose the KG MCP tools on the same surface that today exposes the wiki tools, over both stdio (`serve`) and HTTP (`/mcp`).
- **S3** — The union `tools/list` on the built artifact contains exactly these 17 names and no others: `compile_wiki`, `export_okf`, `get_context_pack`, `ingest_job_delete`, `ingest_job_status`, `ingest_jobs_list`, `ingest_source`, `lint_wiki`, `list_stacks`, `query_wiki`, `read_page`, `run_eval`, `search_pages`, `wiki_status`, `query_stack`, `traverse_stack`, `get_entities`. The count and the exact name set are asserted, not "more than 14".
- **S4** — `list_stacks` is a name collision between the two surfaces and is resolved in favour of the **wiki** implementation (`packages/wiki/src/mcp/stack-tools.ts`). The KG implementation is not registered in the union. Rationale: the 14 existing tools must not change behaviour, the wiki implementation reads the wiki stack store the existing client already sees, and the KG implementation would add an HTTP hop to `${baseUrl}/stacks` plus a dependency on the KG REST surface being up.
- **S5** — Auth: the single `/mcp` endpoint carries the KG policy, `X-API-Key`. Enforcement follows the existing `authEnabled` semantics built in `packages/llmwiki-kg/ts/src/auth.ts`: when `AKS_API_KEY` is configured the endpoint requires the header; when it is not configured the middleware passes every request through, exactly as the KG image behaves today. Consequence to be documented in `docs/`: an operator who sets `AKS_API_KEY` now needs the header for the wiki tools too, because one endpoint cannot carry two policies. Stated explicitly, never silently.
- **S6** — The refusal is HTTP 401 with body `{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}` — the existing constant in `packages/llmwiki-kg/ts/src/auth.ts`, asserted verbatim.
- **S7** — Failure isolation: registering the KG tools must not open a database connection or resolve a stack at startup. A KG tool that fails returns an error result for that call only; it must not prevent the server from starting and must not affect any wiki tool. No KG dependency may be loaded eagerly at module scope of the composed server.
- **S8** — `initialize` still answers on the union surface over both transports.
- **S9** — `scripts/apply-schemas.sh` from the image still exits 0. It already applies `packages/llmwiki-kg/db/schema.sql` (creating `public.stacks`) and `wiki.kg_extracted_chunks`; this is a regression check, not new work.
- **S10** — One KG tool is called end to end through the same transport a client uses (`query_stack` or `list_stacks` exercises the KG wiring; `tools/list` alone proves only composition).
- **S11** — The second image stops being a deliverable: `packages/llmwiki-kg/Dockerfile` and the "BOTH images this repository ships" claim in `.github/workflows/ci.yml` are corrected or named as remaining work. `packages/llmwiki-kg/ts/src/index.ts` may stay in the tree as a test composition and must be documented as not a deliverable.
- **S12** — Constraints: `api → kg` imports only, never `kg → wiki`. Do not touch `packages/llmwiki-kg/LICENSE.md` or `packages/llmwiki-kg/ts/oracle/**`. Do not change the extraction algorithm or ingest behaviour. Never read, print or commit `.env`, keys or tokens. Nothing pushed, no PR, no merge.

## Tasks

- **T1** (S1) — Prepare checkout and commit this document. Commit: `b11b52c05ffbb2c6f0301805c839d5a1698c618a`.
- **T2** (S2, S3) — RED: a test against the built `dist/api.js` asserting the 17-name union set, failing because the three KG names are absent. Done: `test/mcp/one-image-both-mcp-surfaces.test.ts` shipped in T3's commit, `c753989a712f786642ab79413b349e4e3cbd204a`, so no commit of its own.
- **T3** (S2, S3, S4, S7, S8, S10) — Compose the union in `packages/api` and make T2 green. Done. Commit: `c753989a712f786642ab79413b349e4e3cbd204a`.
- **T4** (S5, S6, S7) — Auth slice on `/mcp`, both directions asserted. Done. Own commit, `Risk: item 2`. Commit: `f4062035fa73be200b6781d726f631e7308e9ca2`. Closed — this commit is the auth slice boundary.
- **T5** (S11) — Retire the second image from Dockerfile, CI and docs. Commit: pending.
- **T6** (S9, S10, S12) — Independent verification and local image build evidence. Commit: pending.

## Log

- **L1** — Human request, verbatim: "no quiero 2 imágenes docker soluciona debe poder acceder a las tools del mcp de KG"
- **L2** — Human-supplied evidence, re-verified with `path:line` against this checkout, not trusted as given:
  - MCP `tools/list` (stdio) on the published amd64 artifact `sha256:da240cf…` returned 14 tools: `compile_wiki`, `export_okf`, `get_context_pack`, `ingest_job_delete`, `ingest_job_status`, `ingest_jobs_list`, `ingest_source`, `lint_wiki`, `list_stacks`, `query_wiki`, `read_page`, `run_eval`, `search_pages`, `wiki_status`.
  - The same 14 over HTTP `POST :4182/mcp`.
  - `query_stack`, `traverse_stack`, `get_entities` appear zero times in `dist/api.js` — absent, not failing.
  - They live in `packages/llmwiki-kg/ts/src/mcp/tools.ts:79-175` (`MCP_TOOLS` holds `query_stack` :81, `traverse_stack` :109, `get_entities` :142, `list_stacks` :175).
  - `createKgApp` at `packages/llmwiki-kg/ts/src/app.ts:78` mounts `/mcp` at :81-83 behind `options.apiKey ?? requireApiKey`, then mounts the inner REST app at :88. It listens on `DEFAULT_PORT = 8000` (`packages/llmwiki-kg/ts/src/index.ts:8`).
  - `packages/api/src/host/server.ts:67` imports `createApp` from `@repo/kg/server` and calls it at :565 inside `createGraphApp()`; `createKgApp` appears nowhere in that file. So the host mounts KG's REST routes and never KG's `/mcp`.
  - `docker.io/urgosxd7/llmwiki-kg` returns 404 on Docker Hub.
- **L3** — Premises corrected by measurement during this feature:
  - `:4182` appears nowhere in the repository; it was the operator's container port mapping. Repository defaults are `DEFAULT_HOST_PORT = 4173` (`packages/api/src/host/server.ts:105`) and `8000` (`packages/llmwiki-kg/ts/src/index.ts:8`).
  - A **second Dockerfile does exist**: `packages/llmwiki-kg/Dockerfile` (`EXPOSE 8000`, `CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]`), and `.github/workflows/ci.yml:138` states "BOTH images this repository ships are built here". The second image is therefore described by the tree even though it was never published.
  - **No workflow pushes any image.** `buildx` and `urgosxd7` appear in no workflow; `urgosxd7/llmwiki:latest` appears only in `docker-compose.hub.yml:47,60`. Publishing is a human step, not an automated one.
  - The KG auth middleware is **fail-open when no key is configured**: `packages/llmwiki-kg/ts/src/auth.ts` returns `next()` when `!cfg.authEnabled`. Assuming the KG tools were always protected would be wrong.
  - `dist/` and `node_modules/` are absent in a fresh checkout of this branch; every claim about `dist/api.js` must be re-measured after a build, never inherited.
  - `scripts/apply-schemas.sh` already applies `packages/llmwiki-kg/db/schema.sql` (`:74`) and already lists `public.stacks` (`:129`) and `wiki.kg_extracted_chunks` (`:147`), so S9 is a regression check.
  - The wiki host `/mcp` is currently unauthenticated (`isMcpHttpPath`, `packages/api/src/host/mcp-http.ts:97`). S5 states the resulting single policy.
- **L4** — T3 composition, as measured in `c753989a712f786642ab79413b349e4e3cbd204a`:
  - The union lives in `packages/api/src/host/mcp-union.ts` and both transports start from `createUnionMcpServer`: `serve` (stdio) via `startUnionMcpServer`, `host` via the existing `mcpServerFactory` seam. `packages/wiki/**` is untouched, so the wiki package still knows nothing about the graph.
  - The graph package exposes a REGISTRATION SEAM (`packages/llmwiki-kg/ts/src/mcp/union.ts`, exported from `@repo/kg/mcp`) instead of a second server: `registerKgToolsOn` registers `MCP_TOOLS` minus `UNION_YIELDS_TO_WIKI` on a high-level SDK `McpServer`, converting each tool's own `inputSchema` with `zod`'s `fromJSONSchema`, so the graph contract stays declared once. Measured on the union surface: `required` and every property description survive the conversion (`query_stack` -> `["query","stackId"]`, `traverse_stack` -> `["start","stackId"]`, `get_entities` -> `["stackId"]`).
  - S4 is enforced by name, not by ordering: `UNION_YIELDS_TO_WIKI = "list_stacks"`. The graph `list_stacks` stays in `MCP_TOOLS` and stays served by the standalone graph server; the union advertises 17 names.
  - One decision beyond registration, recorded here because it is not in the Specs: the graph tools are HTTP clients of a graph API, so in `host` mode `selfServedKgBaseUrl` points them at the listener this process bound when `AKS_BASE_URL` is unset. Without it the image would advertise three tools that dial a port the image does not run. `AKS_BASE_URL`, when set, always wins. In `serve` (stdio) mode there is no listener to point at, so those three tools need a reachable graph API — named as remaining work, not silently claimed.
  - `HostOptions.mcpServerFactory` now receives the bound address (`McpBoundAddress`), because `--port 0` only becomes a number after `listen`. A zero-argument factory remains assignable, so existing callers were unaffected.
  - S10 measured BOTH ways: a real `get_entities` call over the stdio client succeeded end to end against a per-run database and a Stack created over the host's own `POST /stacks` (the answer was the graph surface's own `(No entities matched the filter)`), and the isolation case pointed the graph surface at a closed loopback port with a real database in reach and saw the graph call answer an error result while `lint_wiki` still answered JSON in the same session. `search_pages` was rejected for that case because it needs an LLM provider, which would have failed for a reason unrelated to isolation.
  - Not done here, by design: auth (T4, `Risk: item 2`), retiring the second image (T5), and the image build evidence (T6).
- **L5** — T4 auth slice, as measured in `f4062035fa73be200b6781d726f631e7308e9ca2`. The environment variable that decides the policy is `AKS_API_KEY`; `packages/llmwiki-kg/ts/src/config.ts:316` sets `authEnabled: parsed.AKS_API_KEY !== ""`, and `auth.ts` passes every request through when that flag is false — so **the default is pass-through when no key is configured**, matching the graph image.
  - The policy is the graph's own middleware, not a copy: `packages/api/src/host/mcp-http.ts:144` binds `createRequireApiKey(kgConfig)`, re-exported from `packages/llmwiki-kg/ts/src/core-index.ts:109`. `packages/api/package.json` declares no `express`, and the Express surface the middleware needs is a two-method facade (`status`, `json`) over the real `ServerResponse`, so the 401 body is `INVALID_API_KEY_DETAIL`'s own bytes and cannot drift from `auth.ts`.
  - Enforcement is `handleMcpHttp`'s first statement, before body parsing and before method handling, and `handleMcpHttp` is reached only under `isMcpHttpPath(req.url)` (`packages/api/src/host/server.ts:628`), so no other route changed.
  - Six measured request outcomes against a spawned `dist/api.js host --port 0`, `test/mcp/mcp-auth-policy.test.ts`, 6/6 passing:
    1. key configured, no `X-API-Key` → **401**, body exactly `{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}`.
    2. key configured, correct header → **200**, `initialize` answers and `tools/list` returns the same 17-name union.
    3. key configured, wrong header → the **same 401 and the same bytes**, so the comparison is real rather than "a header is present".
    4. key configured, `/health` without a header → **200** `{"status":"ok"}`, asserted in the same child as a 401 on `/mcp`, so the stricter surface is scoped to `/mcp` alone.
    5. no key configured, no header → **200** and the whole union (pass-through default).
    6. key configured, stdio `serve` → the whole union, unaffected, because stdio has no headers.
  - Operator consequence, stated and not silent: setting `AKS_API_KEY` now requires the `X-API-Key` header for the streamable-HTTP wiki tools too. S5's `docs/` wording is T5's, still pending.
