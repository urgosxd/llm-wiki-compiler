# Multi-agent coordination contract notes

Companion to `contract-cordination.json`. The contract enforces; this file
explains why it is shaped this way. Keep them in sync — a shape change belongs
in both.

## Shared surface

sharedPaths is READ-ONLY for every role and takes precedence over ownedPaths, so nothing here may also appear in an ownedPaths entry. It freezes the product's compiler, context, CLI, commands, linter, utils and trust trees: roles may read them and run tsc/build/test/fallow, but never edit them. Unfreezing any of these is a contract change, not a role's decision.

## Test policy

Tests live under each role's ownedPaths, never in sharedPaths: sharedPaths blocks writes even for the owning role. Every role may still read every test and execute the full suite, because the enforcement hook intercepts write/edit and orchestrator_send_message only - bash commands are never blocked, so tsc, npm run build, npm test and fallow are available to all roles.

## Frozen dimension surface

src/dimensions/types.ts, coordinator.ts, outbox.ts, reconcile.ts, activation.ts and index.ts are the shared port and transaction machinery and are frozen for every role. A dimension that needs a change there sends a work_request to orchestrator-a instead of editing it.


## Roles

### `orchestrator-a` — wiki-dimension-and-integration

- worktree `.worktrees/orchestrator-a`
- owns `src/dimensions/wiki/**`
- owns `contract-cordination.json`
- owns `package.json`
- owns `tsconfig*.json`
- owns `vitest.config.ts`
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

## Frozen and read-only surface

`sharedPaths` is read-only for every role **and takes precedence over
`ownedPaths`**, so nothing below may appear in an owned list. It freezes the
product so the two dimension roles cannot collide with the compiler, CLI, or
each other:

- `.fallowrc.json`
- `.github/**`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `README.md`
- `SOURCES_CONTRACT.md`
- `docs/**`
- `eslint.config.js`
- `examples/**`
- `package-lock.json`
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
- `tsup.config.ts`
