# A stdio entrypoint for the KG MCP tools: why this was cancelled

Maintainer reference. This page is repo-facing (plain `.md`, not on the Mintlify site) and
exists because new agents keep re-asking why the KG has no `serve`-style stdio subcommand for
its four MCP tools the way the wiki does. Repository facts below are cited by `path:line`;
results measured against a running service are labelled as measurements.

> The four KG MCP tools are HTTP clients of the KG's own REST API. A stdio entrypoint
> for them is a launcher for a client, not a replacement for the service. The service
> still has to be running.

## Why the premise was wrong

The branch this page replaces assumed the tools could be reached without a long-running HTTP
service. They cannot: the handlers reach data over HTTP, not through a database client.
`packages/llmwiki-kg/ts/src/mcp/handlers.ts:165-169` declares their entire dependency surface —
`baseUrl`, `apiKey`, `fetchImpl` — with no pool and no database handle. Defaults are in
`packages/llmwiki-kg/ts/src/mcp/config.ts:10-14`: `AKS_BASE_URL` is a loopback HTTP base URL
on port 8000, `AKS_API_KEY` an empty, trimmed string.

Each handler makes exactly one HTTP request: `list_stacks` a `GET ${deps.baseUrl}/stacks`
(`handlers.ts:369-373`, in `listStacks` at `:357`), `query_stack` a
`POST ${deps.baseUrl}/aks/v1/context` (`:234-239`, in `queryStack` at `:212`), and likewise
`traverse_stack` and `get_entities` (`:278-281`, `:323-326`). No SQL statement and no database
module call appears in these handlers. The transport decides how a call arrives; the handler
decides where data comes from, and it already decided: the KG's own REST API.

## The strongest single piece of evidence

The only thing in the repository that ever invoked the stdio path is
`test/kg-mcp-e2e/kg-mcp-child.ts`: it spawns the built MCP entry (`:42`), builds a `--eval`
program importing that path and calling `runStdio()` (`:73-74`), and passes it to the child
(`:115`). The environment that child gets is its whole environment (`:118-123`):

```ts
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      AKS_BASE_URL: baseUrl,
      AKS_API_KEY: "",
    },
```

`AKS_BASE_URL` and `AKS_API_KEY` are present; `DATABASE_URL` is absent entirely, and `:116-117`
states nothing is inherited that could supply a different endpoint or key. The harness had to
supply an HTTP base URL because the handlers have nothing else to talk to.

## `runStdio` already exists, is shipped, and is uncalled

`packages/llmwiki-kg/ts/src/mcp/server.ts:49-53`:

```ts
export async function runStdio(dependencies: McpDependencies = {}): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

and `server.ts:68-75`:

```ts
export async function main(): Promise<void> {
  try {
    await runStdio();
  } catch (error) {
    console.error("MCP server failed to start:", error);
    process.exitCode = 1;
  }
}
```

A complete, working stdio MCP server that already ships in the image: the compiled `dist` is
copied in at `packages/llmwiki-kg/Dockerfile:113`, which puts `dist/mcp/server.js` there, while
the shipped `CMD` (`Dockerfile:123`) starts `dist/index.js` and never imports it. Wiring an
entrypoint to it was never blocked by difficulty. The module says so at `server.ts:58-59` — it is
*"Deliberately not auto-invoked on import"*, because tests and launchers import it for
`createMcpServer`.

Nobody decided this was hard. It was decided to be unnecessary — and `--eval` in a test
harness is what exposed it.

## The citation error, recorded so it is not repeated

`test/docker-image-surfaces` never existed: not in the working tree, not in the tracked files,
not in the history of any branch. The real record is `odd/tasks/kg-mcp-mount.md:42,45`, quoted
with the two intervening `404` route measurements omitted:

> stdio on the shipped CMD → zero JSON-RPC responses. The four tools answer `tools/list`
> **only** under a non-shipped entrypoint override importing `dist/mcp/server.js`.

> `count=4` came from a **stdio** child spawned by `test/kg-mcp-e2e/kg-mcp-child.ts:42,74`
> with a `--eval` import override.

The record is correct; it was mis-attributed to a file that never existed. That difference is
the whole finding: plain stdio on the shipped `CMD` returned zero JSON-RPC responses, while
`count=4` came only from the `--eval` child.

> a stdio transport does not remove a service dependency that lives in the handler, not in the transport.

## One code path was never in question

The HTTP `/mcp` mount and `runStdio` build their server with the same function from the same
module. `app.ts:81-87` registers
`app.all(MCP_HTTP_PATH, options.apiKey ?? requireApiKey, express.json({ strict: false }),`
`createMcpHttpHandler(options.mcpDependencies), mcpErrorHandler)`.
`packages/llmwiki-kg/ts/src/mcp/http.ts` imports `createMcpServer` from `server.js` (`:55`),
claims the path as one constant (`:58`), and per request calls `createMcpServer(dependencies)`
(`:116`) on a `new StreamableHTTPServerTransport(...)` (`:117`) — the same `createMcpServer`
`runStdio` calls at `server.ts:50`. No handler or route change was ever needed.

## Decisions dissolved, not deferred

Two decisions were opened and then dissolved by this finding. Neither is pending:

1. **Where the entrypoint lives** — a subcommand versus a separate bin. There is no entrypoint
   to build. `packages/llmwiki-kg/ts/src/index.ts` reads `process.env["PORT"]` (`:7-20`),
   validates config (`:28-34`), builds the app (`:36`) and calls `listen(...)` (`:38`): it
   never touches `process.argv` and claims no `serve` token. The only argv-parsing entry in
   the package is the eval CLI (`packages/llmwiki-kg/ts/src/core/eval/cli.ts:26`).
2. **The `DATABASE_URL` / `AKS_DATABASE_URL` guard** — the MCP handlers open no database, so a
   guard on a stdio entrypoint could not have been what prevented a wrong database contact.

## Options considered and rejected

**A — wire a subcommand to the existing `runStdio()`.** Cheap, and it would enumerate four
tools. Rejected because it ships a launcher for a client while implying the service dependency
is gone. A correct small change under a different name; not this change.

**B — an in-process fetch adapter**, so stdio dispatches into the app without a socket.
Rejected because its entire purpose is to avoid a local socket that is already open and already
in service: the container is running, and the tool surface answers over HTTP — three of the four
tools today, with `query_stack` blocked by a separate, unrelated defect recorded below. B would
avoid a socket the caller already has, and be paid for in real code.

**C — cut a data seam so the handlers read Postgres directly.** Rejected as high risk: it would
rewrite shared handler code the merged, image-probed HTTP `/mcp` mount depends on.

## What would reopen B

Not a wish — a measurement. B becomes worth building when the container dependency is a
*measured operational pain*: the container cannot run at all where the agent needs the tools (no
daemon, no privileges, no way to reach its listener); or its cost is paid repeatedly and
measured (spawns per session times seconds per spawn); or a target environment requires the
tools to answer with no listening process anywhere in the host. Until one of those is measured
and written down, B avoids a socket that is already open.

## Where the goal is already met

**Measurement, not a repository fact:** against the running KG service, the HTTP probe that
gate-checked this branch enumerated four tools and got a successful `tools/call` on
`list_stacks` returning the demo stack `bde24d9c-6504-40f0-8c7f-520e8e0c847a`. That result is
not reproducible from a checkout alone. Three of the four tools answer today; `query_stack`
does not.

The repository documents only what that endpoint *needs*: its `POST /aks/v1/context` path
requires an embedding provider and an LLM (`odd/tasks/reach-test.md:313-316`) — a dependency,
not a diagnosis. The diagnosis, that the failure comes from the chat-versus-embeddings host
topology rather than from the transport, is an observation made from the probe above and has no
repository citation. It is tracked as separate work.

The HTTP path already reaches the agent's goal; the transport was never the blocker.

## Is an auth guard meaningful on a stdio transport?

No: there is no network surface for the guard to protect. The distinction that matters and is
easy to confuse: the `apiKey` in `McpDependencies` (`handlers.ts:167`) is an **outbound**
credential the handlers send to the REST API as an `X-API-Key` header
(`packages/llmwiki-kg/ts/src/mcp/config.ts:23-24`), while the **inbound** guard on the HTTP
mount is `options.apiKey ?? requireApiKey` in the route (`app.ts:83`). A stdio transport
removes the inbound surface, so it removes the guard's reason to exist, and removes nothing
about the outbound credential.
