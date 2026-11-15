# Split the gateway endpoint so chat and embeddings can name different hosts

Feature branch `fix/gateway-embeddings-base-url`. One `GATEWAY_URL` currently resolves both the chat
completions endpoint and the embeddings endpoint, so one variable names two services. This feature adds
per-concern overrides that inherit the old variables when unset.

## Specs

**S1 — Two hosts resolve independently.** A chat request and an embedding request resolve to different
base URLs when both variables are set, and each reaches its own host. Verbatim from the assignment:
"**A chat request and an embedding request resolve to different base URLs** when both variables are set,
and each reaches its own host. Assert the resolved URL, not just the absence of an error."

**S2 — The old single-variable behaviour is pinned.** Verbatim: "**The previous single-variable behaviour
is pinned**: with only the old variable set, both resolve exactly as they do today. **Every existing
deployment uses this path** — a change here that nobody asked for is a regression."

**S3 — The new base-URL variable is `GATEWAY_EMBEDDINGS_BASE_URL`.** Decision D1. It takes the
`<PROVIDER>_EMBEDDINGS_BASE_URL` shape already shipped as `OPENAI_EMBEDDINGS_BASE_URL`
(`packages/wiki/src/utils/embedding-provider.ts:59`, `packages/wiki/src/utils/provider.ts:154`,
documented at `docs/configuration/environment-variables.mdx:73` and expressed in compose as
`${OPENAI_EMBEDDINGS_BASE_URL:-${OPENAI_BASE_URL}}` at `docker-compose.yml:133`). Inventing a second
convention beside a documented one is how a configuration becomes unlearnable. When unset, the gateway
embeddings endpoint resolves from `GATEWAY_URL`.

**S4 — The new credential variable is `GATEWAY_EMBEDDINGS_API_KEY`.** Decision D4, Option A, verbatim:
"Add `GATEWAY_EMBEDDINGS_API_KEY` in this assignment, inheriting `GATEWAY_API_KEY` when unset, mirroring
the URL exactly." Rationale, verbatim: "the owner's key goes to a host it does not belong to. That is the
incident that happened in this session an hour ago — a credential transmitted to a host that was never
meant to see it — and a URL-only split reproduces it one layer lower, with a different error code and a
quieter log. A `401` from the wrong host reads as 'the key is bad', which sends whoever debugs it to
rotate a working credential." Two variables, one behaviour, one explanation.

**S5 — Unset means inherit, and the inheritance is stated at startup.** Decision D2. When the new
variables are unset, behaviour is byte-identical to today, so no existing deployment changes on upgrade.
The resolved *source variable name* is logged once at startup — name only, never a value and never a
substring of one — so the inheritance is observed rather than inferred. Constraints, verbatim: "The
variable *name*, never a value, and never a substring of one." / "Once at startup, not per request." /
"It must not become a log that grows with configuration. One line naming the source, or nothing."

**S6 — Nothing is appended to `KG_BRIDGED_VARIABLES`.** `shared-provider-conformance.test.ts:229`
asserts that list has literal length 5. Appending a name fails the suite with a message that points at a
conformance test rather than at the variable appended. A KG-only variable that the bridge never fills is
ignored by that test.

**S7 — Published contract surfaces are updated.** A new variable is not real until it is registered:
`packages/llmwiki-kg/ts/src/config.ts` (EnvSchema, default `""` plus trim, mirroring `GATEWAY_URL` at
`:87`), the compose `environment:` allowlists (`docker-compose.yml`, `docker-compose.hub.yml`,
`packages/llmwiki-kg/docker-compose.yml`), the tracked example env files, and the two operator tables at
`docs/configuration/environment-variables.mdx:73` and `:345`. House style for a fallback relationship is
one sentence ending "When unset, X uses Y".

**S8 — Validation keeps refusing a blank resolved endpoint.** `validateConfig` (`config.ts:145-173`)
throws when the `gateway` provider's *resolved* URL or key is blank. Absence stays caught after
resolution, which is where it matters; the new variables do not weaken it.

**S9 — The `api.openai.com` constant is out of scope.** Deliberately untouched. Decision D3, verbatim:
"The constant's defect is *destination and credential egress*; the split fixes *reachability*." Different
blast radius, different spec, different test matrix over the four provider/branch combinations.

## Tasks

- **T1** — RED: tests for S1 and S2 that assert resolved endpoints (`extractionEndpoint().endpoint` vs
  `embeddingEndpoint().endpoint`) and the gateway arms' resolved API key, through a scripted double or
  local `.invalid` host. Route: `gentle-ai-worker`. Commit: pending.
- **T2** — S3, S4, S6, S8: add both schema entries, resolve the embeddings gateway arm from the new
  variables with inheritance, leave the chat arm on `GATEWAY_URL`/`GATEWAY_API_KEY`. Route:
  `gentle-ai-worker`. Commit: pending.
- **T3** — S5: one startup line naming the source variable, once, value-free. Route: `gentle-ai-worker`.
  Commit: pending.
- **T4** — S7: compose allowlists, example env files, the two docs tables. Route: `gentle-ai-worker`.
  Commit: pending.
- **T5** — Gates with Node 24 PATH (`gates:static`, `build`, `test:affected`) and the work-unit commit.
  Route: `gentle-ai-worker`. Commit: pending.

## Log

**L1 — the assignment, verbatim (excerpt: this feature's share).**
"Project assignment for branch fix/gateway-embeddings-base-url: Split one configuration knob that
currently describes two services, so chat and embeddings can resolve to different base URLs. [...]
**A separate base-URL variable for embeddings**, so one variable stops naming two hosts. The existing
single-variable behaviour must keep working unchanged for every deployment that uses it."

**L2 — test-first requirement, verbatim.**
"1. **A chat request and an embedding request resolve to different base URLs** when both variables are
set, and each reaches its own host. Assert the resolved URL, not just the absence of an error. 2. **The
previous single-variable behaviour is pinned**: with only the old variable set, both resolve exactly as
they do today. **Every existing deployment uses this path** — a change here that nobody asked for is a
regression."

**L3 — hard constraints, verbatim.**
"**Never print a connection string, URL value, token or key.** Report host *variable names*, never
values, and presence booleans only. [...] **Do not rotate, read or test the owner's real credentials.**
[...] **Use a scripted double or a local endpoint for every test.** [...] **Pin provider-selecting
environment variables in your own commands.** [...] **Do not start or stop the `kg-mcp-live` container.**
Do not contact the `aks` database." Node 24 PATH for gates and commits:
`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.

**L4 — Manager ratification, verbatim.**
"D1 accepted. D2 accepted including the concession. D3 accepted. D4: Option A — add the credential in
this assignment." On D1: "**And the `KG_BRIDGED_VARIABLES` warning is the single most valuable line in
this report.** [...] **You found it before it fired. Keep that sentence in the commit message.**" On D1's
falsifier: "**Record the falsifier, not just the choice.**" Recorded: if the wiki side ever gains a
`gateway` provider, its `endpointVar` must be this exact string. It cannot be today:
`EMBEDDING_CREDENTIALS` (`packages/wiki/src/utils/embedding-provider.ts:56-63`) has six keys and
`gateway` is not among them.

**L5 — observation, deferred, not fixed here.** `EMBEDDING_ENDPOINT_VARS`
(`packages/wiki/src/utils/embedding-provider.ts:88-94`) has no `gateway` entry, so endpoint drift between
two gateway hosts is not fingerprinted. Verbatim: "record ... as an observation on this branch, not a
fix. It belongs with the model/dimension mismatch work, and putting it here would make this diff answer
two questions."

**L6 — S5 wired, and the first executed RED/GREEN of this feature (worker `g1-wire-startup-line`).**

S5 is now a delivered concession rather than a library function with no caller. `packages/llmwiki-kg/ts/src/index.ts`
imports `gatewayEmbeddingsSourceLine`, resolves it once before `listen()`, and renders it as one conditional
line inside the existing banner:

```ts
const embeddingsSourceLine = gatewayEmbeddingsSourceLine(config);
// ...
...(embeddingsSourceLine === undefined ? [] : [`  ${embeddingsSourceLine}`]),
```

Variable NAMES only, once at startup, fixed size, and nothing at all for a non-`gateway` embedding provider.
`grep -rn gatewayEmbeddingsSourceLine packages/llmwiki-kg/ts/src` shows the production caller count going 0 -> 1.

RED, observed NOT by stashing or reverting this tree but in a detached scratch worktree at `521fc9bf` with only
the two test files copied in: the `S1` case failed with
`Received { apiKey: "chat-key", endpoint: "https://chat.invalid/api/v1/embeddings" }` against the expected
embeddings host, i.e. HEAD sends embeddings to the chat host. Totals there: `Tests 17 failed | 28 passed (45)`,
`EXIT=1`. The S2 pin passed at HEAD by construction, exactly as the assignment predicted.

GREEN, this tree: `Tests 45 passed (45)`, `EXIT=0`. `typecheck:kg` `EXIT=0` (367 files, no regression) and
`typecheck:tests` `EXIT=0` (1607 files, 238 baselined diagnostics, no regression).

Two defects in the dead writer's `config.test.ts` were repaired so the spec could be judged at all: the S8 block
passed an already-parsed `Config` back into `parseConfig` (a `ZodError` on the numeric `EMBEDDING_DIM`, raised
before `validateConfig` ran), and its "no credential behind it" case inherited `GATEWAY_API_KEY` from the shared
helper, so it could never refuse. The wiki-bridge case now unstubs an ambient `EMBEDDING_PROVIDER` instead of
depending on the caller's shell; a pinned provider selector in a gate command is precisely the safety rule that
must not be traded for a green test.

Wiring proof, deliberately not committed: a disposable copy of `index.ts`/`config.ts` with `createKgApp`'s
`listen` stubbed showed the banner printing `endpoint GATEWAY_URL, credential GATEWAY_API_KEY` with no host and
no key substring, the split names when the split variables supply their half, and no line at all for
`EMBEDDING_PROVIDER=openai`. No committed test exercises the banner: `index.ts` binds a socket on import and no
test-file edit surface for it was granted, so this remains a review focus rather than a pinned behavior.
