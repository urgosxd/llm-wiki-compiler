# Bake the KG image's provider wiring into the image

Feature branch `chore/kg-image-with-extraction-budget-fix`. The KG image only starts from a hand-wired
`docker run` line that nobody recorded; this feature moves that wiring into a shipped entry script so
`docker run <tag>` with only the DSN and the keys is enough. Provenance and the live proof live in the Log.

## Specs

**S1** — "If the product needs `EXTRACTION_PROVIDER=gateway`, a chat base URL, and embeddings on their
own host, those belong in the image's `CMD`/`ENV` or in an entry script the image ships — not in a
`docker run` line someone remembers."

**S2** — "Make the image start correctly from `docker run <tag>` with only the DSN and the keys
supplied."

**S3** — "Keep the embeddings host from following the chat host."

**S4** — "A reproducible image that needs two documented variables beats a hand-wired `Cmd` that needs
none and is recorded nowhere — but only if it is actually reproducible, tested by `docker run <tag>` with
nothing else."

**S5** — "`odd/tasks/` gets the exact `docker run` line, the tag, and the rollback command."

**S6** — DERIVED from S2 plus log entry L4 (evidence E1), not new operator words: "A DSN supplied under the
published `AKS_DATABASE_URL` name must be honoured by the KG image: when `DATABASE_URL` is unset or blank,
the entry script seeds it from `AKS_DATABASE_URL`. A caller-supplied `DATABASE_URL` always wins."

**S7** — DERIVED from S2 plus log entry L4 (evidence E2), not new operator words: "`AKS_BASE_URL` must
default to the image's own listener (`http://127.0.0.1:$PORT`, PORT defaulting to 8000) when not supplied,
so the MCP tools can reach the server they run inside."

**S8** — DERIVED from S1 audited against L4 (evidence E1/E2), not new operator words: "No credential, DSN or
URL literal may be baked into the script; only preserving defaulting."

## Tasks

| ID | Covers | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1-S5 (this document) | inline | `81bca374` |
| T2 | S2, S3, S4 — RED: static Dockerfile/script assertions in `test/artifact/kg-container-entry.test.ts` | inline | `81bca374` |
| T3 | S1, S2, S3 — GREEN: `packages/llmwiki-kg/docker/entry.sh` plus `ENTRYPOINT`/`COPY`/`chmod` in the KG `Dockerfile` | inline | `81bca374` |
| T4 | S4 — pin the root image guard and lint as unchanged | inline | `81bca374` |
| T5 | S5 — run line, tag and rollback recorded from the live `docker run <tag>` proof | inline | `1b2018ea` |
| T6 | S6, S7, S8 — RED: new static assertions in `test/artifact/kg-container-entry.test.ts`; GREEN: DSN bridge
  and `AKS_BASE_URL` loopback default in `packages/llmwiki-kg/docker/entry.sh` | inline | `1b2018ea` |
| T7 | T2, T4 — register `test/artifact/kg-container-entry.test.ts` in the frozen orphan ratchet so the CI-form gate of record selects the whole suite (L6) | inline | `65bbd113` |

## Spec status

| Spec | Status | Evidence |
| --- | --- | --- |
| S1 | Proven by the live boot | The booted container carried the provider wiring itself; the run line named no `EXTRACTION_PROVIDER`, `EMBEDDING_PROVIDER` or `GATEWAY_EMBEDDINGS_*` (L4, `## Run line`). |
| S2 | Proven with the env-file the proof used; the `AKS_DATABASE_URL`-only half is static-only | The observed boot passed a `DATABASE_URL` explicitly and started with no trailing command; S6's bridge was never exercised by a live boot. |
| S3 | Proven, static and in the startup log | Startup line `[AKS] Gateway embeddings source: endpoint GATEWAY_EMBEDDINGS_BASE_URL, credential GATEWAY_EMBEDDINGS_API_KEY`. |
| S4 | Partly proven | Proven: `docker run <tag>` with no trailing command and no remembered `Cmd`. NOT proven: "with nothing else" — the observed boot required the eight variables below, so the image needs a documented env-file, not nothing. |
| S5 | Proven by this section | `## Run line`, tag and rollback command below, taken from the live boot. |
| S6 | Static-only | `test/artifact/kg-container-entry.test.ts` asserts the preserving bridge; the live proof supplied `DATABASE_URL` directly, so no boot has exercised the `AKS_DATABASE_URL`-only path yet. |
| S7 | Static-only | The same test asserts the loopback `AKS_BASE_URL` default built from `PORT`; the live proof set `AKS_BASE_URL` explicitly (E2), so the default itself is untested by a boot. |
| S8 | Static-only | The same test asserts no DSN, no remote endpoint, no credential and no userinfo literal, and that ordering keeps the wiring before the explicit-command branch and `exec` last. |

## Run line (filled after live proof)

**Image actually built and booted.** Tag `llmwiki-kg:mcp-query-stack-33fbddda-wired`, image id
`03548e392cf8`, built from `faac8ada` plus commit `81bca374` (cherry-picked cleanly). The rollback image
`llmwiki-kg:mcp-query-stack-bb28a587` (`e8c75019ae9a`) was left untouched.

**Boot command observed to work** — no trailing command, so the image's own `ENTRYPOINT` plus `CMD` start
the server:

```sh
docker run -d --name kg-mcp-live --network host --env-file <env-file> llmwiki-kg:mcp-query-stack-33fbddda-wired
```

**Variables that boot actually required**, by name only — no value is recorded anywhere in this document:

| Variable | Why the boot needed it |
| --- | --- |
| `DATABASE_URL` (or the `AKS_DATABASE_URL` bridge added by S6) | The server reads `DATABASE_URL` (`packages/llmwiki-kg/ts/src/config.ts:74`); `AKS_DATABASE_URL` alone is inert in this image (E1). |
| `GATEWAY_URL` | Chat-completions host for the `gateway` extraction provider. |
| `GATEWAY_API_KEY` | Credential for that host. |
| `OPENAI_EMBEDDINGS_BASE_URL` | The embeddings service on its own host; the entry script seeds `GATEWAY_EMBEDDINGS_BASE_URL` from it. |
| `OPENAI_EMBEDDINGS_API_KEY` | Credential for that embeddings host; seeds `GATEWAY_EMBEDDINGS_API_KEY`. |
| `EXTRACTION_MODEL` | Extraction model id; the application default is not the deployed model. |
| `LLMWIKI_EMBEDDING_MODEL` | Must be an `hf:`-prefixed id or the vendor returns 400 (E3, operator configuration, deliberately not defaulted). |
| `PORT` | Listener port; `AKS_BASE_URL` is derived from it (S7). |

`EXTRACTION_PROVIDER`, `EMBEDDING_PROVIDER`, `GATEWAY_EMBEDDINGS_BASE_URL` and `GATEWAY_EMBEDDINGS_API_KEY`
are defaulted by the image's entry script and were not supplied by the caller.

**Observed evidence from that boot.** `/health` returned 200 with
`{"status":"ok","service":"aks-reference-server","version":"0.2.0"}`; `State.Status` `running`, `ExitCode`
`0`; `Mounts` empty, so nothing was bind-mounted; and the startup line
`[AKS] Gateway embeddings source: endpoint GATEWAY_EMBEDDINGS_BASE_URL, credential GATEWAY_EMBEDDINGS_API_KEY`.

**Rollback.** Rollback image `llmwiki-kg:mcp-query-stack-bb28a587` (`e8c75019ae9a`); the previous container
was preserved as `kg-mcp-live-prev-6dc57c6db056`. Exact commands:

```sh
docker stop kg-mcp-live-openrouter
docker rename kg-mcp-live-openrouter kg-mcp-live-new-d78b26102eab
docker rename kg-mcp-live-prev-6dc57c6db056 kg-mcp-live-openrouter
docker start kg-mcp-live-openrouter
```

## Known residuals

- **The extraction budget is still not fully closed.** One run truncated on 1 of 8 calls with
  `LLM output budget exhausted before the model answered (finish_reason: "length")` even at the raised 4096
  budget.
- **Provider discovery is outside the image.** `mcp.json`'s `llmwiki` entry carries no provider variables, and
  `dist/api.js` needs the operator project root as cwd for `dotenv/config`; without it the wiki side fails with
  `Anthropic credentials are required for the "anthropic" provider.` That is a configuration gap in the
  published entry, not a container one.

## Log

- **L1** — Manager's request to this unit, verbatim: "If the product needs `EXTRACTION_PROVIDER=gateway`,
  a chat base URL, and embeddings on their own host, those belong in the image's `CMD`/`ENV` or in an entry
  script the image ships — not in a `docker run` line someone remembers."
- **L2** — Reconnaissance constraints carried into the implementation: `EXTRACTION_PROVIDER` defaults to
  `anthropic` (`packages/llmwiki-kg/ts/src/config.ts:87`) and `EMBEDDING_PROVIDER` to `openai` (`:83`), so
  both must be defaulted for a bare `docker run` to boot; blank `GATEWAY_EMBEDDINGS_*` inherits the chat
  pair (`:212-213`), so those two must be defaulted from the `OPENAI_EMBEDDINGS_*` names the wiki publishes
  and must never be assigned unconditionally; and `.github/scripts/docker-images-check.sh:255-274` boots
  this image with no embeddings URL at all, so no required-variable form and no exit is allowed.
- **L3** — Evidence observed while implementing. RED: `test/artifact/kg-container-entry.test.ts` before the
  image changed, `Tests 6 failed | 1 passed (7)` — the six wiring/entrypoint assertions failed
  (`must declare exactly one ENTRYPOINT … expected [] to have a length of 1 but got +0`, and ENOENT on
  `packages/llmwiki-kg/docker/entry.sh`), while the `CMD` assertion already passed. GREEN after adding the
  script and the `COPY`/`RUN chmod`/`ENTRYPOINT`: `Tests 7 passed (7)`. The root image guard
  `test/artifact/container-entry.test.ts` stayed at `Tests 7 passed (7)`; `pnpm run lint` reported
  `558 baseline violations … no regression`; and a pattern-by-pattern match of `.dockerignore` reported
  `excluded=0` for `packages/llmwiki-kg/docker/entry.sh`, so the new build-context file is not ignored.
- **L4** — Evidence from the live boot proof on the recreated container (recorded verbatim as supplied by the
  manager, values never repeated here):
  - **E1** — With only `AKS_DATABASE_URL` supplied, the container boots, `/health` returns 200, but `/stacks`
    and every graph tool return the exact bare 21-byte body `Internal Server Error`. Cause: the KG server reads
    `DATABASE_URL` (`packages/llmwiki-kg/ts/src/config.ts:74`); the name `AKS_DATABASE_URL` is read only by
    `packages/wiki/src/dimensions/activation.ts:158-162`, which is not in this image. Quote from the proof:
    "`AKS_DATABASE_URL` alone is inert — the server reads `DATABASE_URL` … the **exact bare 21-byte 500**
    (`Internal Server Error`) — the signature the brief warned about, here caused by the DSN variable name, not
    the budget."
  - **E2** — "`AKS_BASE_URL` needed — MCP tools proxy to `${AKS_BASE_URL:-http://localhost:8000}`; on
    `PORT=8010` the first `list_stacks` returned `{"error":{"code":-32603,"message":"fetch failed"}}`. The live
    container likewise sets it to its own port."
  - **E3** — Context only, and deliberately NOT changed in code: the embedding model must be an `hf:`-prefixed id
    or the vendor returns 400; that is operator configuration and stays documented, not defaulted.
  - Consequence for this document: S6, S7 and S8 above are DERIVED from S2 audited against E1 and E2. S1-S5 keep
    their text verbatim.
- **L5** — Evidence from this unit (T6). RED before the script changed: `test/artifact/kg-container-entry.test.ts`
  reported `Tests 3 failed | 7 passed (10)` — `must assign \`DATABASE_URL\` exactly once: expected [] to have a length of 1 but got +0`,
  the same for `AKS_BASE_URL`, and `must default \`DATABASE_URL\` before the caller's command can run: expected -1 to be greater than -1`.
  GREEN after the two preserving exports: `Tests 10 passed (10)`. Root image guard
  `test/artifact/container-entry.test.ts` stayed at `Tests 7 passed (7)`; `sh -n packages/llmwiki-kg/docker/entry.sh`
  reported SYNTAX OK; `pnpm run lint` reported `558 baseline violations … no regression`.
  - **Deviation from the recipe, with the reason observed.** The requested `: "${DATABASE_URL:=${AKS_DATABASE_URL:-}}"`
    was implemented as `export DATABASE_URL="${DATABASE_URL:-${AKS_DATABASE_URL:-}}"`. Measured in `sh`: a plain
    `: "${T:=seeded}"` leaves a previously UNSET variable unexported, so a child process printed `<>`, while
    `export T="${T:-seeded}"` printed `<seeded>`. The bridge would have been inert in exactly the case E1 describes.
    The `:-` arm also covers the blank case S6 names, which `z.string().default` does not (it only substitutes for
    `undefined`, so a blank `DATABASE_URL` would reach the server).
- **L6** — The new guard had a cost the earlier units did not see: registering it made it an ORPHAN. The CI-form
  gate of record on commit `09a99879` failed, verbatim:
  `FAIL test/package-selection-union.test.ts > freezes the orphan ratchet so a new unreachable test cannot slip in silently`
  → `AssertionError: expected [ …(31) ] to deeply equal [ …(30) ]`, received-extra
  `"test/artifact/kg-container-entry.test.ts"`. Population otherwise healthy: `Test Files 1 failed | 845 passed | 4 skipped (850)`,
  `Tests 1 failed | 6367 passed | 11 skipped (6379)`, exit 1, turbo `Failed: //#test`.
  - **Attribution.** `test/artifact/kg-container-entry.test.ts` was added by `81bca374`, and
    `git diff --stat bb28a587..HEAD -- test/package-selection-union.test.ts` is EMPTY: the frozen list was never
    updated for it. The file imports only `vitest` and `node:fs/promises`, `node:path`, `node:url` — no repo module —
    so no `@repo/*` package filter can ever select it. That is precisely the class the ratchet governs, not a hole
    the ratchet should have caught more loudly.
  - **Fix.** Registered as a frozen orphan in its alphabetical position with an investigated-not-pasted
    justification: it is a static text guard over `packages/llmwiki-kg/Dockerfile` and
    `packages/llmwiki-kg/docker/entry.sh`, read via `readFile`/`stat` under `REPO_ROOT`, and it pins the image
    entrypoint so a hand-written `docker run` `Cmd` is no longer required. The literal list was edited; the ratchet
    has no update mode or snapshot and none was used.
  - **GREEN.** `test/package-selection-union.test.ts`: `Test Files 1 passed (1)`, `Tests 12 passed (12)`,
    `orphan=31`. The guard itself is unaffected: `test/artifact/kg-container-entry.test.ts` (10) plus
    `test/artifact/container-entry.test.ts` (7) -> `Test Files 2 passed (2)`, `Tests 17 passed (17)`.
    `pnpm run lint`: `558 baseline violations in 396 files across 423 rule/file entries; no regression`.
