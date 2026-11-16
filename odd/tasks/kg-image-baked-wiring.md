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

## Tasks

| ID | Covers | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1-S5 (this document) | inline | `81bca374` |
| T2 | S2, S3, S4 — RED: static Dockerfile/script assertions in `test/artifact/kg-container-entry.test.ts` | inline | `81bca374` |
| T3 | S1, S2, S3 — GREEN: `packages/llmwiki-kg/docker/entry.sh` plus `ENTRYPOINT`/`COPY`/`chmod` in the KG `Dockerfile` | inline | `81bca374` |
| T4 | S4 — pin the root image guard and lint as unchanged | inline | `81bca374` |
| T5 | S5 — run line, tag and rollback recorded after the live `docker run <tag>` proof | later unit | pending |

## Run line (filled after live proof)

_Not yet observed. A later unit runs `docker run <tag>` with nothing but the DSN and keys and records
here, verbatim: the exact `docker run` line, the image tag it was run from, and the rollback command.
No value is invented before that proof happens._

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
