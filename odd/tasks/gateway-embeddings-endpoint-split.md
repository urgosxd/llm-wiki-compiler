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
  local `.invalid` host. Route: `gentle-ai-worker`. Commit: `650d15f2` (T1).
- **T2** — S3, S4, S6, S8: add both schema entries, resolve the embeddings gateway arm from the new
  variables with inheritance, leave the chat arm on `GATEWAY_URL`/`GATEWAY_API_KEY`. Route:
  `gentle-ai-worker`. Commit: `650d15f2` (T2).
- **T3** — S5: one startup line naming the source variable, once, value-free. Route: `gentle-ai-worker`.
  Commit: `650d15f2` (T3).
- **T4** — S7: compose allowlists, example env files, the two docs tables. Route: `gentle-ai-worker`.
  Commit: `650d15f2` (T4); the compose and docs surfaces are in that commit.
- **T5** — Gates with Node 24 PATH (`gates:static`, `build`, `test:affected`) and the work-unit commit.
  Route: `gentle-ai-worker`. Commit: `650d15f2` (T5, the gates and the work-unit commit); the
  changelog lands separately in `bf79a294`.

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

**L7 — compose forwards both variables blank, and that is the point.** All three allowlists
(`docker-compose.yml:152`, `docker-compose.hub.yml:109`, `packages/llmwiki-kg/docker-compose.yml:52`) carry
`GATEWAY_EMBEDDINGS_BASE_URL: ${GATEWAY_EMBEDDINGS_BASE_URL:-}` and
`GATEWAY_EMBEDDINGS_API_KEY: ${GATEWAY_EMBEDDINGS_API_KEY:-}`, not a pre-substituted fallback. Rationale: the
application is the single owner of the inheritance (S5), and only an unsubstituted pass-through keeps the
startup line truthful about *which* variable supplied the endpoint. A compose-level
`${GATEWAY_EMBEDDINGS_BASE_URL:-${GATEWAY_URL}}` would hand the application a filled-in value, so the banner
would name `GATEWAY_EMBEDDINGS_BASE_URL` as the source for a deployment that set only `GATEWAY_URL` — the
inheritance would be asserted by compose and observed nowhere. A first attempt did exactly that and was
rejected for exactly that reason.

**L8 — one tracked example env file still lacks the new entries; a human must edit it.** Updated:
`docker/env.example` and `docker/hub.env.example`, both tracked and both now carrying the two
`GATEWAY_EMBEDDINGS_*` names. Not updated: `packages/llmwiki-kg/.env.example` and the repository-root
`.env.synthetic.example`, because the harness credential-path policy denies `.env*` paths to agents, so no
agent could read or edit them.

One premise in the handoff is corrected here, from repository evidence rather than memory: neither file is
gitignored — `git check-ignore -v` matches neither, and both are tracked (`git ls-files`). The blocker is the
credential-path policy alone. The gap is real for `packages/llmwiki-kg/.env.example`, which mentions
`GATEWAY_URL` three times and `GATEWAY_EMBEDDINGS_*` zero times. It is *not* a content gap for
`.env.synthetic.example`, which mentions neither variable, so nothing in S7's scope is missing from it.
Residual: a human adds the two entries beside the existing `GATEWAY_URL` block in
`packages/llmwiki-kg/.env.example`.

**L9 — a `ConfigValidationError` message changed on a pre-existing failure path, deliberately.** For a
misconfigured `EMBEDDING_PROVIDER=gateway` whose *resolved* endpoint or credential is blank, the message now
names all four variables (`packages/llmwiki-kg/ts/src/config.ts:270-271`):

```
EMBEDDING_PROVIDER=gateway but GATEWAY_EMBEDDINGS_BASE_URL or GATEWAY_URL is not set, or GATEWAY_EMBEDDINGS_API_KEY or GATEWAY_API_KEY is not set
```

The previous text, `EMBEDDING_PROVIDER=gateway but GATEWAY_URL or GATEWAY_API_KEY is not set`, no longer
exists anywhere. This is a user-visible text change on a path that already failed before this feature, and it
is deliberate: S8 keeps refusing a blank resolved endpoint, and a message naming only the old pair would send
an operator whose deployment sets only the split variables to check a variable their deployment never used.

**L10 — the S5 startup line is proven, but not pinned by a committed test. Follow-up surface.**
`packages/llmwiki-kg/ts/src/index.ts:53` calls `app.listen` at module import, so importing the module binds a
socket; that is why L6 could only prove the banner with a disposable harness. That harness is evidence about
this tree and cannot regress-guard a later edit. Recorded as a follow-up: pin it either by extracting the
banner rendering from the socket-binding module, or by asserting `gatewayEmbeddingsSourceLine(config)` over
the four source combinations plus a seam that defers `listen`.

**L11 — S9 stays out of scope and becomes its own task.**
`OPENAI_BASE_URL = "https://api.openai.com/v1"` (`packages/llmwiki-kg/ts/src/core/llm/constants.ts:31`) is
untouched, per D3. It is a separate task rather than a rider on this one because its defect is *destination
and credential egress*, not reachability: a provider name that silently means "the vendor's own endpoint"
because no configured base URL is threaded through that branch at all. The split fixes which host the gateway
arms resolve to; it does not make the `openai` arm respect a configured gateway. That question needs its own
matrix over the four provider/branch combinations and its own tests, and hiding it inside a
configuration-splitting diff is the failure mode L4 of the sibling document names.

**L12 — independent verification: every S# met by reading, none unmet.** S1 and S2 through the committed
resolved-endpoint assertions on both arms; S3 and S4 at `config.ts`'s two EnvSchema entries plus the
resolved-value arms; S5 through `gatewayEmbeddingsSourceLine` and its single production caller; S6 because
`KG_BRIDGED_VARIABLES` still has literal length 5; S7 across the three compose allowlists, the tracked
example files and both docs tables, with L8's residual still a human edit; S8 because the refusal is on the
*resolved* value and names all four variables (L9); S9 untouched, as L11 records. No spec was found unmet.

**Two constraints the next change on this branch will hit.** Both were paid for once already and should not
be rediscovered:

(a) **A root `test/` file may not name `packages/llmwiki-kg/**` or `@repo/kg`.** `WIKI_TO_KG`
(`eslint.config.mjs:149`) restricts exactly those two shapes — the path regex `(^|/)packages/llmwiki-kg(/|$)`
and the specifier regex `^@repo/kg(/|$)` — for the `wiki must not import kg` boundary, and the lint ratchet
freezes no allowance for a new violator, so the ratchet gate fails rather than the test. Any root-test probe
of gateway resolution must therefore live in `packages/llmwiki-kg/ts/src/**`, which is where
`config.test.ts` already carries the S1/S2/S8 cases. This is also why an earlier instruction to probe this
area from a root `test/` file was unbuildable: the probe cannot be written where it was asked for.

(b) **`docker/hub.env.example` and `docker/env.example` are correct against their own compose and must not
be cross-corrected.** `docker-compose.hub.yml:110` maps `GATEWAY_API_KEY` from `OPENAI_API_KEY`, while
`docker-compose.yml:153` maps it from `PROVIDER_API_KEY`. Each example file's comment describes the compose
file it documents. Making them agree would make one of them describe a mapping that does not exist — a
plausible-looking "consistency" fix that turns a correct file into a wrong one.

**A remaining honest gap, recorded rather than closed: the half-split hazard is documented, not refused.**
Setting `GATEWAY_EMBEDDINGS_BASE_URL` while leaving the credential to inherit sends `GATEWAY_API_KEY` to the
embeddings host — S4's whole reason for existing. It is pinned by a test whose name must not be renamed, and
it is not refused at validation time, because the two cases are observationally identical: a deployment
legitimately holding one key valid on two hosts looks exactly like a mistake. A refusal would break a
correct deployment to catch a wrong one, so the split stays permitted and the asymmetry stays observable
through S5's startup line, which names the *source* of each half by variable name. Half of a split is
visible in the log; it is not an error. Residual risk, not a defect.

Commit: `a3255f2a00bc9234b76d8f8972048aee9d23dee2` (the swallow fix and the changelog; this feature's own
code commit remains `650d15f2`).
