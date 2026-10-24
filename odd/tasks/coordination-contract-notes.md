# Multi-agent coordination contract notes

Companion to `contract-cordination.json`. The contract enforces; this file
explains why it is shaped this way. Keep them in sync.

## The shape: one role per dimension, plus one coordinator

A owns the wiki dimension. B and C split the KG dimension (B the core and the
adapter, C the runtime surface). The rest of the product is frozen read-only for
every role, so the two dimensions cannot collide with the compiler, the CLI, or
each other.

`orchestrator-main` is not a fourth dimension. It is the coordinating session that
dispatches work and reports, so it owns no product surface at all and runs in the
primary checkout: no worktree is created for it.

## One role runs in the primary checkout

The contract encodes that with an empty `worktree`:

```json
"orchestrator-main": {
  "module": "coordination-and-integration",
  "worktree": "",
  "ownedPaths": [".orchestration-main-readonly/**"],
  "forbiddenPaths": [".worktrees/**", "packages/llmwiki-kg/**", "scripts/**", "src/**", "test/**"]
}
```

Three properties keep that honest:

- **At most one role may declare it.** Two roles with `worktree: ""` is a
  rejection, because two writers in one checkout is the defect the whole contract
  exists to prevent.
- **Only `""` reaches the primary.** A role spelling `.` or `..` still fails, even
  when it is the sole claimant: a relative path that happens to resolve to the
  primary is an accident, not a declaration.
- **The launcher creates nothing for it.** No branch, no `.worktrees/<role>`
  directory; the session starts at the repository root with
  `ORCHESTRATION_ROLE=orchestrator-main`.

## The coordinator writes everything except other roles' checkouts

`orchestrator-main` declares `unrestrictedWrite: true` with `ownedPaths: ["**"]`,
so it may write any path in the repository. Its only limit is `forbiddenPaths`,
which keeps `.worktrees/**`: writing inside another role's checkout corrupts a
tree git is tracking for a different branch.

Why a flag instead of simply owning `**`: `sharedPaths` outranks `ownedPaths` in
the predicate, and this contract lists 79 shared paths. A role that must repair
`package.json` or `docs/**` has to step past that rule explicitly rather than
having it silently removed for everyone. Emptying `sharedPaths` would widen every
other role at the same time.

At most one role may set it. Two unrestricted roles are two writers on every
file, which is the condition the contract exists to prevent, arriving through a
boolean instead of an overlap.

### What the grant costs, stated plainly

1. **It writes on the shared branch.** The role has no branch of its own, so a
   change lands on `main` directly instead of arriving through a merge review.
2. **It can collide with a, b and c.** They write `src/dimensions/**` and
   `packages/llmwiki-kg/ts/src/**` in their own worktrees; `orchestrator-main`
   can write the same paths in the primary checkout. Git sees nothing until merge
   time. This risk was accepted deliberately when the grant was ratified.
3. **It can edit this contract.** `contract-cordination.json` is a shared path, so
   the grant covers it, and the hook re-reads the contract on every tool call. The
   role could therefore widen its own scope. Nothing in the mechanism prevents
   that; only the protocol does, so a contract edit by the coordinator must be
   reviewed by the human as if it were a privileged operation.
4. **The hook guards `write` and `edit`, not `bash`.** A shell command can write
   any path regardless of scope. The contract is a signal plus a tool boundary,
   not a filesystem sandbox. This was true before the grant and is unchanged.

Infrastructure — `contract-cordination.json`, `package.json`, `tsconfig*.json`,
`vitest.config.ts` — is still human territory by convention: ratified by a human,
validated before every commit. The grant makes it *writable* by the coordinator,
not *owned* by it. Keep that distinction when judging a diff.

Every role may still send to the coordinator and receive from it: the message
check validates the envelope and the truth of its claims, never the sender's
identity. `from` equals `to` remains refused, so it cannot address itself.

## Verification is not restricted

Every role may read every path and run tsc, builds, the full test suite, and
fallow, including over frozen files. The enforcement hook intercepts write, edit
and orchestrator_send_message only, so shell commands are never blocked.

One consequence matters for the coordinator: "read-only in the contract" bounds
writes, not verification. `orchestrator-main` can run `tsc`, the tests and fallow
over every surface it does not own — which is exactly what a session that judges
other roles' reports needs to be able to do.

Tests therefore live under each role's ownedPaths, never in sharedPaths:
sharedPaths takes precedence over ownedPaths, so a test path listed there would
make a role unable to write its own tests. The one exception is a role with
`unrestrictedWrite`, which skips the shared check entirely.

## The port is frozen at v1

src/dimensions/types.ts carries DIMENSION_PORT_VERSION. Two roles develop two
dimensions against it concurrently, so a role that needs a different shape sends
a work_request instead of editing it.

## Roles

### `orchestrator-main` — coordination-and-integration

- worktree: none — runs in the primary checkout, on `main`
- `unrestrictedWrite: true` with `ownedPaths: ["**"]`: writes any path except
  `forbiddenPaths`
- forbidden: `.worktrees/**` — another role's checkout
- dispatches work, judges reports, and repairs infrastructure

### `orchestrator-a` — wiki-dimension-and-integration

- worktree `.worktrees/orchestrator-a`
- owns `src/dimensions/wiki/**`
- owns `odd/**`
- owns `test/dimensions/wiki-*`
- owns `test/dimensions/cross-dimension-rollback.test.ts`

### `orchestrator-b` — kg-core-dimension

- worktree `.worktrees/orchestrator-b`
- owns `src/dimensions/kg/**`
- owns `packages/llmwiki-kg/ts/src/core/**`
- owns `packages/llmwiki-kg/ts/src/pydantic/**`
- owns `packages/llmwiki-kg/ts/oracle/**`
- owns `packages/llmwiki-kg/odd/**`
- owns `test/dimensions/kg-dimension.test.ts`
- owns `test/dimensions/kg-core-*`

### `orchestrator-c` — kg-runtime-dimension

- worktree `.worktrees/orchestrator-c`
- owns `packages/llmwiki-kg/ts/src/routes/**`
- owns `packages/llmwiki-kg/ts/src/mcp/**`
- owns `packages/llmwiki-kg/ts/src/*.ts`
- owns `test/dimensions/kg-runtime-*`

## Frozen surface

- `.fallowrc.json`
- `.github/**`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `README.md`
- `SOURCES_CONTRACT.md`
- `contract-cordination.json`
- `docs/**`
- `eslint.config.js`
- `examples/**`
- `package-lock.json`
- `package.json`
- `packages/llmwiki-core/**`
- `packages/llmwiki-dev-backend/**`
- `packages/llmwiki-limited-isolation-backend/**`
- `packages/llmwiki-local-workflows/**`
- `scripts/**`
- `src/artifacts/**`
- `src/capability-providers/**`
- `src/citations/**`
- `src/cli.ts`
- `src/cli/**`
- `src/commands/**`
- `src/compiler/**`
- `src/connectors/**`
- `src/context/**`
- `src/core-index.ts`
- `src/dimensions/activation.ts`
- `src/dimensions/coordinator.ts`
- `src/dimensions/index.ts`
- `src/dimensions/outbox.ts`
- `src/dimensions/reconcile.ts`
- `src/dimensions/types.ts`
- `src/eval/**`
- `src/export/**`
- `src/freshness/**`
- `src/import/**`
- `src/index.ts`
- `src/ingest/**`
- `src/limited-isolation/**`
- `src/linter/**`
- `src/local-workflow-host/**`
- `src/mcp/**`
- `src/operation-bundles/**`
- `src/operations-packs/**`
- `src/pages/**`
- `src/preparations/**`
- `src/products/**`
- `src/profile/**`
- `src/project/**`
- `src/prompt-templates.ts`
- `src/relations/**`
- `src/sdk/**`
- `src/search/**`
- `src/sources/**`
- `src/status/**`
- `src/trust/**`
- `src/utils/**`
- `src/viewer/**`
- `src/wiki/**`
- `src/workflows/**`
- `test-typecheck-baseline.json`
- `tsconfig*.json`
- `tsup.config.ts`
- `vitest.config.ts`
