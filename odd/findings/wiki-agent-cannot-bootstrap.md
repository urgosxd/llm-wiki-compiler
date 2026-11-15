# The wiki agent cannot bootstrap: every tool it declares needs a stack id and none of them can discover one

Measured during a read-only reconnaissance session. Facts below are observations from tool invocations, not inferences.

## 1. The defect, as measured

The Pi agent definition `wiki-agentic-search` (at `~/.pi/agent/agents/wiki-agentic-search.md`) declares exactly four tools:

- `mcp__llmwiki__query_wiki`
- `mcp__llmwiki__search_pages`
- `mcp__llmwiki__read_page`
- `mcp__llmwiki__get_context_pack`

All four require a `stackId` that must be a UUID. This was measured by invocation, not inferred: each of the four was called without a valid `stackId` and each was rejected.

Verbatim error from `mcp__llmwiki__search_pages` with `stackId="default"`:

```
Error: 'default' is not a Stack id. Stack ids are UUIDs — call list_stacks to see the ones this endpoint can reach.
```

Verbatim rejections with no `stackId` supplied, one per tool:

```
Validation failed for tool "mcp__llmwiki__query_wiki": - stackId: missing
Validation failed for tool "mcp__llmwiki__get_context_pack": - stackId: missing
Validation failed for tool "mcp__llmwiki__read_page": - stackId: missing
```

Conclusion: the agent can query but cannot bootstrap. Without an externally supplied stack id it has no reachable path to any content. This is self-blocking by construction.

## 2. The error message points at a tool the agent cannot call

The error itself names `list_stacks` as the way to discover valid stack ids. The `wiki-agentic-search` agent's complete runtime toolset was measured again: `mcp__llmwiki__query_wiki`, `mcp__llmwiki__search_pages`, `mcp__llmwiki__read_page`, `mcp__llmwiki__get_context_pack`, plus `ask_owner`, `read_evidence`, `attach_handoff`. `list_stacks` is not among them.

The agent has no shell, no MCP passthrough and no generic call-arbitrary-tool mechanism, so it has no channel through which to attempt a call to `list_stacks` at all. There is therefore no error message to quote for it — not an absent tool that rejected a call, but a tool with no call path.

Two things remain distinct and must not be merged:

- (a) `list_stacks` is NOT admitted to the agent — measured, settled.
- (b) Whether the wiki MCP server registers `list_stacks` at all — UNVERIFIED, and unverifiable from inside any agent built on this definition, because an agent cannot observe a tool it cannot call.

Both possibilities of (b) stay alive and neither is picked: either the server registers `list_stacks` and the definition simply fails to declare it — a one-line fix in the definition — or the server does not register it, in which case the `search_pages` error's own advice points at a tool that does not exist, which is a worse defect than the missing declaration. This reconnaissance cannot choose between them.

The consequence: the only remaining route to answer (b) would be an MCP client holding the server connection string directly, which is outside the constraints of this reconnaissance and was deliberately not attempted.

## 3. What is NOT defective, and this matters

- MCP admission works for delegated agents. A delegated `wiki-agentic-search` child received all four `mcp__llmwiki__*` tools in its toolset. Enumerated by the child itself.
- The coordinator session that delegated it has zero `mcp__llmwiki__*` tools. A coordinator surface and an agent surface are separate registrations, so the coordinator's toolset says nothing about what a child receives. Gating a question about the child on the coordinator's toolset is an invalid measurement.
- The MCP server is reachable. It answered with a structured domain error and per-tool validation errors, not a transport failure, handshake timeout, or missing-tool error.
- Therefore a Pi restart does not fix the bootstrap gap: nothing was wrong with admission.

**Admission is not the problem. A coordinator session's empty MCP surface says nothing about a child's toolset — a coordinator surface and an agent surface are separate registrations.**

## 4. Retrieval through the agent is verified, once a stack id is supplied from outside

An earlier probe run returned no wiki content through `wiki-agentic-search` at all: no page body, slug or title, zero completed search rounds, zero citations. The reason was that no stack UUID was discoverable from inside the agent and none was supplied for those runs. The parent explicitly refused to invent or infer a stack id from error text. That refusal was deliberate and correct: a guessed id yields either a second error or a confident answer from the wrong stack.

A stack UUID was then supplied to the agent from outside, deliberately bypassing the bootstrap gap so retrieval itself could be tested. One delegated run was made with it.

Result: retrieval works end to end. A single `mcp__llmwiki__search_pages` call with that stack id returned four wiki pages with complete bodies: `desander-basin`, `sediment-abrasion-in-turbines`, `desander-flushing-operation`, `central-hidroeléctrica-río-claro`. The agent answered from that returned text and cited those four slugs. One round, one tool call; it stopped after the first search because the returned bodies already covered the question.

The response carried a `warnings` array containing exactly one entry: code `embedding-index-outdated`, message `No embedding index found.`

The four full page bodies were returned **despite** that warning. The degraded path and the usable answer arrive together: this is a fallback that works, not a failure mode. The conclusion is neutral — retrieval quality on this stack does not depend on an embedding index.

Ref shape as measured: each ref carries exactly four keys in this order — `pageId`, `slug`, `title`, `kind` — and no ref carries a `score`. No relevance ranking is exposed to the caller, so the agent ranked pages by reading titles and summaries itself. With no scores exposed and the answer still good, the absence of `score` reads as a deliberate design choice rather than a fault — which is precisely why earlier reports misread it as a ranking signal gap.

No page object or ref carried a `links` key in that run. `read_page` was measured directly in a later call: its top-level keys are, in order, `slug`, `title`, `summary`, `body`. No `links` key is present. The previously unverified half of this record is now measured absent rather than unverified.

The bootstrap defect in section 1 is unchanged by this result: retrieval worked only because the stack id came from outside. Without it the agent still cannot reach a single page.

## 5. A harness behaviour nobody had documented — inherited assignment evidence silently replaced the task

A delegated child assignment automatically inherits the parent's required evidence. In the first probe run, the inherited project brief — a read-only reconnaissance instruction set with its own numbered steps and a "zero provider spend" line — was received by the child as retained context. The child executed the brief's steps instead of the question it was asked.

The child never touched the actual task. Its result was indistinguishable in form from a successful run: well-formed, on-topic for the brief, and reported as complete.

The same inheritance later caused a second failure mode: the brief's "zero provider spend" line was read by a child as a prohibition on using its own wiki tools, so it declined the task for cost reasons.

Corrective pattern that worked: state in the delegated task text that any inherited brief is the parent's and not the child's assignment, explicitly forbid executing its steps, and state explicitly that the child's own tool calls are the authorized spend.

The lesson, in one sentence: a run that executes something other than what was asked is indistinguishable, from its output, from a run that executes what was asked — so inherited context must be superseded explicitly in the task text.

## 6. How MCP payloads arrive

The MCP bridge wraps every payload and echoes it a second time under a trailing `structuredContent` key whose value is `{ "result": <same payload> }`.
