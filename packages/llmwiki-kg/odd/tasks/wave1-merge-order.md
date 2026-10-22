# Wave 1 merge order and the server.ts hub

## The problem this records

Three slices ran in parallel worktrees. All three needed a line in
`ts/src/server.ts`, because that is where routers are mounted — and I had
excluded that file from every slice's edit surfaces while also requiring each
slice to verify against a real booted server.

Two of the three came back with `interaction_required` blocked on exactly that:
without the mount, `createApp()` 404s on their routes, so their integration
verification could only run against a hand-composed stand-in app. The
consolidation slice said so plainly instead of quietly settling for the
stand-in.

**This was my scheduling error, not theirs.** The surfaces were drawn too
narrowly: `server.ts` is a convergence point, not any slice's private file.

## Resolution

Each slice was authorised to add exactly its own mount, nothing else, with an
explicit instruction to keep the diff to the import plus one `app.use` line.

Resulting diffs, verified:

- consolidation: **2 insertions, 0 deletions** (confirmed by reading the diff).
- documents: mounting at the app root, because its Python router declares no
  prefix and uses absolute paths — verified: `APIRouter(` with no `prefix=` in
  `app/routers/documents.py:30`, and paths `/stacks/{stack_id}/documents`,
  `/documents/{doc_id}`.
- mcp: no `server.ts` change; it is a stdio server, not an HTTP mount.

## Required final order in createApp

```
createMethodNotAllowed
  -> express.json({strict:false})
  -> /stacks              (createStacksRouter)
  -> /aks/v1/backfeed     (createBackfeedRouter)
  -> documents            (createDocumentsRouter, root mount, no prefix)
  -> 404 fallback
  -> error handler
```

The three router mounts must all sit **before** the 404 fallback, or the
fallback swallows them. That ordering is the one thing a careless union merge
can break, since each slice added its line adjacent to `/stacks` and the merge
of three adjacent insertions is where order is decided.

## `createApp` signature

Widened to an intersection:

```ts
export function createApp(
  deps?: StacksRouterDependencies & DocumentsRouterDependencies,
): Express
```

Chosen over a shared base type or union specifically so no slice had to modify
`stacks.ts` or touch a shared dependency module — the intersection is additive
and each slice keeps its own dependency interface.

## Lesson for Wave 2

Do not hand `server.ts` to three parallel writers. Either:

- assign the mount to one slice and have the others return an unmounted router, or
- have the orchestrator own `server.ts` entirely and mount every router in one
  ordered commit after the slices land.

The three-line-diff approach worked, but only because each diff was tiny and
placed at the same anchor. At four or five slices it stops being a union merge.
