# Multi-format ingest

Give `llmwiki ingest` document formats beyond Markdown: `.docx` as a first-class source
type, explicit actionable errors for `.doc`/`.xlsx`/unknown extensions, and a fix for the
zero-text PDF that currently ingests silently. `.pdf` already works on base commit; the
real gaps are `.docx`, the misleading error text, and empty extraction.

## Specs

- **S1 — `.md` is unchanged, byte-for-byte.** The Markdown ingest path is an existing
  contract other suites depend on. It must produce identical output after this feature.
  Any difference is a regression, not an improvement.
- **S2 — `.pdf` and `.docx` are in scope.** User's literal words: ".pdf .docxs ,word".
  Recon established `.pdf` ALREADY extracts correctly on base commit `6b83fba`, so S2's
  real delta is `.docx` plus the S7 empty-extraction defect on the PDF path.
- **S3 — Excel is OPTIONAL and is DESCOPED, with evidence.** User's literal words:
  "si excel se complica dejalo". Evidence: npm `xlsx` is frozen at 0.18.5 with two
  unfixed HIGH CVEs (GHSA-4r6h-8v6p-xvw6 / CVE-2023-30533 prototype pollution,
  GHSA-5pgg-2g8v-p4x9 / CVE-2024-22363 ReDoS) whose threat model is reading specially
  crafted files — exactly this pipeline; the patched build exists only as a
  non-registry CDN tarball that breaks lockfile integrity and `npm audit`. `exceljs@4.4.0`
  is CJS-only, 9 deps of archiver/unzipper bulk, no release since 2023, 824 open issues.
  Decision: `.xlsx` gets the documented unsupported-format error. The dispatch seam stays
  format-agnostic so `read-excel-file@9.3.14` (MIT, dual ESM, 4 pure-JS deps) can be added
  later as one file, not one refactor.
  `read-excel-file@9.3.14` is named as the follow-up path both in this document and inside
  the user-facing unsupported-format error for `.xlsx`, so the refusal is actionable rather
  than a dead end.
- **S4 — Legacy binary `.doc` (pre-2007) is NOT in scope.** It needs an external office
  suite. "word" in the user's request is interpreted as `.docx`; this interpretation is
  recorded here explicitly. Passing a `.doc` must produce an error message that names
  `.doc` as unsupported legacy binary Word and points at `.docx`, never an obscure
  generic failure.
- **S5 — One format-dispatch seam, no per-format pipeline fork.** Format detection and
  conversion to plain text happen once, feeding the existing chunking/extraction pipeline
  UNCHANGED. New formats are one adapter plus one dispatch entry, never a new branch
  through the pipeline.
- **S6 — Unsupported or undecodable input fails with an actionable message and writes no
  partial data.** Ingest atomicity (`src/dimensions/coordinator.ts` commit boundary) must
  not be weakened.
- **S7 — Encrypted/password-protected PDFs and corrupt archives fail cleanly**: no crash,
  no stack-trace leak, no silent empty text. Empty extraction must be an ERROR, never a
  silent zero-triplet ingest. Currently UNMET: a zero-text PDF extracts pdf-parse's page
  marker `-- 1 of 1 --`, which passes `enforceMinContent`. FIX LOCATION IS MANDATORY:
  strip the `-- N of M --` page markers inside the PDF adapter (`src/ingest/pdf.ts`), where
  knowledge of pdf-parse's output format belongs. Do NOT teach `enforceMinContent`
  (`src/services/ingest/document.ts:56-62`) about page markers: that validator is shared by
  web, file, image and transcript, and a PDF-specific literal inside it is a leak that will
  mislead the next reader. After stripping, a zero-text PDF yields `""` and the EXISTING
  shared guard throws the EXISTING message, with no new code in the shared path.
  Acceptance: (a) `blank.pdf` throws; (b) content mixing page markers with real text comes
  out with the markers removed and the real text byte-identical; (c) both single-page and
  multi-page documents are covered by tests.

Interpretation record: user's "EL ingest solo acepta .md" is inaccurate for `.pdf` (it
works today). The accurate gap is `.docx`, `.doc`, `.xlsx`.

## Constraints

No NEW prebuilt binaries and no NEW node-gyp/native builds in CI. Note the base repo
already violates the strict form of this rule — `pdf-parse@2.4.5` ships
`@napi-rs/canvas` (Rust/NAPI per-platform binary) as a hard dependency — so the rule is
stated as NEW only. `mammoth@1.13.0` is pure JavaScript and complies.

## Tasks

- T1 — worktree runnable (`npm ci`) + this feature document. Route: worker. Linked: all.
  - commit: cbb7b21
- T2 — add `mammoth@1.13.0` (BSD-2-Clause, pure JS) and the committed fixture generator
  `test/fixtures/documents/make-fixtures.mjs`. Linked: S2, S5.
  - commit: 5d49e92 (dependency + externalization)
  - commit: 8f35863 (fixture generator and generated fixtures)
- T3 — RED-first tests, one per format rule. Linked: S1, S2, S3, S4, S7.
  - commit: 360aa40 (docx, refusal, dispatch and preservation tests)
  - commit: 921f246 (PDF marker/preservation tests; the split follows the behavior
    each half pins, because the PDF contract changed with pdf-parse's own option)
- T4 — `.docx` adapter `src/ingest/docx.ts` + dispatch wiring (`SourceType` union,
  `detectSourceType`, `fetchContent`). Linked: S2, S5.
  - commit: 360aa40
- T5 — actionable unsupported-format errors in `src/ingest/file.ts` (`.doc`, `.xlsx`,
  unknown) and correct the false "Only .md and .txt files are supported" message, which
  ignores `.pdf`/`.txt`/images/transcripts/web. Linked: S3, S4, S6.
  The `.xlsx` message must name `read-excel-file@9.3.14` as the follow-up path.
  - commit: 360aa40
- T6 — PDF empty-extraction fix: content consisting solely of page markers is empty and
  throws `No readable content could be extracted from the source.` Linked: S7.
  The markers are suppressed by pdf-parse's own `pageJoiner` option rather than stripped
  from the finished text; see L8.2.
  - commit: 921f246
- T7 — differential `.md` check against base commit in a `mktemp -d` scratch tree
  (never committed). Linked: S1.
  - commit: none (verification evidence only; the check produced no code)
- T8 — user-facing documentation for the new capability: a `CHANGELOG.md` entry, plus the
  ingest documentation page updated with a supported-formats table and the explicit
  statement that `.doc` (legacy binary Word) and `.xlsx` are refused, with the reason and
  the follow-up path. Also correct any help text or doc page that repeats the false
  "Only .md and .txt files are supported" claim. Linked: S3, S4, S6.
  - commit: 502bcbd
- T9 — gates with exact scope + fallow + record each task's commit. Linked: all.
  - commit: this commit, `docs(odd): record commit evidence for multi-format ingest tasks`.
    A commit cannot carry its own SHA in its own content, so it is named by subject here;
    it is the last commit of the feature.

## Log

- L1 (user request, verbatim): "EL ingest solo acepta .md, ahora debe aceptar .pdf .docxs
  ,word ,excel, si excel se complica dejalo"
- L2 (Lead recon, evidence: probe of base `6b83fba`): `.md` verbatim, `.txt` fenced,
  `.pdf` extracts via `src/ingest/pdf.ts` (`Ingesting [pdf]` + short-content warning proves
  it cleared `fetchContent`). `.docx`/`.doc`/`.xyz` fall through
  `src/services/ingest/source-detection.ts` to `"file"` and are rejected by the guard in
  `src/ingest/file.ts:29-33`. Guard order: `detectSourceType` -> `fetchContent` ->
  `enforceCharLimit` -> `enforceMinContent` -> `buildDocument` -> `writeToDimensions`.
  The `.md`/`.txt` guard is inside the `file` case only.
- L3 (Lead decision, S3): Excel descoped per evidence in S3. `.docx` uses mammoth.
- L4 (Lead decision): "word" = `.docx`. `.doc` out of scope with an explicit message.
- L5 (Lead recon, environment): worktree has no `node_modules`; `npm ci` required; tests
  run through vitest (bare `llmwiki-kg` import at `src/dimensions/activation.ts:45` is
  aliased only in `vitest.config.ts`); CLI only through `npm run build`; end-to-end ingest
  also needs Postgres. Harness Node is v22.23.2 while `engines.node` is `>=24`.
- L6 (Manager rulings, accepted): (1) `.xlsx` stays descoped and `read-excel-file` is NOT
  added now; name it in the error and the doc. (2) The empty-PDF fix moves into the PDF
  adapter; `enforceMinContent` stays format-agnostic. (3) The no-prebuilt-binary constraint
  is restated as NEW-only, because `pdf-parse` already ships `@napi-rs/canvas`. (4) The
  false unsupported-type message is a defect in its own right and must be fixed along with
  any doc/help text that repeats it. (5) Format support ships as documented user-facing
  capability: `CHANGELOG.md` entry plus the ingest doc page.
- L7 (Manager ruling): run `npm ci` at root. If Node v22.23.2 against `engines: >=24`
  blocks install, tests or build, stop and report an environment blocker with the exact
  error rather than working around it. "No partial data" is verified at adapter and
  transaction level, not via a live CLI write, because end-to-end ingest requires Postgres;
  this is a reported scope limitation.
- L8 (hardening, pre-commit): independent verification found three defects in the first implementation, all fixed before the first commit. (1) Bundling CJS mammoth into the ESM core crashed the built CLI with "Dynamic require of url is not supported" and failed 89 escalated tests; mammoth is now externalized and declared in the core manifest. (2) The first marker stripper deleted prose lines that merely resembled a page marker; it was replaced by pdf-parse's own page-joining option so markers are never emitted. (3) Fallow dead-code/duplication and two vacuous "writes nothing" tests were removed.
- L9 (lesson, verification): a green build is not evidence of a working artifact. The first implementation passed `npm run build` (exit 0) and 26/26 focused tests while the built CLI could not start at all — bundling the CommonJS `mammoth` into the ESM core output produced `Error: Dynamic require of "url" is not supported` and failed 89 escalated tests. Only the full-tier run exposed it. A smoke check of `node dist/cli.js --version` is now part of the verification list for every change that touches the bundle or adds a runtime dependency, alongside a check that the built chunk carries the dependency as a bare external specifier rather than bundled source.
- L10 (scope limit, not a failure): (a) `.docx` is verified at adapter and dispatch level with no live write. The reason is a design one, not an environmental one: an end-to-end CLI ingest exercises the extraction model, so a live write would need a provider stub, and that dependency is what makes end-to-end ingest a separate slice. The atomicity guarantee is therefore verified structurally — no write call in any adapter, refusals throw before `readFile`, and the `coordinator.ts` and `document.ts` diffs are empty — rather than by execution. The database was reachable during this work (`llmwiki-kg-db-1` on :5434, with all DB-dependent integration files passing), so the absence of a live write is a choice about extraction dependencies, not an environment limitation. Live end-to-end `.docx` ingest through the CLI is named as the follow-up, to be done once the provider stub exists and the concurrent DB-infrastructure branch has settled. (b) `.xlsx` is refused BY DECISION, not by inability: npm `xlsx` is frozen at 0.18.5 with unpatched GHSA-4r6h-8v6p-xvw6 (CVE-2023-30533) and GHSA-5pgg-2g8v-p4x9 (CVE-2024-22363) whose threat model is reading specially crafted files, and the patched build ships only as a non-registry CDN tarball; `exceljs` is unmaintained since 2023. `read-excel-file@9.3.14` is the tracked follow-up, named in the user-facing refusal.
- L11 (correction): the four suites previously reported as pre-existing failures (`test/mcp-stdio`, `test/okf-mcp-stdio`, `test/recursive-source-inventory`, and `test/parity-default` in part) actually PASS once `dist/` is freshly built. The earlier "pre-existing failure" excuse was wrong and is retracted; the escalated tier now runs 631/631 files and 4621/4621 tests with zero failures.
- L12 (manifest drift fixed): `packages/llmwiki-core/tsup.config.ts` externalized `@modelcontextprotocol/sdk` and `@hono/node-server` while `packages/llmwiki-core/package.json` declared neither, so the manifest asserted something untrue and only the workspace hoist kept it working. Both are now declared with the versions already resolved in the lockfile.
- L13 (known quirk, accepted): `test/test-partition.test.ts` is itself classified into the INTEGRATION tier, because the sample literals it uses to exercise `classifyTests` (`runCLI(`, `execFileSync(`, `spawnSync(`, `spawn(`, `execFile(`, `npm pack`, `fixtures/cli-runner`) match the very spawn patterns it tests for. The partition pin on `test/parity-default.test.ts` therefore bites in the integration tier and in CI's exhaustive `npm test`, but NOT in the 630-file local fast loop. This is accepted rather than fixed: making the file self-classify as a unit suite would require composing those literals at runtime, i.e. hiding its own samples from its own detector, which would weaken the test. The assertion is about `classifyTests` output, so the pin remains valid wherever the file is collected.
