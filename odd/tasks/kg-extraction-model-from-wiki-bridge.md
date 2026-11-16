# KG extraction model bridged from the wiki's provider configuration

Branch `fix/kg-extraction-model-from-wiki-bridge`. The KG's extraction model now resolves from the
wiki's own `LLMWIKI_MODEL` by the same bridging mechanism already used for the embedding credentials,
with no new environment variable.

## Specs

- **S1 — The bridge, and only the bridge.** `bridgeEnvWithWikiCredentials` fills the KG's `EXTRACTION_MODEL` from the wiki's `LLMWIKI_MODEL`, and only when the KG side left it absent (undefined, empty, or whitespace-only). No new environment variable is introduced, no existing variable is renamed, and no variable is read from a name the wiki does not already use.
- **S2 — Precedence, highest first.** (a) `EXTRACTION_MODEL` present and non-blank: used verbatim, byte for byte, and NEVER passes through the `hf:` normalisation, so no existing deployment changes behaviour. (b) otherwise `LLMWIKI_MODEL` present and non-blank: bridged as `hf:` + the trimmed wiki value; if that trimmed value already begins with `hf:`, it is used unchanged and is not prefixed twice. (c) otherwise the schema default `claude-sonnet-4-5`, unchanged. The bridge never invents a value: a blank wiki value bridges nothing.
- **S3 — The `hf:` discipline is a named, single, pure step.** One named constant holds the prefix and one pure helper applies it. The helper is applied only to the value bridged from `LLMWIKI_MODEL`: the explicit `EXTRACTION_MODEL` path and the default path never pass through it. The module header's "what deliberately is not bridged" list must keep naming `EXTRACTION_*` except this one model variable, and must say precisely why the model is the exception.
- **S4 — The bridge is visible at startup, names only.** Startup prints exactly one line naming WHICH variable supplied the extraction model — `EXTRACTION_MODEL`, `LLMWIKI_MODEL`, or the built-in default — and when the wiki supplied it, whether the `hf:` prefix was applied or already present, as a word of text. It names variables and prefix PRESENCE only; it never prints a model id, a credential, an endpoint or any value. It is produced by one pure exported function, following the precedent of `gatewayEmbeddingsSourceLine`, and emitted at the same startup site that emits that line. The line identifies itself as describing the resolved CONFIGURATION, because an injected wiki chat backend takes precedence at request time: it must be worded so it can never be read as a claim about what a request sends, and the injected-backend precedence is stated in the documentation beside it.
- **S5 — Nothing else moves.** `DATABASE_URL` stays un-bridged (deliberate: the empty-string fallback to `aks` is a live hazard). `EXTRACTION_PROVIDER`, `EMBEDDING_DIM` and `AKS_API_KEY` keep their own resolution. The embedding model bridge keeps its existing verbatim pass-through. `injectedChatModel()` and `chat-backend.ts` are untouched.
- **S6 — Tests, and what each one is for.** All assertions are exact string equality on the value `parseConfig(bridgeEnvWithWikiCredentials(env))` resolves, through the public interface, never on internal storage.
  - S6.1 With `EXTRACTION_MODEL` unset and `LLMWIKI_MODEL` set, the resolved KG extraction model is the `hf:`-prefixed form of the wiki value — the resolved string is asserted, not the absence of an error.
  - S6.2 With `EXTRACTION_MODEL` explicitly set and `LLMWIKI_MODEL` also set, the explicit value wins unchanged, with no `hf:` prefix added. This is the existing-deployment pin: a change here is a regression.
  - S6.3 With neither set, the default `claude-sonnet-4-5` still applies — today's behaviour pinned.
  - S6.4 A wiki value that already carries `hf:` is not double-prefixed: the exact output is asserted, not a `startsWith`.
  - S6.5 The S4 source line: the exact emitted string for each of the three cases, and the line contains no model id.

## Tasks

- T1 — feature document; specs S1-S6; commit: 3fa403055de093e133ba231fe3f941bde232dde5
- T2 — bridge the model name and add the normalisation helper; specs S1, S2, S3; commit: 3fa403055de093e133ba231fe3f941bde232dde5
- T3 — startup source line; spec S4; commit: 3fa403055de093e133ba231fe3f941bde232dde5
- T4 — operator documentation; spec S2; commit: 3fa403055de093e133ba231fe3f941bde232dde5
- T5 — gates and work-unit commit; specs S1-S6; commit: 3fa403055de093e133ba231fe3f941bde232dde5
- T6 — source line describes configuration, and the embedding path is pinned verbatim; specs S4, S5; commit: this unit's single commit on this branch — a commit cannot record its own SHA, so the SHA is stated in the delivery handoff

## Log

L1 (user brief, verbatim):

The KG's extraction model should come from the same provider configuration the wiki dimension uses, bridged the same way the embedding model already is. No new environment variable.

## The measured problem
`query_stack` fails with the gateway's own message, verbatim:
```
AKS server returned 400: {"detail":"…/chat/completions answered 400: {\"error\":\"Your model name should start with a hf: prefix; for example: \\\"hf:claude-sonnet-4-5\\\"\"}"}
```
The container carries `LLMWIKI_MODEL` but **no `EXTRACTION_MODEL`**, so the KG falls back to the `claude-sonnet-4-5` default at `packages/llmwiki-kg/ts/src/config.ts:80` — an id the gateway rejects for lacking `hf:`. **`LLMWIKI_MODEL` is wiki-side only (`packages/wiki/src/utils/provider.ts:194`) and the KG never reads it.**

## The precedent to follow, and it is already in the code
**`packages/llmwiki-kg/ts/src/wiki-credential-fallback.ts:284` already bridges `LLMWIKI_EMBEDDING_MODEL` into the KG's embedding model, adding the `hf:` prefix.**

**Read that file fully first** — `:20-21` records what is deliberately NOT bridged (the wiki DSN) and why; `:50,74,94,297` show the other bridged names. **The existing shape is the specification: bridge the name, add the prefix, never invent a value.**

**Extend it so the extraction model resolves the same way from the wiki's own `LLMWIKI_MODEL`, with the same `hf:` discipline.**

## Non-negotiables
- **No new environment variable.** If your design needs one, stop and bring it back as a decision — the whole point is that the operator should not configure the same provider twice.
- **Precedence must be explicit and stated**: an explicitly-set `EXTRACTION_MODEL` must still win, so no existing deployment changes behaviour. **Write the order down.**
- **The bridge must be visible**: today's split established that the resolved source is named once at startup, **name only, never a value** (`gatewayEmbeddingsSourceLine`). **Follow that discipline — one line naming which variable supplied the model, or an explicit statement of why it does not apply here.**
- **Do not bridge the DSN.** `:20-21` says it is deliberate and the empty-string fallback to `aks` is a live hazard measured today.

## Tests — test-first
1. **With `EXTRACTION_MODEL` unset and `LLMWIKI_MODEL` set, the resolved KG extraction model is the `hf:`-prefixed form of the wiki's value.** **Assert the resolved string, not the absence of an error.**
2. **With `EXTRACTION_MODEL` explicitly set, it wins unchanged** — the existing-deployment pin. **A change here that nobody asked for is a regression.**
3. **With neither set, the current default still applies** — pin today's behaviour.
4. **A wiki value that already carries `hf:` is not double-prefixed.** **Assert the exact output, not a `startsWith`.**

## Risk classification
**Item 2** — this decides which model receives which credential and which endpoint is called. **Item 3** — it changes a provider-resolution contract every deployment consumes. **Say both in your `Risk:` line and expect independent verification.**

## Constraints
- **Never print a connection string, URL with userinfo, token, key or a model-variable value.** **Presence booleans and resolved names only; if a resolved model id must be shown, show the `hf:` prefix boolean, not the id.**
- **Do not read `.env`.** Do not restart or recreate `kg-mcp-live`. Do not contact the `aks` database.
- **Node 24 PATH** for gates: `PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- **Bring back as decisions, do not take alone**: the precedence order if it is not the one stated above, and any place this would require touching code the merged `/mcp` mount also depends on.

## Deliverable
The resolved-order statement, the tests observed red then green, the gate results with scope named, and the full 40-character commit SHA. **If the bridge cannot be done without a new variable, say so plainly and stop** — that answer is worth more than a workaround.

L2 (Lead, after source reading): the brief's premise that wiki-credential-fallback.ts:284 adds an `hf:` prefix is false — that line is a verbatim pass-through, and `hf:` exists only in test fixtures and in a documented wiki-side operator requirement. The prefix is therefore introduced here as a new normalisation for the extraction model only; the embedding bridge keeps its verbatim behaviour, by decision, to avoid an unrequested provider-resolution contract change.

L3 (delivery, at T5): the five `commit:` fields above hold the SHA of this work unit's PRE-amend
version. A commit cannot record its own SHA, so the fields were filled after the first commit
(3fa403055de093e133ba231fe3f941bde232dde5) and delivered by amending that same commit — one commit,
no successor commit, nothing staged that this unit had not already produced. The delivered commit is
the amended successor of that SHA, on this branch, and its SHA is in the delivery handoff. Gate runs
on the tree this commit carries: `gates:static` (all 6 passed), `build`, and `vitest related` on the
three touched sources (488 files passed, 3 skipped, 0 failed), plus the focused three-file run
(87 passed). A last prose-only fix reordered the module header so the new normalisation section does
not separate the existing `EMBEDDING_MODEL` paragraph from its subject; `gates:static` was re-run on
that final tree. One note for the record: KG_BRIDGED_VARIABLES does NOT gain `EXTRACTION_MODEL`,
because that exact set is the embedding conformance contract two existing tests pin; the exception is
documented in the module header, in that constant's JSDoc, and in the bridging table instead.

L4 (Lead, after independent verification): the startup line reports what the CONFIGURATION resolves, but a wiki-injected chat backend takes precedence per request and sends the wiki model verbatim, so the line could say `hf: prefix applied` while a different model is sent. S4 is accordingly amended: the line must be worded as a statement about configuration, never about what a request sends, and the injected-backend precedence must be stated in the docs beside it. This unit also closes a verified test gap: no committed test would catch an `hf:` normalisation leaking into the embedding bridge, because every existing embedding fixture is already prefixed.
