# links-here — traverse the wiki backwards (A ← B)

## Goal

Make the compiled wiki navigable in the INBOUND direction, so a reader can ask
"which concepts point at this one?" and walk from B back to A.

The wiki already records outbound direction only: each page stores the links it
casts (`outgoingLinks`, `src/viewer/types.ts:124`), so A → B works and B → A is
invisible. `src/context/graph.ts` already builds the inverse adjacency
(`buildAdjacency`, line ~205, `incoming` map) but that map lives inside context
expansion and is never exposed. This change reads it through one small pure
function and surfaces it as a read-only command.

## Non-goals

- No Wikipedia feature set: no categories, portals, redirects, history, or talk
  pages.
- No write path, no LLM call, no recompile.
- Not an alias fix. Aliases are generated (`src/compiler/obsidian.ts:48`) but the
  resolver indexes titles only (`src/compiler/resolver.ts:41`). That is a
  separate, later change.

## Acceptance criteria

1. `linksHere(graph, targetId)` returns the inbound sources for one target,
   sorted and de-duplicated.
2. Bidirectional pairs (A→B and B→A) collapse to one entry, matching the
   canonical unordered-pair rule already documented in `graph.ts`.
3. Ghost (dangling) targets are excluded, consistent with `collectGhostIds`.
4. `llmwiki links-here <slug>` prints inbound pages as a human list and, with
   `--json`, a stable envelope for agent consumption.
5. The command is read-only and needs no provider credentials.
6. An unknown slug reports "no inbound links" rather than failing.

## Tasks

- [x] T1 Write `odd/tasks/links-here.md` (this document).
- [x] T2 Add pure `src/context/links-here.ts` over `GraphData`.
- [x] T3 Add `src/commands/links-here.ts` (CLI command + JSON envelope).
- [x] T4 Register `llmwiki links-here` in the CLI.
- [x] T5 Tests: inbound resolution, bidirectional collapse, ghosts, unknown slug.
- [x] T6 Document the command.

## Evidence

- `test/context-links-here.test.ts` — 7 tests, all passing.
- End-to-end against `examples/basic`: `links-here knowledge-compilation` reports
  6 inbound pages; `--json` emits the v1 envelope; unknown slug exits 0 with
  `resolved: false`.
- Checks: `npx tsc --noEmit` clean, `npm run build` clean.

## Note on the `mutual` flag

The first implementation computed `mutual` from the SOURCE's own out-edges, which
made every inbound link look mutual — by definition an inbound link already points
at the target. The unit test caught it before the command shipped. `mutual` now
checks the TARGET's out-edges, so it truly means "the pair is linked both ways".

## Still open (deliberately out of scope)

- Aliases are generated (`src/compiler/obsidian.ts:48`) but the resolver indexes
  titles only (`src/compiler/resolver.ts:41`), so acronym mentions never become
  links. This remains the highest-value connectivity fix.
- No lint rule flags a page with zero inbound links. `links-here` makes the
  measurement possible; turning it into a rule is a separate change.
