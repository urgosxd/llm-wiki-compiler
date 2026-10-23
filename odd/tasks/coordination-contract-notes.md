# Multi-agent coordination contract notes

Companion to `contract-cordination.json`. The contract enforces; this file
explains why it is shaped this way. Keep them in sync.

## The shape: one role per dimension

A owns the wiki dimension. B and C split the KG dimension (B the core and the
adapter, C the runtime surface). The rest of the product is frozen read-only for
every role, so the two dimensions cannot collide with the compiler, the CLI, or
each other.

Infrastructure — `contract-cordination.json`, `package.json`, `tsconfig*.json`,
`vitest.config.ts` — belongs to no role. A feature role with veto power over
everyone else's dependencies is a bottleneck, not an owner. Those files are
coordinator territory: edited from the primary checkout, validated before every
commit, and frozen for the roles.

## Verification is not restricted

Every role may read every path and run tsc, builds, the full test suite, and
fallow, including over frozen files. The enforcement hook intercepts write, edit
and orchestrator_send_message only, so shell commands are never blocked.

Tests therefore live under each role's ownedPaths, never in sharedPaths:
sharedPaths takes precedence over ownedPaths, so a test path listed there would
make a role unable to write its own tests.

## The port is frozen at v1

src/dimensions/types.ts carries DIMENSION_PORT_VERSION. Two roles develop two
dimensions against it concurrently, so a role that needs a different shape sends
a work_request instead of editing it.

## Roles

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
