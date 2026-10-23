# multi-agent-coordination — two orchestrators, one contract

## Goal

Make two Pi orchestrator sessions (`w8:p1` = A, `w8:p2` = B) cooperate on this
repository through an explicit protocol instead of ad-hoc prose: a shared skill
that teaches the rules, a per-role scope configuration, and a machine-checkable
envelope that makes a malformed response fail instead of being believed.

Verified transport already exists. `orchestrator_send_message` reaches a peer
through the native gentle-pi session transport (`extensions/gentle-agents.ts:1327`
→ `lib/agents-session-transport.ts`), and the receiver is woken with
`deliverAs: "followUp"` and a real correlation id
(`extensions/gentle-agents.ts:598`). Herdr supplies what the native transport
does not: live agent state (`working|blocked|idle|done`) and a blocking read.

## Non-goals

- No new messaging infrastructure. No Redis, no broker, no third process.
- No third agent and no parallel fan-out across more than two orchestrators.
- No change to gentle-pi's transport, and no fork of it.
- No SDD ceremony. This is organic work tracked in this file.
- No extension code in this pass. Enforcement is designed, not yet automated.

## Why a skill alone is not enough

A skill is prose the model may or may not honor. Three capabilities were checked
against the runtime before committing to a design, and they differ sharply:

| Capability | Runtime fact | Consequence |
| --- | --- | --- |
| Extension invoking a registered tool | `ExtensionAPI` exposes only `getActiveTools`, `getAllTools`, `setActiveTools`. No `invokeTool`, no `execute` on `ToolInfo`. | A `coord_send_request` tool **cannot** reuse `orchestrator_send_message`. |
| Blocking a tool call | `tool_call` handler may return `{ block: true, reason }`; `event.input` is mutable. | Enforcement is possible at the boundary, not in prose. |
| Message size | `CHILD_MESSAGE_MAX_BYTES = 8 * 1024`; the send tool rejects beyond it. | The envelope must be compact. A diff never fits; a decision does. |

So the split is: the skill teaches, the envelope is checkable, and the future
hook is what actually refuses. This pass builds the first two.

## Two transport lanes, and which one wins

The native lane and the Herdr lane are not interchangeable, and picking the
wrong one per step is the main way this protocol rots.

| Step | Lane | Why |
| --- | --- | --- |
| Contract proposal, accept, reject, block, done | native `orchestrator_send_message` | Structured text, correlation id, wakes the peer, survives pane layout. |
| Liveness ("is B still alive?") | Herdr `agent list` / `agent get` | Native transport exposes no peer activity state. |
| Synchronous negotiation inside one turn | Herdr `agent prompt --wait` + `agent read` | The only blocking option. Costs fidelity: `agent read` returns rendered TUI, not data. |

`orchestrator_list` is a reachability-unknown presence list, never a module
registry. Session-to-pane resolution comes from Herdr's `agent_session.value`
(the Pi `.jsonl` path).

## Envelope v1

Every coordination message carries a delimited block. One field per line,
because the TUI wraps long lines and a single 400-character JSON object does not
survive that wrapping to be read back.

```
<<<COORD v1
{"from":"orchestrator-a"}
{"to":"orchestrator-b"}
{"type":"contract_proposal"}
{"id":"cp-2026-10-22-01"}
{"contract":"contracts/coordination-ping.md@1"}
{"expect":"accept_or_reject"}
COORD>>>
```

`type` is one of `contract_proposal`, `contract_decision`, `work_request`,
`work_result`, `blocked`, `done`. `work_result` additionally requires
`files_changed`, `tests`, and `evidence`. Missing required fields for the
declared `type` is a validation failure, not a judgement call.

Exact field list and per-type requirements live in the skill's
`references/envelope-v1.md`.

The skill is **global**, at `~/.pi/agent/skills/multi-agent-coordination/`. The
protocol is reusable across projects, so it is installed once like the validator;
only the contract is per-repo. An earlier version shipped the skill in this
repository's `.agents/skills/`, which worked only because both panes happened to
share this cwd, and which would have been invisible to an agent running in a
linked worktree. It was moved and the in-repo copy deleted so the two copies
cannot diverge.

## Roles

The skill is shared; the scope is not. Each orchestrator loads the same protocol
and its own role file:

- A (`w8:p1`): coordinates the integration, owns `main`, reviews B's branch.
- B (`w8:p2`): owns its feature worktree and branch, never touches `main`.

Scope is enforced socially in this pass and structurally later (worktree
separation plus A merging B's branch, never both editing one tree).

## Acceptance criteria

1. Both sessions can load `multi-agent-coordination` from the global skill
   directory and resolve its relative references from there.
2. The protocol names exactly six concern areas: identity, responsibilities,
   messages, contracts, verification, integration.
3. Envelope v1 is specified field by field, with a per-`type` required-field
   table, and fits the 8 KB ceiling for every declared type.
4. Role configuration is separate from the protocol, and scope is data: each
   role card names its contract key and never restates a path list.
5. The contract dependency test below is specified well enough to run by hand.
6. The scope contract is validated by a typed, tested validator that fails
   closed and can be called from outside the repository.
7. No orchestration logic lives in this repository: the validator is a global
   package, and only the per-repo contract file remains here.

## Contract dependency test (run by hand, before automation)

This is the gate. Do not start parallel implementation before it passes.

1. A sends `contract_proposal` for one small, real interface. Fill the envelope.
2. B replies `contract_decision` with `status: accepted` or `status: changes`.
3. Both record the agreed version verbatim in their own feature document under
   `## Agreed contract`.
4. Each implements only its own side.
5. B sends `work_result` with `files_changed`, `tests`, `evidence`.
6. A validates the envelope, then verifies the integrated result and the tests.

Failure modes that count as the test failing, not as noise:

- A message that arrives without an envelope and is still acted upon.
- A `work_result` with no `tests` field that is accepted anyway.
- Two agents editing the same file in one checkout.
- A decision recorded at different versions on the two sides.

## Tasks

- [x] T1 Write `odd/tasks/multi-agent-coordination.md` (this document).
- [x] T2 Write the shared protocol `SKILL.md` (six concern areas, role references).
- [x] T3 Write `roles/orchestrator-a.md` (scope: integration, main, review).
- [x] T4 Write `roles/orchestrator-b.md` (scope: feature worktree, no main).
- [x] T5 Write `references/envelope-v1.md` (fields, per-type table, examples).
- [x] T6 Validate the skill loads with valid frontmatter and that both sessions resolve it.
- [x] T7 Make scope dynamic: `contract-cordination.json` + `src/coordination/scope.ts`
      validator + JSON Schema + 34 tests. Role cards point at the contract instead
      of hardcoding paths.
- [x] T8 N roles + worktree precondition + overlap detection. `contract-cordination.json`
      ratified with three roles (A integrator, B compiler, C cli/commands); role names are
      an open pattern, not a closed enum; `assertCoordinationScopeUsable` verifies one git
      worktree per role against real git output; `assertNoOwnershipOverlaps` rejects
      duplicates and nested globs. Three git worktrees exist (`.worktrees/orchestrator-{a,b,c}`).
- [x] T9 Extract the validator into a global package `@local/orchestration`
      at `~/.agents/orchestration`; keep only the per-repo contract here.
      `src/coordination/` and its tests are deleted from this repository.
- [ ] T10 Run the contract dependency test by hand across roles.
- [x] T13 Enforcement as a real Pi extension, plus evidence verification.
      `~/.pi/agent/extensions/orchestrator-coord/` blocks `write`/`edit` outside a
      role's surface, blocks malformed envelopes, and blocks `work_result` claims
      whose evidence does not hold. Logic lives in `@local/orchestration`
      (`evidence.ts`, `enforce.ts`, `envelope.ts`) with 92 tests; the extension is
      wiring only, because Pi's virtual modules cannot be imported in a test.

## Evidence

- Transport verified earlier this session: A (`01a16538-23ed-7797-b634-cfd2b9cab9f8`,
  pane `w8:p1`) → B (`01a16538-4097-774d-9778-05619b463d98`, pane `w8:p2`) via
  `herdr agent prompt --wait`, answer read back with `herdr agent read`.
  B answered with its own `orchestrator_session_id`, so identity was not assumed.
- Runtime capabilities above read from `pi-coding-agent/dist/index.d.ts`
  (`ExtensionAPI`), `docs/extensions.md` (Tool Events), and
  `gentle-pi/lib/agents-session-transport.ts`.
- T2-T5 written by a delegated `gentle-ai-worker`, then independently verified
  by `gentle-ai-verify` (`assess` returned `risk: unassessable` because the
  candidate is untracked, so the independent verifier was required). The verifier
  found 10 real defects and all were fixed:
  1. `agent_status` omitted `unknown`.
  2. `work_request` referenced an undefined `payload` field.
  3. Per-role scope restated in `SKILL.md`, contradicting its own claim.
  4. Session-id derivation breaks for ids containing `_`.
  5. Unfilled role placeholders silently expanded ownership rules to nothing.
  6. `Conditional` column carried no information.
  7. No rule rejected an unknown/misspelled field.
  8. The same correlation id was used for two different messages.
  9. A pipe example emitted columns reversed, and a live pane id was hardcoded.
  10. The 8192 limit was misattributed to `CHILD_MESSAGE_MAX_BYTES`, which governs
      a different code path; `orchestrator_send_message` hardcodes `8192`.
- Post-fix re-verification, all mechanical: Pi's skill loader returns
  `['multi-agent-coordination']` with 0 diagnostics; 5 envelopes parse line by
  line, satisfy their declared type, carry unique ids, and are 150-342 bytes;
  all 7 relative links resolve; `SKILL.md` no longer restates role scope.
- Live protocol check: B (`w8:p2`) read both skill files and answered with a
  valid `done` envelope over Herdr, so the protocol survived one real round trip.
- T7 (dynamic scope) verified, all commands re-run by the parent rather than
  trusted from the writer's report:
  - `npx tsc --noEmit` — exit 0, no output.
  - `npx vitest run test/coordination-scope.test.ts test/coordination-glob.test.ts`
    — `Test Files 2 passed (2)`, `Tests 34 passed (34)`.
  - `npx fallow` — exit 0, nothing above threshold for `src/coordination/**`.
  - `node scripts/typecheck-tests.ts` — 2581 files, no regression.
  - Adversarial check of `isPathAllowed` through the real seeded contract:
    `src/compiler-utils/x.ts` denied `not-owned` while `src/compiler/x.ts` is
    `owned`; cross-role writes denied `forbidden`; `sharedPaths` denied
    `shared-read-only`; `../x`, `src/../../x`, `..\..\x`, `/etc/passwd`, and
    `C:\Windows\x` all denied before matching. Every case failed closed.
  - Bug found and fixed during parent review: the seeded contract left the
    contract itself, `src/coordination/**`, and its tests unowned, so neither
    role could ratify or correct it. `src/coordination/**`,
    `contract-cordination.json`, and `test/coordination-*.test.ts` now belong to
    `orchestrator-a` and are `forbidden` for `orchestrator-b`.
  - The writer reported a vitest `global-setup` OOM (`ERR_WORKER_OUT_OF_MEMORY`
    from tsup). Not reproduced here: the same suite passes without
    `NODE_OPTIONS` overrides. It was a cold `dist/` build, not a defect in this
    change. Do not carry that claim forward as a known problem.
  - Live check: B resolved its own scope from the contract and answered
    `MODULE=compiler-domain`, `OWNED=8`, `CAN_WRITE_SRC_SDK=no`, `_comment`.

- T8 (N roles, worktree precondition, overlap detection) verified by the parent:
  - `npx tsc --noEmit` exit 0; `npx fallow` exit 0.
  - 72 tests pass across 4 files **without** any `NODE_OPTIONS` override. The
    writer reported a vitest `global-setup` OOM again; it still does not
    reproduce here. Treat that claim as environmental noise from the writer's
    machine state, not a property of this repository.
  - `assertCoordinationScopeUsable` against the real repo: **PASS** with three
    linked worktrees and no primary-checkout role. Before A's worktree existed
    the same call failed closed naming `orchestrator-a`, which is the behaviour
    the precondition is supposed to have.
  - Surface audit over sampled real paths: every assigned surface has exactly one
    owner and every other role has it `forbidden`. No double-owned path.
    `src/prepare/**` and `src/utils/**` remain unowned, which is correct: deny by
    default, not a gap.
  - One test written by the writer asserted the contract was *unusable* because
    A's worktree was missing. Creating A's worktree made it fail. The test was
    wrong, not the code: it encoded a transient environment state as an
    invariant. It now asserts the usable case plus a genuine fail-closed case
    (unreadable git root).

### Discovery: a peer can answer from stale context

Asked to resolve its scope, B (`w8:p2`) answered `ROLES=orchestrator-a,orchestrator-b`,
quoted the removed `_comment` field, and claimed it could write `src/cli/**` — the
pre-split contract. The file on disk already had `_ratified` and three roles
(md5 `e84b40c...`). Re-running the prompt with an explicit `cat`/`grep`
instruction produced the correct values.

This matters for the protocol, not just this session: **a peer's report about
the contract is not evidence of the contract.** A response that describes scope
must quote the file it read in the same turn. `validate_response` should treat a
scope claim without a fresh read as unverified, because context is not the repo.

- T9 (extraction to a global package) verified by the parent:
  - Why it moved: `ARCHITECTURE.md:23` assigns external orchestration to "an
    application's own coordinator, **outside this repository**", and
    `test/product-boundary-genericity.test.ts:43` states the dependency direction.
    The code was in `src/coordination/`, which is the product-boundary rule
    inverted. That boundary test passed anyway because it checks imports, not
    location — a control that could not fire.
  - Measured before moving: nothing in this repo imported `src/coordination/`
    outside its own tests, so the move broke no compiler code.
  - Environment fact that decided the destination: an extension in
    `~/.pi/agent/extensions/` cannot resolve bare `zod` (`module.paths` omits
    `~/.pi/agent/npm/node_modules`), so the validator lives in a real package
    with its own `package.json`, not as a loose `.ts` file.
  - Global package `@local/orchestration` at `~/.agents/orchestration`:
    `npm install` clean, `npx tsc --noEmit` exit 0, **72/72 tests pass**, and the
    tests now read `test/fixtures/contract.json` so the suite needs no project
    checkout at all.
  - The global package validates THIS repo's contract: 3 roles, zero overlaps,
    precondition PASS against the three real worktrees.
  - This repo after removal: `npx tsc --noEmit` exit 0, `npx fallow` clean
    (dead code: no issues; 0 above threshold), and `git status` shows no
    `src/coordination/` and no `test/coordination-*`.
  - Contract now carries `_validator` naming `@local/orchestration`, because a
    reader of this repo cannot infer from any in-repo path where the checker
    lives. The `$schema` key was removed rather than left pointing at a file that
    no longer exists.

- T10 (skill moved to the global Pi skill directory) verified by the parent:
  - Destination: `~/.pi/agent/skills/multi-agent-coordination/` (5 files, 617
    lines). Why there and not `~/.agents/skills/`: the home directory is itself a
    git repo but `~/.agents/` is untracked in it, so a skill placed there is not
    versioned. `~/.pi/agent/skills/` is Pi's own global skill location.
  - Loads with 0 diagnostics **from `/tmp`**, with no repository present, which
    is the property that matters: an agent in `.worktrees/orchestrator-b` (no
    `.agents/` of its own) now resolves it.
  - Collision handling verified in `pi-coding-agent/dist/core/skills.js:330-347`:
    user skills load before project skills and the **first wins**, so the global
    copy would have silently shadowed the in-repo one. The in-repo copy was
    deleted rather than left to diverge; `contract-cordination.json` lost its
    `.agents/**` ownership entries as a result.
  - Globality forced two content fixes that were latent bugs the local copy hid:
    the role cards ran `cat contract-cordination.json`, which assumes cwd is the
    repo root and is wrong for a linked worktree or any other project. They now
    run `cat "$(git rev-parse --show-toplevel)/contract-cordination.json"`, and
    `SKILL.md` gained a "This skill is global; the contract is not" section stating
    that every path in the skill is a convention, not a location.
  - Re-verified after the move: 9/9 relative links resolve, 5/5 envelopes still
    parse and satisfy their type, no repo-relative path remains in the skill.
  - In-repo checks after removal: `npx tsc --noEmit` exit 0, `npx fallow` clean,
    `git status` shows no coordination paths and no `.agents/`.

## Still open (deliberately out of scope)

- `_ratified` is present and the contract is ratified for the worktree-per-role,
  N-role, overlap-checked shape. What it does **not** yet carry is a per-path
  sign-off: the assignments were reviewed at the surface level, not file by file.
  T10 should not widen any role's `ownedPaths` without a fresh human decision.
- Both panes currently share one cwd (`/home/urgosxd/Desktop/ofk/llm-wiki-compiler`).
  Worktree separation for B is a precondition of the contract test, not a task here.
- No automated test asserts an envelope parser, because the parser does not exist
  yet. T9 creates it alongside the hook.
- `isPathAllowed` is lexical: it does not call `realpath`, so a symlink inside an
  owned path can point outside the repository. A write-scope hook should pair it
  with `src/utils/path-confine.ts` rather than rely on it alone.
- A `forbiddenPaths` entry written as a bare directory (`src/compiler`) matches
  literally and does not block its children. Only explicit globs do. This is a
  real footgun for whoever edits the contract, and it is intentional: silent
  prefix expansion would make a typo widen a deny rule.
- Herdr `agent read` returns rendered TUI. Any future parser over it is fragile
  by nature; that is why the structured lane is primary.

## Agreed contract

Recorded verbatim, as the protocol requires. The version string is the one both
sides exchanged, not a paraphrase.

| Field | Value |
| --- | --- |
| `contract` | `src/context/links-here.ts@1` |
| Accepted by | `orchestrator-b` (producer) — `cd-2026-10-23-01`, `status: accepted` |
| Consumed by | `orchestrator-c` (`src/commands/links-here.ts` imports `findInboundLinks`, `InboundLink`) |
| Integrated by | `orchestrator-a` — merge `a8e6524` |
| Evidence | `58d9754` (`docs(context): freeze findInboundLinks as contract v1`) |

The interface this freezes:

```ts
export interface InboundLink { from: GraphNodeId; mutual: boolean }
export function findInboundLinks(graph: GraphData, targetId: GraphNodeId): InboundLink[]
```

This is a real dependency, not a rehearsal: `orchestrator-c` already imported
that function before the contract existed, so the negotiation only made an
implicit coupling explicit and versioned.

### T13: what enforcement actually required

The hook was not a matter of wiring `isPathAllowed` into `tool_call`. Two defects
surfaced only when a real agent tried it, which is the argument for testing at the
boundary instead of in a library.

**1. The first hook silently failed open.** A live agent (`orchestrator-b`) wrote
to `src/cli/`, which its role forbids, and the file was created. The reason was
not the scope logic — that returned `DENY(forbidden)` when called directly. The
hook had bound the repository to the agent's *linked worktree* via
`git rev-parse --show-toplevel`, so the contract's relative worktree paths were
resolved twice (`.worktrees/orchestrator-b/.worktrees/orchestrator-a`) and the
precondition could never be satisfied. `assertCoordinationScopeUsable` threw, the
hook failed open by design, and the write succeeded.

The fix is `git rev-parse --path-format=absolute --git-common-dir`, which returns
the same main root from every worktree of the clone. `Binding` now separates
`repoRoot` (main worktree, where the contract and git registry live) from
`roleWorktree` (where that role writes, used to relativise targets).

**2. A valid envelope is not a true one.** B's first `work_result` passed every
format rule and was false: `evidence` cited `be7a396`, which does not contain the
claimed change. `evidence.ts` now resolves the citation in git and requires the
commit to touch every path in `files_changed`. It deliberately does **not** re-run
the `tests` string: executing a command that arrived in a peer message is remote
code execution wearing a verification costume.

Verified end to end with a fresh agent after the fix:

- `write src/cli/blocked-by-hook.ts` → blocked, file absent, reason names the role
  and says to ask the owning role.
- `write src/compiler/allowed-by-hook.ts` → allowed, file created.

Both probes were removed afterwards; the worktree is clean.
