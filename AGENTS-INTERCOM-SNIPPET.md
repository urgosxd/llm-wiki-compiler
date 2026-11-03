# Snippet to append to AGENTS.md

Proposed block for `AGENTS.md`, replacing the generic pi-intercom snippet. Keep the
`<pi-intercom>` tag: it is the anchor agents scan for.

```markdown
<pi-intercom>
Coordinate with other local pi sessions on related codebases. Use `/skill:pi-intercom`
for transport mechanics and `/skill:multi-agent-coordination` for the protocol.

**When:** same codebase in parallel worktrees, a reference codebase you are consulting,
related repos sharing a library.

**Not when:** unrelated codebases, a question you can answer yourself, or any time you
can proceed independently.

**Transport:** prefer `send` for anything nobody must answer. `ask` only when you are
blocked and the answer changes what you do next — it blocks you for up to ten minutes.

## Stopping rule — this is the part that matters

A coordination turn ends at the first of these. When one applies you stop SENDING; it
does not mean you stop working.

- You received `done`, `audit_report`, or a verifying `work_result`. They are terminal.
- You sent one of those. Your scope is closed; do not report it again.
- You sent one `blocked` for an `id`. The human decides next, not you.
- Your `expect` is satisfied. `expect: none` means nothing follows it.
- You are waiting for an answer. Waiting is not a turn: do not send a progress note, a
  reminder, or a re-send.

## Commits are evidence, not a topic

Commit in your own checkout when the work needs it, then report it ONCE in the
`evidence` field of `work_result` or `done`. That report is the whole conversation
about the commit.

Never ask permission to commit, never ask which branch, never ask whether to commit,
and never announce that you committed. Your worktree, branch, index, and commits are
yours — the coordination contract says so, and no peer's answer could change it.

`evidence` is verified against git: if the commit does not exist, or does not touch the
paths you listed in `files_changed`, the report is refused. So a verifying report is
the proof, and discussing the commit instead of citing it is strictly worse.
</pi-intercom>
```

## Why this differs from the upstream snippet

The upstream block answers "when should I coordinate". It does not answer "when do I
stop", and that is the failure actually observed: agents that keep conversing, keep
re-raising the same obstacle, and keep talking about commits instead of reporting them.

Three additions, each aimed at an observed loop:

| Addition | Loop it closes |
| --- | --- |
| Stopping rule, 5 terminal conditions | No stop condition existed. "Do not loop" was advice with no boundary. |
| "Commits are evidence, not a topic" | The Pre-Commit Checks section of this file makes committing part of "done", which agents read as a step to discuss. |
| `expect` satisfaction as a stop | `expect: none` was sending a message and then, sometimes, following it with an acknowledgement. |

Backed by the hook, not only by prose:

- `duplicate-id` — the same envelope `id` sent twice from one session is refused.
- `ask-without-reply` / `send-claims-reply` — the envelope's `expect` must agree with
  the intercom action that carried it.
