# Coordination role resolution by checkout

Feature document for the fix to "the role disappears when pi restarts".

## Goal

A Pi session running in a coordinated repository must bind to its declared role
without depending on state that survives only until the next agent restart.

Today `applicationRoleFor` resolves a role from two sources, in order:
`ORCHESTRATION_ROLE` in the process environment, then the herdr agent name for
`HERDR_PANE_ID`. Both are lifecycle-scoped. herdr clears `agent_name` whenever the
pane's agent instance changes, so a restarted pi comes back roleless, and
`orchestrate.sh` only sets `ORCHESTRATION_ROLE` when it *creates* a tab, never when
it reuses one. Measured on 2026-10-30: `agent changed pane=4
previous_agent=Some(Pi) agent=None pgid=Some(86204)` followed by `agent=Some(Pi)
pgid=Some(93673)`; after that restart `herdr agent get w9:pS` returned
`name: null` and the session wrote to `.worktrees/orchestrator-a/**` — a path the
contract forbids — without a refusal.

## Decision (human-selected)

Resolve the role **by checkout** as a third source, which is what
`contract-cordination.json` already claims: *"the primary-checkout session that
coordinates this repository IS orchestrator-main … the contract resolves by
checkout, not by inference"*. Until now that sentence described an intent the code
never implemented.

## Design

### `worktree.ts` — one new pure function

`roleForCheckout(scope, repoRoot, cwd)`: the role whose declared `worktree`
resolves to `cwd`, after resolving both against `repoRoot`.

- Normalizes with `path.resolve`, so a trailing slash or a relative `cwd` still
  matches.
- Returns `undefined` for a `cwd` outside `repoRoot`, because a session that is not
  in any declared checkout holds no role here.
- Returns `undefined` when more than one role resolves to the same path. The
  contract already forbids that (check 2 of `verifyRoleWorktrees`), but the
  resolver must fail closed on its own rather than trust an invariant it does not
  verify: binding to a shared checkout would hand one role another's surface.
- The `worktree: ""` role resolves to `repoRoot` itself, so it is selected exactly
  when the session runs in the primary checkout — which is the case the contract's
  prose describes.

### `scope.ts` — composition, not a wider fallback

`applicationRoleFor` keeps its current two sources and its current behavior;
`test/application-role.test.ts` pins it, and widening it in place would change what
a caller that has no repository — only an environment — gets back.

A new `resolveSessionRole(sources)` composes the three in a fixed order:

1. `declared` — `ORCHESTRATION_ROLE`, the documented mechanism.
2. `pane` — the herdr agent name, set by the launcher rather than the process.
3. `checkout` — the declared worktree the session is actually running in.
4. `none` — no role, which stays the ordinary mode for a repository with no
   contract.

It returns the role **and** the source that produced it, because the adapter's
warning text is currently written as "ORCHESTRATION_ROLE is unset" when a *pane*
resolution would be more accurate, and a future operator debugging a broken cluster
needs to know which source answered. The adapter uses the source to report a
failure against the right mechanism.

### `orchestrator-coord/index.ts` — pass the repository, not just the env

The adapter already computes `repoRoot` on the first tool call. It resolves the
role at load, where it has `ctx.cwd`, so the load-time capture becomes
`resolveSessionRole({ env, cwd: ctx.cwd, loadScope })` and the role source is
carried alongside the role for the drift warning.

The capture stays at load, deliberately: re-resolving per tool call would make the
role mutable mid-session, and the file's own header records that a role which
changes underneath a running agent is the failure being defended against.

### What is NOT changed

- `bindSession` keeps its signature and semantics: it reads a role from an
  environment-shaped record and binds it. It does not learn about checkouts.
- The unbound/broken-binding distinction in `unbound.ts` is untouched.
- `orchestrate.sh` is untouched. Its missing `--env` on tab reuse is a second,
  independent defect, tracked separately; this change makes the session survive
  that defect instead of depending on it.
- No repository contract edit. Peers are live in `orchestrator-a` and
  `orchestrator-b`, and editing the contract mid-run unenforces every session.

## Tasks

| # | Task | Checks |
|---|------|--------|
| 1 | Write failing tests for `roleForCheckout` (primary, linked, outside, ambiguous, trailing slash) | `npx vitest run test/worktree.test.ts` red |
| 2 | Write failing tests for `resolveSessionRole` (each source, precedence, `none`) | `npx vitest run test/application-role.test.ts` red |
| 3 | Implement `roleForCheckout` in `worktree.ts` | suite green |
| 4 | Implement `resolveSessionRole` in `scope.ts` | suite green |
| 5 | Wire the adapter to the composite resolver | `tsc --noEmit` |
| 6 | Full package checks | `npm test`, `npm run typecheck`, `fallow` |
| 7 | Prove the real binding with `vite-node` against this repository | bound role = orchestrator-main with the pane name cleared |

## Acceptance

- With `ORCHESTRATION_ROLE` unset **and** the herdr pane name cleared, a session at
  the primary checkout resolves `orchestrator-main` with source `checkout`.
- With the pane named, the pane still wins, so a renamed pane is honored.
- A session in `.worktrees/orchestrator-a` resolves `orchestrator-a`, not
  `orchestrator-main`.
- A session in an unrelated directory resolves no role and stays unbound.
- `~/agents` tests: all pre-existing cases unchanged.

## Risks

- **A wrong role is worse than no role.** Every new path is deny-by-default and
  returns `undefined` on ambiguity; no source guesses from a pane id or a directory
  name alone.
- The adapter's absolute imports point outside any role's write surface. Once this
  session binds, editing `~/.agents/**` is refused as `escapes-root`, so this
  change must land before the reload that binds it.

## Evidence

Recorded per task below as work-unit commits.
