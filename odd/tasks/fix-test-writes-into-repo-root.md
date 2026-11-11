# fix-test-writes-into-repo-root

Investigation of an untracked 9-byte file named `target` (content exactly `untouched`, no trailing newline) that appeared at a repository root and dirtied the checkout. Branch `fix/test-writes-into-repo-root`, base `fa9c1f5856a031a2eac4ba3805a2e75ef5dd18f6`.

## Specs

S1. If such an escape is real, the write must land under the temp root regardless of the process working directory.
S2. The repository root must be unchanged by the run: no file named `target` may exist there afterwards.
S3. The write itself must still happen; removing the behaviour under test is not a fix.

## Tasks

T1. Determine, with evidence, whether a test writes `target` into the repository root. Status: done — verdict **NOT REPRODUCED**.
T2. Fix the anchoring so the write cannot leave the temp root, and pin it with a test. Status: dropped — the escape was not reproduced, so there is no anchoring fault to fix and no RED to observe.
T3. Record the latent hazard in L3. Status: done (documentation only).

## Log

L1 (original request): "Determine, with evidence, whether a test writes an artefact into the repository root instead of its temp directory — and fix it if it does." Two outcomes were declared equally acceptable: ESCAPE REPRODUCED (fix the anchoring so the write cannot leave the temp root regardless of cwd, and pin it) or NOT REPRODUCED ("no code path can put those bytes at the repo root, and the stray's provenance is unknown. Say so with the evidence and stop. Do not manufacture a culprit").

L2 (verdict, NOT REPRODUCED): `test/fixtures/confinement-roots.ts:39-40` is the only definer of `ctx.outside`, filling it in `beforeEach` with `mkdtemp(path.join(os.tmpdir(), ...))` — absolute, random-suffixed — and resetting it to `""` in `afterEach`. `path.join(ctx.outside, "target")` therefore cannot equal `<cwd>/target`. `path.join("", "target") === "target"` is a real mechanism requiring the test body to run before `beforeEach`, which cannot happen; a rejected `mkdtemp` aborts before the write. Adversarial probes: absolute `TMPDIR` lands the leaf inside the mkdtemp dir; `TMPDIR=rel-tmp` resolves to `<cwd>/rel-tmp/binary-store-outside-XXXX/target`, still not a bare `target`; `TMPDIR=""` falls back to `/tmp`. `test/embeddings-binary-storage.test.ts:71` is the only writer of exactly those bytes; the file's other `writeFile` sites (`:25`, `:58`, `:81`) target `path.join(ctx.root, ".llmwiki", name)`. `test/portable-nofollow.test.ts:48,56,82` writes a file named `target` with different bytes (`must not read` / `original`). Provenance of the stray is unknown and is recorded as unknown, not attributed.

L3 (latent hazard — recorded, not fixed): an `""`-initialised field on a harness context object, joined into a path, resolves to a path relative to `process.cwd()` until `beforeEach` fills it. That is one `beforeEach` reordering, one early import-time use, or one dropped setup away from writing into the repository root. Seven instances exist in the tree:
  - `test/fixtures/confinement-roots.ts:36`
  - `test/fixtures/command-project.ts:9`
  - `test/fixtures/compile-project.ts:67`
  - `test/fixtures/lint-temp-root.ts:74`
  - `test/fixtures/okf-temp-dir.ts:29`
  - `test/fixtures/seed-pages-harness.ts:29`
  - `test/fixtures/temp-root.ts:93`

This is a **latent** trap, not a live defect: no current code path reaches it. The harnesses were deliberately left untouched. Pinning it needs a test observed RED and GREEN, which needs a working install at `fa9c1f58` (`node_modules/@repo` was missing at the time of this log) — a follow-up, not this slice.

L4 (correction to L2 — appended, not edited): the line anchors L2 gives for `test/portable-nofollow.test.ts` were wrong. `:48`, `:56` and `:82` are the `const target = path.join(root, "target")` declarations; the writes themselves are at `:50`, `:58` and `:84`. L2 is deliberately left as written so that the error and its correction sit beside each other instead of the record reading as though it had always been right. The claim L2 supports is unaffected: those sibling tests write a file named `target` with bytes `must not read` / `original`, neither of which is `untouched`, so neither can be the stray's source.
