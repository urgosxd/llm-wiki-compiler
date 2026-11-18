# `serve` and the graph tools: the argument this page used to make, and what is true now

Maintainer reference. This page is repo-facing (plain `.md`, not on the Mintlify site) and
used to argue that the KG's four MCP tools had no `serve`-style stdio entrypoint and did not
need one. **That argument is obsolete.** The one published image's `serve` mode — the
container's DEFAULT mode — serves those tools from a loopback listener it binds itself.

Repository facts below are cited by `path:line`; results measured against a running process
are labelled as measurements.

## The current shape, in one paragraph

`serve` (`node /app/dist/api.js serve`, which is what `docker run <tag>` runs —
`docker/entry.sh:84`) starts the **union** server: the wiki's 14 tools plus `query_stack`,
`traverse_stack` and `get_entities`, with `list_stacks` advertised once
(`packages/api/src/host/mcp-union.ts:93`). Because the graph tools are HTTP clients of a
graph API rather than database clients
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:165-169`), the same process binds the smallest
listener that can answer them: `startGraphListener`
(`packages/api/src/host/mcp-union.ts:220-241`) mounts `createApp()` alone on `127.0.0.1`
with an OS-assigned port (`:229`, `:247`) and dispatches **only** `/aks/v1`
(`packages/api/src/host/mcp-union.ts:184`, predicate at `:192-196`). The bound address is
announced on **stderr** as `[kg] serving the graph tools from http://127.0.0.1:<port>`
(`packages/api/src/main.ts:423`), and the listener is closed when the session ends
(`packages/api/src/host/mcp-union.ts:128-148`), so `serve` still exits 0 when its client
closes stdin.

## Why the handlers are the reason, not the transport

The handlers reach data over HTTP, not through a database client.
`packages/llmwiki-kg/ts/src/mcp/handlers.ts:165-169` declares their entire dependency
surface — `baseUrl`, `apiKey`, `fetchImpl` — with no pool and no database handle. Defaults
are in `packages/llmwiki-kg/ts/src/mcp/config.ts:10-14`: `AKS_BASE_URL` is a loopback HTTP
base URL on port 8000, `AKS_API_KEY` an empty, trimmed string.

Each handler makes exactly one HTTP request: `list_stacks` a `GET ${deps.baseUrl}/stacks`
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:369`), `query_stack` a
`POST ${deps.baseUrl}/aks/v1/context`, and likewise `traverse_stack` and `get_entities`
(`:279`, `:324`). No SQL statement and no database module call appears in these handlers.

That fact used to be the argument *against* a stdio entrypoint: a launcher for a client
needs a server to talk to, and the client would have to find one. It is now the argument
*for* binding one inside the same process — the client and the server are the same image,
so the address is a port this process just bound, not a deployment invariant.

Two properties make that safe rather than clever:

- **An operator's `AKS_BASE_URL` still wins, and nothing is bound.**
  `configuredKgBaseUrl` (`packages/api/src/host/mcp-union.ts:156`) is the single reader of
  that rule and `selfServedKgBaseUrl` (`:175-183`) refuses to answer when it is set.
- **The listener serves the tool surface only.** The graph app's write routes
  (`/documents`, `/ingest`, `/synthesize`, `POST /stacks`) are not published on a port
  `serve` opened on its own initiative; `/aks/v1` is the only prefix that is dispatched.

**What a graph tool answers with no usable database** is
`AKS server returned 500: Internal Server Error`, plain text and without a tool-level
`isError` flag. That is the reachability proof *and* the honest outcome: the graph route ran
in this process and failed on Postgres. The absent flag is the graph package's ported
behaviour for a non-200 response, not something this composition introduced.

## `runStdio` still exists, is still uncalled, and is now beside the point

`packages/llmwiki-kg/ts/src/mcp/server.ts:49-53` is a complete stdio MCP server, and
`packages/llmwiki-kg/ts/src/mcp/server.ts:68-70` is an entrypoint wrapper for it. `main()` is
deliberately not auto-invoked on import (`packages/llmwiki-kg/ts/src/mcp/server.ts:58-59`),
so tests can import `createMcpServer` without starting a transport.

It is uncalled by any entrypoint, and **that is no longer a gap to close**: `serve` is the
stdio entrypoint a client should use, and it serves the graph tools plus the wiki's tools
from one session. Wiring `runStdio` to a subcommand would ship a second, narrower stdio
surface — four tools where the image already answers 17 — so it stays where it is.

**Nothing about the graph's stdio path ships in a second image.** An earlier version of this
page said the compiled graph server "already ships in the image" and cited
`packages/llmwiki-kg/Dockerfile`. That Dockerfile is a **reference build that ships
nowhere**: nothing pushes it, no tag names it, and the published artifact is the root image
only. The published surface is `dist/api.js serve`, and it is described in
[`docs/kg-mcp.md`](./kg-mcp.md).

## The measurement this page was built on, kept as history

The only thing in the repository that ever invoked that stdio path is
`test/kg-mcp-e2e/kg-mcp-child.ts`: it spawns the built graph MCP entry (`:42`), builds a
`--eval` program importing that path and calling `runStdio()` (`:73-74`), and passes it to
the child (`:115`) with an environment that supplies `AKS_BASE_URL` and an empty
`AKS_API_KEY` (`:118-123`). `DATABASE_URL` is absent from it entirely.

`test/docker-image-surfaces` never existed: not in the working tree, not in the tracked
files, not in the history of any branch. The real record is `odd/tasks/kg-mcp-mount.md:42,45`,
quoted with the two intervening `404` route measurements omitted:

> stdio on the shipped CMD → zero JSON-RPC responses. The four tools answer `tools/list`
> **only** under a non-shipped entrypoint override importing `dist/mcp/server.js`.

> `count=4` came from a **stdio** child spawned by `test/kg-mcp-e2e/kg-mcp-child.ts:42,74`
> with a `--eval` import override.

The record is correct; it was mis-attributed to a file that never existed. Both facts are
about the **reference recipe's** `CMD`, which was then believed to be a shipped surface.

## Decisions dissolved, and the one that survives

1. **Where the entrypoint lives** — dissolved. `serve` exists and serves the union
   (`packages/api/src/main.ts:147` documents it as "an MCP server exposing the wiki and
   knowledge-graph tools over stdio"). The graph package's own `index.ts` still parses no
   argv (`packages/llmwiki-kg/ts/src/index.ts:9-27` reads `process.env["PORT"]` and nothing
   else), which is correct for a test composition.
2. **The `DATABASE_URL` / `AKS_DATABASE_URL` bridge — OPEN QUESTION, not dissolved.** The
   reference recipe's entrypoint bridges the two names:
   `export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"`
   (`packages/llmwiki-kg/docker/entry.sh:86`). The published image's entrypoint does no such
   thing — `docker/entry.sh` mentions neither name. So an operator who follows the KG
   documentation and sets `AKS_DATABASE_URL` against the **published** image gets nothing
   from it.

   Whether the one published image needs that bridge is **UNVERIFIED and owned by the
   verification task**, recorded as an open question in
   `odd/tasks/one-image-both-mcp-surfaces.md`, L7. Nothing in this page asserts either
   answer.

## Options considered and rejected, kept because the reasoning still holds

**A — wire a subcommand to the existing `runStdio()`.** Rejected: it would ship a narrower
stdio surface (four tools) beside the one `serve` already provides (17), and imply a service
dependency had been removed when it had only been relocated.

**B — an in-process fetch adapter**, so stdio dispatches into the app without a socket.
Not needed: `serve` binds a loopback socket for exactly that purpose, and the socket is the
same shape a client's HTTP call would take, so nothing about the graph contract changes.

**C — cut a data seam so the handlers read Postgres directly.** Rejected as high risk: it
would rewrite shared handler code the reference composition's `/mcp` mount depends on.

## Is an auth guard meaningful on a stdio transport?

No: there is no network surface for the guard to protect. The distinction that matters and is
easy to confuse: the `apiKey` in `McpDependencies`
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:165-169`) is an **outbound** credential the
handlers send to the REST API as an `X-API-Key` header
(`packages/llmwiki-kg/ts/src/mcp/config.ts:23-24`), while the **inbound** guard on the
streamable-HTTP `/mcp` is the graph's `X-API-Key` policy, enforced before any body is parsed
(`packages/api/src/host/mcp-http.ts:238`, and
[`docs/kg-mcp.md`](./kg-mcp.md#one-mcp-one-auth-policy-and-the-operator-consequence) for the
operator consequence). A stdio transport removes the inbound surface, so it removes the
guard's reason to exist, and removes nothing about the outbound credential.
