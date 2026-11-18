# The KG MCP surface: one published image, one `/mcp` policy, and the shapes this is not

Maintainer reference. This page is repo-facing (plain `.md`, not published on the
Mintlify site) and exists because several shapes were asserted in review that the code
does not have. It records the real shape of the surface the repository publishes, the one
authentication policy that surface carries, the listener `serve` mode binds for itself,
and the second Dockerfile that ships nowhere.

Every claim below is cited by `path:line`. Where a claim is not cited, this page does
not assert it.

## One published image, two modes, one endpoint

The repository publishes **exactly one** container image, the root `Dockerfile` (226
lines, three stages — `FROM … AS build` at `:47`, `prod-deps` at `:113`, `runtime` at
`:148`). It documents one port, `EXPOSE 4173` (`Dockerfile:214`), and one entrypoint,
`ENTRYPOINT ["/usr/local/bin/entry.sh"]` (`Dockerfile:226`).

`docker/entry.sh:91-104` turns that entrypoint into two modes and nothing else:

| How it is started             | What runs                                                              | What is served                                    |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `docker run <tag>` (default)  | `node /app/dist/api.js serve` (`docker/entry.sh:104`)                   | MCP over **stdio** — the union of all 17 tools    |
| `LLMWIKI_MODE=host`           | `node /app/dist/api.js host --port $LLMWIKI_PORT` (`:84`, `:86`)        | viewer + graph + MCP at `/mcp`, default `4173` (`:81`) |
| an explicit command           | run verbatim (`docker/entry.sh:91-95`)                                  | whatever that command serves                      |

Both modes start from one function, `createUnionMcpServer`
(`packages/api/src/host/mcp-union.ts:93`): the wiki's own server plus
`registerKgToolsOn`. An image that advertises one tool set over stdio and another over
HTTP is the defect this shape exists to close, one transport at a time.

**How each mode finds its database, and which name wins.** The operator is told to publish
`AKS_DATABASE_URL`, while the graph routes read `DATABASE_URL`
(`packages/llmwiki-kg/ts/src/config.ts:74`) and so does `scripts/apply-schemas.sh:60`. Nothing
joined the two names, and the consequence was measured on the built image with only
`AKS_DATABASE_URL` set: `/health` 200, `GET /stacks` 500, and the schema runner exiting 2 with
`error: no target. Pass a connection string or set DATABASE_URL.` `docker/entry.sh:45` now carries
`export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"` — the same preserving bridge the
reference recipe has. **An explicit `DATABASE_URL` always wins**; a blank or unset one falls back
to `AKS_DATABASE_URL`; a blank pair stays blank (the reference recipe's own decision) rather than
inventing a DSN, so no connection string is baked into the image. It stands above the explicit
command branch (`:94`) and above the mode dispatch (`:98`) because the image runs its own schema
runner through that branch.

**A blank `DATABASE_URL` is not the same as an unset one, and nothing here fixes that.** The graph
layer's schema entry is a plain `.default()` (`packages/llmwiki-kg/ts/src/config.ts:74`), which fires
only on `undefined`, so a present-and-empty `DATABASE_URL` reaches the graph layer as the empty string:
it attempts that DSN and answers a generic `500 Internal Server Error`, with nothing on stderr naming
the failure, because the graph layer has no file mode to fall back to. The wiki dimensions'
file-versus-database decision is untouched by that — it is keyed to `AKS_DATABASE_URL` alone
(`packages/wiki/src/dimensions/activation.ts:168-170`, its one use in
`packages/wiki/src/dimensions/stack-authority.ts:134`) and never reads `DATABASE_URL` — so a blank
`DATABASE_URL` cannot flip a deployment to file-backed. Measured on the same `dist/api.js` and the same
tree, `DATABASE_URL` unset versus set to `""`: identical boot, `/health` 200 with an identical body,
`GET /stacks` 500 `Internal Server Error`, and a `serve` graph call answering
`AKS server returned 500: Internal Server Error` either way. A running process cannot tell the two
apart, and this page records that rather than claiming a repair that was not made.

**The second Dockerfile is not a deliverable.** `packages/llmwiki-kg/Dockerfile` and
`packages/llmwiki-kg/docker/` remain in the tree as a reference build that ships nowhere;
`createKgApp()` at `packages/llmwiki-kg/ts/src/index.ts:41` remains as a standalone
composition for tests, not a deliverable. The section
[The second recipe](#the-second-recipe-a-reference-build-that-ships-nowhere) below says
what that means precisely.

## The union: 17 tools, and `list_stacks` answered by the wiki

The surface is the union of the wiki's 14 tools and the graph's four, minus the name both
declare: **17 names**, with `list_stacks` advertised **once**.

The collision is resolved by name, not by ordering. `UNION_YIELDS_TO_WIKI` is the single
literal `"list_stacks"` (`packages/llmwiki-kg/ts/src/mcp/union.ts:53`), and the graph's
contribution is `MCP_TOOLS` filtered on it (`packages/llmwiki-kg/ts/src/mcp/union.ts:62-63`),
so `query_stack`, `traverse_stack` and `get_entities` join the surface while the graph's
`list_stacks` does not. The **wiki** implementation answers, for three reasons:

1. The 14 existing tools must not change behaviour, and the client that already talks to
   this image is calling the wiki's `list_stacks`.
2. The wiki implementation reads the wiki stack store the client already sees; the graph
   one proxies `GET ${baseUrl}/stacks`
   (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:369`), an HTTP hop per listing.
3. That hop would also make a listing depend on the graph REST surface being up, which S7
   exists to prevent.

The graph's own `list_stacks` stays registered on the standalone graph server; only this
surface yields it. A duplicated name in one `tools/list` is a defect — the client cannot
tell which implementation answers — so the exclusion happens at the source rather than by
de-duplicating the reply.

## One `/mcp`, one auth policy, and the operator consequence

A single endpoint cannot carry two policies, so the one `/mcp` carries the graph's:
`X-API-Key`. The policy is the graph package's own middleware, not a copy of it —
`apiKeyPolicy` is `createRequireApiKey(kgConfig)` (`packages/api/src/host/mcp-http.ts:144`),
bound factory declared at `packages/llmwiki-kg/ts/src/auth.ts:46`. `packages/api` declares
no `express`, so the Express surface the middleware needs is a two-method facade
(`status`, `json`) over the real `ServerResponse`
(`packages/api/src/host/mcp-http.ts:165-177`); the refusal body is therefore
`auth.ts`'s own bytes and cannot drift from it.

Enforcement is the **first statement** of `handleMcpHttp`
(`packages/api/src/host/mcp-http.ts:238`), through `admitApiKey`
(`packages/api/src/host/mcp-http.ts:186-193`) — before any method handling and before any
body is parsed, so a refused caller learns nothing about the surface, not even which
methods it accepts. The refusal is `401` with
`{"detail":"Invalid or missing API key. Provide it in the X-API-Key header."}`
(`packages/llmwiki-kg/ts/src/auth.ts:63`, status at `:23`, message at `:20-21`).
`handleMcpHttp` is reached only under `isMcpHttpPath(req.url)`
(`packages/api/src/host/server.ts:628`; the predicate is
`packages/api/src/host/mcp-http.ts:126-129`), so no other route changed.

**The pass-through default is the graph's, unchanged.** `authEnabled` is derived as
"`AKS_API_KEY` is not empty" (`packages/llmwiki-kg/ts/src/config.ts:316`, field at `:144`),
and the middleware calls `next()` without inspecting the header when it is false
(`packages/llmwiki-kg/ts/src/auth.ts:52-56`). So:

| `AKS_API_KEY` | `/mcp` behaviour                                                    |
| ------------- | ------------------------------------------------------------------- |
| unset / empty | **pass-through**: every request is served, no header inspected      |
| set           | the header is **required**; missing or wrong both answer the `401` above |

**The consequence, stated plainly and never silently:** an operator who sets `AKS_API_KEY`
now needs `X-API-Key` for the **streamable-HTTP wiki tools too**, because one endpoint
cannot carry two policies. Before this change the wiki `/mcp` inspected no header at all.
stdio (`serve`, the container's default mode) is unaffected — there are no headers on that
transport, so there is nothing for the policy to inspect. `/health` is unaffected as well:
it is a graph route outside `isMcpHttpPath`.

Measured, six request outcomes against a spawned `dist/api.js host --port 0`
(`test/mcp/mcp-auth-policy.test.ts`, 6/6): no header with a key configured → `401` with
those exact bytes; correct header → `200` and the whole 17-name union; **wrong** header →
the same `401` and the same bytes (so the check is real rather than "a header is present");
`/health` without a header in the same child → `200`; no key configured → `200` and the
union; stdio `serve` with a key configured → the union, unaffected.

## `serve` (stdio): the graph listener the process binds for itself

The graph tools are HTTP clients of a graph API
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:165-169` declares their whole dependency
surface: `baseUrl`, `apiKey`, `fetchImpl` — no pool, no database handle). A stdio process
that bound nothing would advertise three tools whose every call died at a socket, so
`serve` binds one itself: `startGraphListener`
(`packages/api/src/host/mcp-union.ts:220-241`) mounts `createApp()` alone on a loopback
address (`:229` binds port `0`, `:247` is `127.0.0.1`) and dispatches **only**
`/aks/v1` (`packages/api/src/host/mcp-union.ts:184`, predicate at `:192-196`), so the graph
app's write routes (`/documents`, `/ingest`, `/synthesize`, `POST /stacks`) are not
published on a port `serve` opened on its own initiative.

Three properties are structural rather than configured:

- **The announcement goes to stderr**, never stdout: in this mode stdout IS the protocol
  channel. The line is
  `[kg] serving the graph tools from http://127.0.0.1:<port>`
  (`packages/api/src/main.ts:423`), and stdout stays parseable JSON-RPC byte for byte.
- **An explicit `AKS_BASE_URL` still wins and binds nothing.** `configuredKgBaseUrl`
  (`packages/api/src/host/mcp-union.ts:156`) is the single reader of that rule and
  `selfServedKgBaseUrl` refuses to answer when it is set
  (`packages/api/src/host/mcp-union.ts:175-183`), so an operator naming an external graph
  API gets no listener and no announcement.
- **The listener dies with the session.** It is closed on stdin `end`
  (`packages/api/src/host/mcp-union.ts:128-148`), not on the transport's `onclose`, which
  the SDK's stdio transport fires only from its own `close()`. Without that hook the
  process keeps an open handle and `serve` stops exiting 0 when its client closes stdin.

**What a graph tool answers with no usable database** is
`AKS server returned 500: Internal Server Error`, as plain text and **without** a tool-level
`isError` flag. That is the honest outcome for a deployment with no Postgres: the graph
route ran in the same process and failed on its database. The missing flag is the graph's
ported behaviour for a non-200 response, not a defect introduced by this composition.

Registering the graph tools touches nothing at boot: it converts each tool's own
`inputSchema` and installs handlers, opens no connection and resolves no Stack. A tool that
needs a backend fails per **call**, and only its own call.

## The second recipe: a reference build that ships nowhere

`packages/llmwiki-kg/Dockerfile` (140 lines, `EXPOSE 8000` at `:117`,
`CMD ["node", "packages/llmwiki-kg/ts/dist/index.js"]` at `:140`) and
`packages/llmwiki-kg/docker/` are **a reference build, not a deliverable**: nothing pushes
them, no tag names them, and the published `linux/amd64` artifact is the root image only.

The evidence for that verdict, cited rather than assumed:

- **No workflow pushes any image.** `publish.yml` publishes the npm package through OIDC
  Trusted Publishing and touches no registry; `ci.yml` builds and runs containers and
  pushes nothing.
- `urgosxd7/llmwiki:latest` appears exactly twice in the repository, both in
  `docker-compose.hub.yml:47` and `:60`. Publishing an image is a human step.
- `createKgApp()` at `packages/llmwiki-kg/ts/src/index.ts:41` stays as a **test
  composition** — `packages/llmwiki-kg/ts/src/kg-app.test.ts` mounts it directly — and is
  not the entrypoint of any published artifact.

CI still builds and boots that recipe
(`.github/scripts/docker-images-check.sh`, second check), because an abandoned Dockerfile
rots into one that does not build, and a green pipeline would not notice. **That check is
about the tree, not about the product**, and no wording anywhere may call the recipe shipped
or published.

Retiring the file, its `docker/` directory and the remaining references is tracked work,
not a silent omission: the list of what still names it — including
`test/artifact/kg-container-entry.test.ts`, `test/package-selection-union.test.ts`,
`packages/llmwiki-kg/docker-compose.yml:23-25`, `packages/llmwiki-kg/README.md:76,565-566`,
`docs/turborepo.md` and the recipe's own `packages/llmwiki-kg/Dockerfile:5` "WHY BOTH
EXIST" comment — is recorded in `odd/tasks/one-image-both-mcp-surfaces.md`, L7.

## Why the mount cannot live inside `createApp` (the reference composition)

The reasoning below is about `createKgApp`, which the published image does **not** run. It
is kept because it explains the shape of the reference composition and because the same
property decides where a self-served graph listener can mount.

`installFallbacks` (`packages/llmwiki-kg/ts/src/server.ts:247`) appends a terminal handler
at `packages/llmwiki-kg/ts/src/server.ts:250-252`:

```ts
app.use((_req: Request, res: Response) => {
  res.status(404).json({ detail: "Not Found" });
});
```

That handler is pathless, so it matches every request Express has not already answered,
and it **responds** rather than calling `next()`. It is installed at
`packages/llmwiki-kg/ts/src/server.ts:320`, two lines before `createApp` returns
(`:322`).

**So any route appended to the returned app is unreachable**: the catch-all answers first.
A mount added to the result of `createApp()` would answer `{"detail":"Not Found"}` exactly
like a path that was never mounted, and the defect would present as "the mount did not
work" rather than "the mount was installed one step too late". `createKgApp` is therefore
an outer app that claims `/mcp` before delegating every other path to `createApp()`
(`packages/llmwiki-kg/ts/src/app.ts:78`, the `/mcp` registration at `:81-87`, the
delegation at `:88`).

That is also why the published image's `serve` mode mounts `createApp()` on its **own**
listener instead of appending a route to it: `packages/api/src/host/server.ts:67` imports
`createApp` from `@repo/kg/server` and `createGraphApp` returns it unmodified
(`packages/api/src/host/server.ts:578-579`), so anything changed inside it would land in
the wiki's listener too.

### The composed app: `/mcp` is claimed before the inner app sees anything

`createKgApp` (`packages/llmwiki-kg/ts/src/app.ts:78`) is two registrations and nothing
else:

1. `app.all(MCP_HTTP_PATH, guard, express.json({ strict: false }), handler, mcpErrorHandler)`
   at `packages/llmwiki-kg/ts/src/app.ts:81-87` claims the **exact path** `/mcp` with its
   own guard, its own parser, the MCP handler and the chain's own error middleware.
2. `app.use(createApp(...))` at `packages/llmwiki-kg/ts/src/app.ts:88` hands every other
   path — all of them, because an `/mcp` request is answered inside the chain above and
   never falls through — to the untouched inner app.

Order is the whole contract. The route is registered first, so an `/mcp` request is
answered there and never falls through to the inner app's catch-all; every other path skips
it entirely and keeps the inner app's middleware, routers, `404` body and error handler
exactly as the existing suite pins them. `/mcp` requests also never reach the inner body
parser, so no request is parsed twice.

### A route, not a prefix — and `all`, not `post`

Both halves of that first registration are deliberate, and each was measured on the built
image after a working version had got it wrong.

**A route, not a prefix mount.** `app.use("/mcp", …)` prefix-matches, so it also claims
`/mcp/mcp` and `/mcp/<anything>`. Measured against the pre-fix build, `POST /mcp/mcp`
with a valid key answered `406` carrying the SDK's own envelope —
`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must
accept text/event-stream"}}` — which means the MCP chain ran, where the pre-branch build
had answered `404`. The exact-path route answers `404 {"detail":"Not Found"}` for
`/mcp/mcp` and `/mcp/<anything>`, identical to any path no router knows, and the test
`does not claim /mcp/mcp: only the exact path is served`
(`packages/llmwiki-kg/ts/src/kg-app.test.ts:129`) compares the nested path against a
non-KG route inside the same test, so the assertion is "the MCP handler never ran" rather
than a literal string.

**`all`, not `post`.** The Streamable HTTP transport answers three methods on the one
path: `POST` carries JSON-RPC requests, `GET` opens the server-sent-event stream replies
are streamed over, and `DELETE` ends a session. A `POST`-only route never enters the
chain for the other two methods at all, so the SSE stream would be silently dropped —
no error, just a client that waits forever — and session teardown would answer as an
unmounted path. That is why the registration is `app.all`, and
`still serves GET and DELETE, the transport's SSE and session methods`
(`packages/llmwiki-kg/ts/src/kg-app.test.ts:145`) pins both.

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
4xx/5xx `detail` — never `err.message`, never a stack, never HTML. Re-measured after the
fix: `400`, `application/json; charset=utf-8`, body exactly
`{"detail":"Invalid JSON body"}`, and no `SyntaxError`, no `node_modules`, no stack frame.
`is answered with the KG error envelope, never an HTML stack trace`
(`packages/llmwiki-kg/ts/src/kg-app.test.ts:72`) asserts that envelope and each of those
absences.

**Why this is spelled out.** The middleware does not explain itself. An error handler
whose only visible job is saying "Bad Request" reads like ceremony, and the obvious next
move — delete it, nothing reaches it — restores the HTML stack page on the one input
that does.

### The transport is stateless, and there is no session map on purpose

`MCP_HTTP_PATH = "/mcp"` is declared once, at `packages/llmwiki-kg/ts/src/mcp/http.ts:58`,
so the mount and any client constant cannot drift. Each request runs `answerMcpRequest`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:111-128`), which builds a fresh server with
`createMcpServer` (`:116`), constructs one `StreamableHTTPServerTransport` from
`STATELESS_OPTIONS` (`:117`, constant at `:79-81` — the SDK's documented stateless mode),
hands the already-parsed `req.body` to `handleRequest` (`:122`), and closes the server in
`finally` (`:126`).

**There is no session map in this module, and that absence is the design.** A session map
would be per-process memory, so the moment two replicas sit behind one load balancer a
client's second request lands on a process that never saw its `initialize`. Stateless
costs one re-initialization per request and makes the listener answerable by any number of
callers without coordination; `server.close()` in the `finally` is what stops a per-request
server from leaking its transport listeners after the reply is already written.

The published surface's HTTP handler follows the same shape in `packages/api`; the
substantive difference is where the body comes from — this module calls no body
middleware, so the wiki handler reads JSON itself, while here `express.json` has already
parsed it. A rejection from the handler itself is forwarded with `next`
(`packages/llmwiki-kg/ts/src/mcp/http.ts:147`) rather than answered inline, so a
transport-level failure reaches the same envelope.

### The typing boundary: two named assertions, at one edge

`packages/llmwiki-kg/ts/tsconfig.json:17` enables `exactOptionalPropertyTypes`. The root
config that compiles `packages/api` does not (`tsconfig.json:2-19`; it sets `strict` at
`tsconfig.json:6` and nothing finer), which is why `packages/api/src/host/mcp-http.ts:256`
can spell `{ sessionIdGenerator: undefined }` inline while this package cannot. The
installed SDK declares the option as `sessionIdGenerator?: () => string`
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

## Deployment observation: the provider-free tools inherit a provider boot gate

`packages/llmwiki-kg/ts/src/index.ts:33` runs `validateConfig(config)` inside a `try`
(`:34` is the call) and exits the process on failure (`:38`); the listener is bound
afterwards, at `packages/llmwiki-kg/ts/src/index.ts:69`. `validateConfig`
(`packages/llmwiki-kg/ts/src/config.ts:335`) performs five checks, each of the form "a
provider is selected but the credential for it is empty". **It checks presence; it does
not call a provider.** A credential that is present and wrong passes this gate.

Three of the graph's four MCP tools call no provider at all — they read the graph through
the HTTP API: `get_entities` proxies `/aks/v1/entities`
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:324`), `traverse_stack` proxies
`/aks/v1/traverse` (`packages/llmwiki-kg/ts/src/mcp/handlers.ts:279`), and
`list_stacks` proxies `/stacks`
(`packages/llmwiki-kg/ts/src/mcp/handlers.ts:369`). Those three therefore inherit a boot
gate they do not need.

**This applies to the reference composition only** — the published image starts
`dist/api.js`, which does not run `validateConfig` — and it is **recorded, not fixed**.
Making the check lazy would change boot semantics that
`packages/llmwiki-kg/ts/src/config.test.ts:416-417` pins as a throwing contract, which is
not a zero-cost change and is a decision for whoever retires the recipe.

## Verifying the published surface

The acceptance criterion has two parts, and the second one is the one that catches a
wrong answer:

1. `tools/list` on the **built artifact** enumerates the 17 names, with `list_stacks` once
   — the count and the exact set, not "more than 14".
2. One real `tools/call` succeeds end to end through the same transport a client uses.

Enumeration alone is not evidence: a surface can advertise a tool whose every call dies at
a socket, which is exactly what `serve` mode did before it bound its own graph listener.
The suite that holds both here is `test/mcp/one-image-both-mcp-surfaces.test.ts` (the
union against the built distribution), `test/mcp/stdio-self-served-kg.test.ts` (the
self-served listener, its stderr announcement, and an `AKS_BASE_URL` that wins and binds
nothing) and `test/mcp/mcp-auth-policy.test.ts` (the six request outcomes above). The
container-level gate is `.github/scripts/docker-images-check.sh`: it runs the built root
image in `host` mode against the viewer's origin gate and in `serve` mode over one stdio
MCP session, asserting `initialize` and then that `tools/list` advertises all 17 names with
`list_stacks` exactly once.

A negative control belongs with that: an unmatched path such as `/mcp-nope` must answer
the router-never-ran body `{"detail":"Not Found"}`, which is what
`packages/llmwiki-kg/ts/src/kg-app.test.ts:129` asserts for `/mcp/mcp`.
