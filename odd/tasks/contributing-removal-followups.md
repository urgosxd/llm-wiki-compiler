# Follow-ups from the CONTRIBUTING.md removal

Two items surfaced while deleting the contributing guide and were deliberately
left out of that delivery.

## 1. Pinning the check names does not protect branch protection

`AGENTS.md`'s `### Branch protection` section names `test-typecheck`,
`codebase-health` and `build-and-test (24)` as required checks, and warns that
renaming a CI job without updating branch protection silently un-gates `main`.

A test can assert that those three names still exist as job keys in
`.github/workflows/*.yml`. It cannot assert **branch protection itself**, which
lives in GitHub repository settings and not in this repository. Such a test would
therefore cover only the half a reader can already see, and leave the setting that
actually un-gates `main` uncovered. Treat it as partial protection and never as
closing the gap.

If it is worth building, it is roughly 20 lines asserting the three job keys exist
— not a suite that pins prose, which breaks on every reflow of the paragraph.

## 2. Stale test count in the partition script

`scripts/test-partition.ts:28` says the kg dimension is "86 files".
`git ls-files 'packages/llmwiki-kg/**/*.test.ts' | wc -l` counts 137.

A wrong count inside the partition script is the kind of number that quietly
mis-partitions a test run. It is unrelated to the contributing removal and was not
touched by it; it is recorded here so it is not lost.
