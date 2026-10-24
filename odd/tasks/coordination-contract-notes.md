# Multi-agent coordination contract notes

Companion to `contract-cordination.json`. The contract enforces; this file
explains why it is shaped this way. Keep them in sync.

## The shape: one role per dimension, plus one coordinator

A owns the wiki dimension. B owns the entire KG dimension — the vendored core, the
pydantic wire layer, the oracle contracts, the runtime surface (routes, MCP, the
`ts/src/*.ts` modules) and the `src/dimensions/kg` adapter. The rest of the
product is frozen read-only for every feature role, so the two dimensions cannot
collide with the compiler, the CLI, or each other.

`orchestrator-main` is not a third dimension. It is the coordinating session: it
dispatches work, judges reports, holds integration authority for `main`, and owns
the repository-level `odd/**` decision record. It runs in the primary checkout, so
no worktree is created for it.

### Why B and C were merged

The original split gave B the KG core and C the KG runtime surface. In practice
the two could not work independently: almost every KG change crossed that line,
so B and C spent their traffic on `contract_proposal`/`contract_decision`
envelopes about one package's internal wiring rather than on the dimension itself.
The `kg-ontology-from-json` record is the clearest case — its slices 1 and 2 are
one feature separated only by which side of `ts/src/core-index.ts` they touch.

One role per *dimension* is the rule the contract is expressing; splitting a
dimension by layer inside it was the mistake. `orchestrator-c` is retired and its
paths moved to `orchestrator-b`. The agreements already recorded between them
(`cp-2026-10-23-01/03/04`) stay valid as history; they are simply intra-role now,
so they no longer need an envelope.

## One role runs in the primary checkout

The contract encodes that with an empty `worktree`:

```json
"orchestrator-main": {
  "module": "coordination-and-integration",
  "worktree": "",
  "unrestrictedWrite": true,
  "ownedPaths": ["**"],
  "forbiddenPaths": [".worktrees/**"]
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
2. **It can collide with a and b.** They write `src/dimensions/**` and
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

## Every role records its own tasks in `odd/`

A role that cannot write its own feature document cannot close its own work: it
can implement and verify, and then have no way to check a box. So `odd/tasks/**`
is partitioned by feature prefix, one disjoint slice per role:

| Slice | Role |
| --- | --- |
| `odd/tasks/wiki-*` | `orchestrator-a` |
| `odd/tasks/multi-tenant-*` | `orchestrator-a` |
| `odd/tasks/kg-*` | `orchestrator-b` |
| everything else | `orchestrator-main` |

Two constraints shaped that partition, and guessing either of them wrong produces
a contract that looks fine and is not:

1. **`odd/**` cannot be shared by two roles.** `findOwnershipOverlaps` rejects an
   identical pattern in two roles and a directory glob that contains another
   role's pattern, so a common `odd/**` is a contract error, not a convenience.
   There is also no shared-writable tier — `sharedPaths` is read-only by
   definition. A disjoint split is the only shape available.
2. **A broad `forbiddenPaths` silently cancels a narrow `ownedPaths`.**
   `forbidden` outranks `owned`, so leaving `odd/**` in a role's prohibitions while
   granting it `odd/tasks/kg-*` yields `forbidden`, not a narrower grant. Both
   role entries had exactly that bug at one point and it read as "the role was
   never granted anything". When adding a narrow grant, remove the broad
   prohibition in the same edit.

`odd/tasks/kg-dimension.md` is the one two-dimensional document: it describes the
split of ingest across both dimensions. It stays with `orchestrator-b` because its
subject is the KG side of that split, and `orchestrator-a`'s half of the same work
is recorded in `multi-tenant-storage.md`, which A owns. A role that needs a change
in another role's document requests it; it does not take the file.

## Integration authority is a protocol fact, not a schema field

`scope.ts` validates each role with `z.strictObject`, so an unknown key fails the
whole contract and — because the hook fails open on an unusable contract — would
unenforce every live session at once. There is therefore no `integration: true`
field to add, and none was invented. Integration authority lives where the
protocol puts it: in the `module` label, in this memo, and in the rule that the
author of a branch never merges their own work. The mechanical consequence is
simply that `orchestrator-a` and `orchestrator-b` hold no merge step and
`orchestrator-main` holds the only one.

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
- **holds integration authority**: it is the only session that merges a feature
  branch into `main`, and the author of a branch never merges their own work
- owns `odd/**`, the repository-level decision record

### `orchestrator-a` — wiki-dimension

- worktree `.worktrees/orchestrator-a`
- owns `src/dimensions/wiki/**`
- owns `test/dimensions/wiki-*`
- owns `test/dimensions/cross-dimension-rollback.test.ts`
- owns `odd/tasks/wiki-*` and `odd/tasks/multi-tenant-*`

### `orchestrator-b` — kg-dimension

- worktree `.worktrees/orchestrator-b`
- owns `src/dimensions/kg/**`
- owns `odd/tasks/kg-*`
- owns `packages/llmwiki-kg/ts/src/core/**`
- owns `packages/llmwiki-kg/ts/src/pydantic/**`
- owns `packages/llmwiki-kg/ts/src/routes/**`
- owns `packages/llmwiki-kg/ts/src/mcp/**`
- owns `packages/llmwiki-kg/ts/src/*.ts`
- owns `packages/llmwiki-kg/ts/oracle/**`
- owns `packages/llmwiki-kg/odd/**`
- owns `test/dimensions/kg-core-*`, `kg-runtime-*`, `kg-dimension`, `kg-forget`,
  `kg-postgres-integrity`, `kg-read-service`, `kg-reader`

### `orchestrator-c` — retired

Merged into `orchestrator-b`. Its paths, its worktree and its test glob moved
with it, and the role key is gone from the contract: an undeclared role is
refused by `resolveRole`, so a session still launched with
`ORCHESTRATION_ROLE=orchestrator-c` fails closed instead of writing unenforced.

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
