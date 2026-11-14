# The KG MCP endpoint: where the tools are served, and the shapes this is not

Maintainer reference. This page is repo-facing (plain `.md`, not published on the
Mintlify site) and exists because two shapes were asserted in review that the code
does not have. It records the real shape of both sides, a deliberate authentication
divergence, and one deployment observation that is knowingly left unfixed.

Every claim below is cited by `path:line`. Where a claim is not cited, this page does
not assert it.

## One process, one port — and why the mount cannot live inside `createApp`

The shipped image runs **one** process. `packages/llmwiki-kg/Dockerfile:123` is
`CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]`, and the image exposes a single
port (`packages/llmwiki-kg/Dockerfile:117`). That entrypoint builds the app at
`packages/llmwiki-kg/ts/src/index.ts:36` and binds the listener at
`packages/llmwiki-kg/ts/src/index.ts:38`, on `DEFAULT_PORT = 8000`
(`packages/llmwiki-kg/ts/src/index.ts:4`) and `HOST = "0.0.0.0"`
(`packages/llmwiki-kg/ts/src/index.ts:5`). There is no second binary and no second
port: whatever serves the KG MCP tools is served by that process, on that listener.

The reason the mount has to be composed **outside** `createApp` follows from a
measured property of `createApp` itself. `installFallbacks`
(`packages/llmwiki-kg/ts/src/server.ts:246`) appends a terminal handler at
`packages/llmwiki-kg/ts/src/server.ts:249`:

```ts
app.use((_req: Request, res: Response) => {
  res.status(404).json({ detail: "Not Found" });
});
```

That handler is pathless, so it matches every request Express has not already
answered, and it **responds** rather than calling `next()`.
`packages/llmwiki-kg/ts/src/server.ts:302` installs it before
`packages/llmwiki-kg/ts/src/server.ts:304` returns the app.

**So any route appended to the returned app is unreachable**: the catch-all answers
first. A mount added to the result of `createApp()` would answer
`{"detail":"Not Found"}` exactly like a path that was never mounted, and the defect
would present as "the mount did not work" rather than "the mount was installed one
step too late". The composition therefore has to be an outer app that claims `/mcp`
before delegating every other path to `createApp()` — and it is not optional polish:
the `404` at `packages/llmwiki-kg/ts/src/server.ts:249` is installed by
`installFallbacks` (`packages/llmwiki-kg/ts/src/server.ts:302`) one line before
`createApp` returns (`packages/llmwiki-kg/ts/src/server.ts:304`), so there is no later
point at which a route could be inserted ahead of it. The outer app exists exactly
because that is the only place with room for one.

That shape is not invented for KG. `packages/api` already composes `createApp()` the
same way: `packages/api/src/host/server.ts:256` returns `createApp()` from
`createGraphApp()`, and the host hands it a request only after its own dispatch has
declined it. `packages/api` imports that app from `@repo/kg/server`
(`packages/api/src/host/server.ts:67`), which is precisely why `createApp` stays
untouched: anything changed inside it would also land in the wiki's listener.

### The composed app: `/mcp` is claimed before the inner app sees anything

`createKgApp` (`packages/llmwiki-kg/ts/src/app.ts:78`) is that outer app, and it is two
registrations and nothing else:

1. `app.all(MCP_HTTP_PATH, guard, express.json({ strict: false }), handler, mcpErrorHandler)`
   at `packages/llmwiki-kg/ts/src/app.ts:81-87` claims the **exact path** `/mcp` with its
   own guard, its own parser, the MCP handler and the chain's own error middleware.
2. `app.use(createApp(...))` at `packages/llmwiki-kg/ts/src/app.ts:88` hands every other
   path — all of them, because an `/mcp` request is answered inside the chain above and
   never falls through — to the untouched inner app.

Order is the whole contract. The route is registered first, so an `/mcp` request is
answered there and never falls through to the inner app's catch-all; every other path
skips it entirely and keeps the inner app's middleware, routers, `404` body and error
handler exactly as the existing suite pins them. `/mcp` requests also never reach the
inner body parser, so no request is parsed twice. `createApp` stays byte-identical,
which is what keeps the same instance working for the wiki: `packages/api` composes it
at `packages/api/src/host/server.ts:256`, so a KG-only endpoint added inside it would
have appeared on the wiki's listener too.

### A route, not a prefix — and `all`, not `post`

Both halves of that first registration are deliberate, and each was measured on the
built image after a working version had got it wrong.

**A route, not a prefix mount.** `app.use("/mcp", …)` prefix-matches, so it also claims
`/mcp/mcp` and `/mcp/<anything>`. Measured against the pre-fix build, `POST /mcp/mcp`
with a valid key answered `406` carrying the SDK's own envelope —
`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must
accept text/event-stream"}}` — which means the MCP chain ran, where the pre-branch build
had answered `404`. A path that is not a tool endpoint became a served one, and the
negative control went with it: under a prefix mount, "404 because nothing is mounted
here" can no longer be told apart from "404 because the handler declined". The
exact-path route answers `404 {"detail":"Not Found"}` for `/mcp/mcp` and
`/mcp/<anything>`, identical to any path no router knows, and
`packages/llmwiki-kg/ts/src/kg-app.test.ts:319-334` compares the nested path against
`/not-a-kg-route` inside the same test, so the assertion is "the MCP handler never ran"
rather than a literal string.

**`all`, not `post`.** The Streamable HTTP transport answers three methods on the one
path: `POST` carries JSON-RPC requests, `GET` opens the server-sent-event stream replies
are streamed over, and `DELETE` ends a session. A `POST`-only route never enters the
chain for the other two methods at all, so the SSE stream would be silently dropped —
no error, just a client that waits forever — and session teardown would answer as an
unmounted path. That is why the registration is `app.all`.
`packages/llmwiki-kg/ts/src/kg-app.test.ts:336-349` pins both surviving methods:
`GET /mcp` reaches the transport (it answers the SDK's `406` envelope,
`{"jsonrpc":"2.0",…}`, because this probe does not accept `text/event-stream`), and
`DELETE /mcp` answers `200`.

### The error middleware is what keeps a parse failure in the KG envelope

`express.json({ strict: false })` (`packages/llmwiki-kg/ts/src/app.ts:84`) hands the
handler an already-parsed body, which is what the SDK transport prefers over reading the
stream again. That convenience is not by itself an error-handling property: a body the
parser rejects leaves it as `next(err)`, and before this middleware existed that error
left the whole chain. Measured on the built image, `POST /mcp` with body `{oops`
answered `400` with Express's **default HTML error page**, carrying a `SyntaxError`
stack whose frames named `node_modules` paths — an internal disclosure, on a public
endpoint, in a shape no KG route uses.

`mcpErrorHandler` (`packages/llmwiki-kg/ts/src/mcp/http.ts:196-214`) is what makes the
envelope true. It is a four-argument error middleware placed **after** the parser inside
that same `app.all` chain (`packages/llmwiki-kg/ts/src/app.ts:81-87`), and the position
is the whole mechanism: Express only invokes an error middleware registered after the
layer that failed, so listing it after `express.json` is exactly what lets it receive
the parser's `next(err)`. It answers a parse failure with a fixed
`400 {"detail":"Invalid JSON body"}`, and any other failure in the chain with a generic
4xx/5xx `detail` — `400 {"detail":"Bad Request"}`, or
`500 {"detail":"Internal Server Error"}` for a 5xx — never `err.message`, never a
stack, never HTML. Re-measured after the fix: `400`,
`application/json; charset=utf-8`, body exactly `{"detail":"Invalid JSON body"}`, and
no `SyntaxError`, no `node_modules`, no stack frame.
`packages/llmwiki-kg/ts/src/kg-app.test.ts:263-281` asserts that envelope and each of
those absences.

**Why this is spelled out.** The middleware does not explain itself. An error handler
whose only visible job is saying "Bad Request" reads like ceremony, and the obvious next
move — delete it, nothing reaches it — restores the HTML stack page on the one input
that does.

`packages/llmwiki-kg/ts/src/index.ts:36` now builds `createKgApp()`. `validateConfig`
still runs before `listen` (`packages/llmwiki-kg/ts/src/index.ts:29`, listener at
`packages/llmwiki-kg/ts/src/index.ts:38`), so the boot gate recorded below is
unchanged by this composition.

### The guard attaches to the mount, before the body parser

`/mcp` is guarded by `requireApiKey` (`packages/llmwiki-kg/ts/src/auth.ts:74`) as the
second element of the route at `packages/llmwiki-kg/ts/src/app.ts:81-87`: guard, then
`express.json`, then the handler, then the chain's error middleware. An unauthenticated
request is therefore refused at
`packages/llmwiki-kg/ts/src/auth.ts:63` — `401` with the shared
`{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}` body —
**before any body is parsed**. That position is deliberate in both directions: parsing
first would spend work on requests that carry no credential, and a malformed body
would then compete with the `401` for which error the caller sees. The guard also runs
before the transport exists, so a refused request never constructs a server.

The test that fails when this guard is deleted is
`packages/llmwiki-kg/ts/src/kg-app.test.ts:286-296`. It opens the inner routers with a
pass-through middleware (`packages/llmwiki-kg/ts/src/kg-app.test.ts:295`) so the only
middleware that can answer `401` on `/mcp` is this one — without that isolation the
result would not distinguish the mount's guard from a router's.

### The transport is stateless, and there is no session map on purpose

`MCP_HTTP_PATH = "/mcp"` is declared once, at
`packages/llmwiki-kg/ts/src/mcp/http.ts:58`, so the mount and any client constant
cannot drift. Each request runs `answerMcpRequest`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:111-128`), which does four things in order:
builds a fresh server with `createMcpServer`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:116`), constructs one
`StreamableHTTPServerTransport` from `STATELESS_OPTIONS`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:117`), hands the already-parsed `req.body` to
`handleRequest` (`packages/llmwiki-kg/ts/src/mcp/http.ts:122`), and closes the
server in `finally` (`packages/llmwiki-kg/ts/src/mcp/http.ts:126`).

`STATELESS_OPTIONS` is `{ sessionIdGenerator: undefined }`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:79-81`) — the SDK's documented stateless mode.
**There is no session map in this module, and that absence is the design.** A session
map would be per-process memory, so the moment two replicas sit behind one load
balancer a client's second request lands on a process that never saw its
`initialize`. Stateless costs one re-initialization per request and makes the listener
answerable by any number of callers without coordination; `server.close()` in the
`finally` is what stops a per-request server from leaking its transport listeners
after the reply is already written.

The sequence is the sibling's, deliberately:
`packages/api/src/host/mcp-http.ts:160-169` builds one server, one stateless transport,
one `handleRequest`, and closes in the same `finally`. The substantive difference is
where the body comes from — the host dispatcher has no body middleware, so the wiki
handler reads JSON itself (`packages/api/src/host/mcp-http.ts:154`), while here
`express.json({ strict: false })` has already parsed it
(`packages/llmwiki-kg/ts/src/app.ts:84`). A pre-parsed body is what the SDK transport
prefers, and it avoids growing a second, differently-shaped parser inside the transport.
It does not, by itself, keep a parse failure inside the KG's error shape — that is
`mcpErrorHandler`'s job, and the reason it sits after the parser is described above. A
rejection from the handler itself is forwarded with `next`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:147`) rather than answered inline, so a
transport-level failure reaches the same envelope.

### The typing boundary: two named assertions, at one edge

`packages/llmwiki-kg/ts/tsconfig.json:17` enables `exactOptionalPropertyTypes`. The root
config that compiles `packages/api` does not (`tsconfig.json:2-19`; it sets `strict` at
`tsconfig.json:6` and nothing finer), which is why
`packages/api/src/host/mcp-http.ts:161` can spell `{ sessionIdGenerator: undefined }`
inline while this package cannot. The installed SDK declares the option as
`sessionIdGenerator?: () => string`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:48`)
and its interface member as `onclose?: () => void`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.d.ts:75`), while the
class it ships exposes an accessor typed `(() => void) | undefined`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts:70-71`) —
two declarations of the same member that agree at runtime and disagree under the
stricter flag. Those two dependency lines move when the dependency is upgraded; the
two assertions below are the stable place to read the fact.

| Assertion           | Where                                         | What it bridges                                           |
| ------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `STATELESS_OPTIONS` | `packages/llmwiki-kg/ts/src/mcp/http.ts:79-81` | the option field accepts `() => string` only              |
| `asTransport()`     | `packages/llmwiki-kg/ts/src/mcp/http.ts:97-99` | `onclose` optionality between the class and the interface |

**This is an upstream typing defect worked around at one boundary, not a design
compromise.** Each assertion carries its reason in JSDoc at the point of use
(`packages/llmwiki-kg/ts/src/mcp/http.ts:69-78` for the option,
`packages/llmwiki-kg/ts/src/mcp/http.ts:83-96` for the interface), and neither changes
what the process does.

The behaviour was kept identical to `packages/api`'s rather than reaching for either
cheap escape. Omitting the option is not the same thing as setting it: an absent
`sessionIdGenerator` is indistinguishable from a forgotten one, so the stateless mode
would silently depend on a reader noticing an omission, and the sibling's running copy
is the proof that the explicit value is the right one. Loosening
`exactOptionalPropertyTypes` for this package would buy two casts back at the cost of
every other optional property under `packages/llmwiki-kg/ts/src`, which is a far worse
trade than two documented assertions at the SDK edge.

## The wiki's real shape: two entrypoints, not one process on both transports

The wiki does **not** serve stdio and HTTP MCP from one process. Measured:

| Transport       | Where it lives                                                  | How it is reached                                                                                       |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| HTTP, `POST /mcp` | `packages/api/src/host/mcp-http.ts`                            | path test `isMcpHttpPath` (`packages/api/src/host/mcp-http.ts:97`), called from the host dispatcher at `packages/api/src/host/server.ts:305` |
| stdio           | `startMCPServer` from `@repo/wiki/mcp`                          | a **separate subcommand**, imported at `packages/api/src/main.ts:71` and invoked at `packages/api/src/main.ts:321` |

The two are different commands, not two listeners inside one command. The launcher's
own usage text says so: `packages/api/src/main.ts:111` describes `host` as the
unified HTTP listener, and `packages/api/src/main.ts:112` describes `serve` as
starting "an MCP server exposing wiki tools and resources over stdio". A `serve`
process binds no port; a `host` process speaks MCP over the socket it already owns.

The HTTP path is single-sourced. `MCP_HTTP_PATH = "/mcp"` is declared at
`packages/api/src/host/mcp-http.ts:63` and `isMcpHttpPath`
(`packages/api/src/host/mcp-http.ts:97`) compares against that constant with the
query string stripped, so the mount and the check cannot drift apart. The handler it
dispatches to, `handleMcpHttp` (`packages/api/src/host/mcp-http.ts:140`), receives
its server factory as a parameter rather than importing `../mcp/**`, which is a cycle
guard — a detail about imports, not about the transport shape.

**Why this paragraph exists.** A one-process-both-transports shape was asserted as
the model to copy. It does not exist in this code, so copying it would have meant
inventing a shape and then calling the result parity. A shape that is believed but
never checked is worse than an absent one, because it is used as a reference. Start
from the table above.

## Auth: `requireApiKey` on the KG `/mcp`, and the divergence is deliberate

Every KG route is authenticated except the liveness probe. Each router factory
defaults its `apiKey` collaborator to the process-wide `requireApiKey`:

| Router                     | Default                      |
| -------------------------- | ---------------------------- |
| `stacks.ts`                | `packages/llmwiki-kg/ts/src/routes/stacks.ts:515` |
| `stack_graph.ts`           | `packages/llmwiki-kg/ts/src/routes/stack_graph.ts:177` |
| `aks.ts`                   | `packages/llmwiki-kg/ts/src/routes/aks.ts:46` |
| `documents/router.ts`      | `packages/llmwiki-kg/ts/src/routes/documents/router.ts:29` |
| `ingest/router.ts`         | `packages/llmwiki-kg/ts/src/routes/ingest/router.ts:71` |
| `pages/router.ts`          | `packages/llmwiki-kg/ts/src/routes/pages/router.ts:30` |
| `synthesize/router.ts`     | `packages/llmwiki-kg/ts/src/routes/synthesize/router.ts:32` |
| `backfeed/router.ts`       | `packages/llmwiki-kg/ts/src/routes/backfeed/router.ts:32` |

`/health` is the only exception, installed outside any router at
`packages/llmwiki-kg/ts/src/server.ts:196`; the comment at
`packages/llmwiki-kg/ts/src/server.ts:194` states the property plainly: "Liveness
probe: no auth". `requireApiKey` itself is
`packages/llmwiki-kg/ts/src/auth.ts:74`, built by `createRequireApiKey`
(`packages/llmwiki-kg/ts/src/auth.ts:46`), and its refusal is the shared shape:
`401` with `{"detail":"Invalid or missing API key. Provide it in the X-API-Key
header."}` (`packages/llmwiki-kg/ts/src/auth.ts:63`, message at
`packages/llmwiki-kg/ts/src/auth.ts:20-21`).

The wiki's `/mcp` is **unauthenticated**. The dispatch at
`packages/api/src/host/server.ts:305` hands the request straight to `handleMcpHttp`
with no credential check, and `handleMcpHttp`
(`packages/api/src/host/mcp-http.ts:140`) reads only the method and the body — no
header is inspected on that path.

**KG `/mcp` therefore uses `requireApiKey` on purpose. That is a divergence from the
wiki, not an inconsistency to be fixed later.** The reason: an unauthenticated
`/mcp` would expose `get_entities` and `traverse_stack` — graph reads over the whole
Stack — to anyone who can reach the port. Those two handlers proxy
`/aks/v1/entities` (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:324`) and
`/aks/v1/traverse` (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:279`) with no
per-caller scoping. Copying the wiki shape here would spread that defect under the
name of consistency, and parity is not worth a security regression.

One deployment consequence belongs with this decision: `requireApiKey` is
**pass-through when no key is configured**. `authEnabled` is derived as
"`AKS_API_KEY` is not empty" (`packages/llmwiki-kg/ts/src/config.ts:135`), and the
middleware calls `next()` without inspecting the header when it is false
(`packages/llmwiki-kg/ts/src/auth.ts:52-56`). `AKS_API_KEY` must actually be set in a
deployment for this guard to mean anything: an unset key is not a guard that fails,
it is no guard at all.

## Deployment observation: three provider-free tools inherit a provider boot gate

`packages/llmwiki-kg/ts/src/index.ts:29` runs `validateConfig(config)` inside a `try`
and exits the process on failure; the listener is bound afterwards, at
`packages/llmwiki-kg/ts/src/index.ts:38`. The comment at
`packages/llmwiki-kg/ts/src/index.ts:24-27` gives the reason — fail fast before the
socket is bound, mirroring the Python oracle's lifespan hook.

`validateConfig` (`packages/llmwiki-kg/ts/src/config.ts:145`) performs five checks
(`packages/llmwiki-kg/ts/src/config.ts:146-176`), each of the form "a provider is
selected but the credential for it is empty". **It checks presence; it does not call
a provider.** A credential that is present and wrong passes this gate.

Three of the four MCP tools call no provider at all — they read the graph through the
HTTP API: `get_entities` proxies `/aks/v1/entities`
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:324`), `traverse_stack` proxies
`/aks/v1/traverse` (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:279`), and
`list_stacks` proxies `/stacks` (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:369`).
Those three therefore inherit a boot gate they do not need: a missing provider
credential makes the process refuse to start, so graph reads that never touch a
provider are unavailable as well.

**Recorded, not fixed.** Making the check lazy would change boot semantics that
`packages/llmwiki-kg/ts/src/config.test.ts:190` pins as a throwing contract — it
asserts both the throw and its message (`packages/llmwiki-kg/ts/src/config.test.ts:272-273`).
That is not a zero-cost change, so it is an observation for a separate decision
rather than something folded into this one.

## Verifying it

The acceptance criterion has two parts, and the second is the one that catches a
wrong answer: enumerate **exactly four** tools — `query_stack`, `traverse_stack`,
`get_entities`, `list_stacks` (`packages/llmwiki-kg/ts/src/mcp/tools.ts:81`, `:109`,
`:142`, `:175`) — **and** issue one real `tools/call` on `list_stacks` that succeeds
end to end.

Enumeration alone is not evidence. A stdio-only entrypoint enumerates the same four
tools while every call fails, because all four are HTTP clients of the KG API and
`AKS_BASE_URL` defaults to `http://localhost:8000`
(`packages/llmwiki-kg/ts/src/mcp/config.ts:11`): a transport that does not live inside
the process listening on 8000 has nowhere to send its requests. `list_stacks` is the
call to make because it hits `/stacks`, reads the graph, and needs no spend.

The negative control for that route costs more than a footnote: an unmatched path such
as `/mcp-nope` must answer the router-never-ran body `{"detail":"Not Found"}`, and that
answer only means something because `/mcp/mcp` and `/mcp/<anything>` were briefly served
while the mount was a prefix and are now unrouted by the exact-path route
(`packages/llmwiki-kg/ts/src/kg-app.test.ts:319-334`), which is why the probe path is
chosen unlike `/mcp` rather than beside it.
