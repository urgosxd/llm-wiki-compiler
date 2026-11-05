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

- T1 — worktree runnable (`npm ci`) + this feature document. Route: worker. Commit: see Log.
- T2 — add `mammoth@1.13.0` (BSD-2-Clause, pure JS) and the committed fixture generator
  `test/fixtures/documents/make-fixtures.mjs`. Linked: S2, S5.
- T3 — RED-first tests, one per format rule. Linked: S1, S2, S3, S4, S7.
- T4 — `.docx` adapter `src/ingest/docx.ts` + dispatch wiring (`SourceType` union,
  `detectSourceType`, `fetchContent`). Linked: S2, S5.
- T5 — actionable unsupported-format errors in `src/ingest/file.ts` (`.doc`, `.xlsx`,
  unknown) and correct the false "Only .md and .txt files are supported" message, which
  ignores `.pdf`/`.txt`/images/transcripts/web. Linked: S3, S4, S6.
  The `.xlsx` message must name `read-excel-file@9.3.14` as the follow-up path.
- T6 — PDF empty-extraction fix: content consisting solely of page markers is empty and
  throws `No readable content could be extracted from the source.` Linked: S7.
- T7 — differential `.md` check against base commit in a `mktemp -d` scratch tree
  (never committed). Linked: S1.
- T8 — user-facing documentation for the new capability: a `CHANGELOG.md` entry, plus the
  ingest documentation page updated with a supported-formats table and the explicit
  statement that `.doc` (legacy binary Word) and `.xlsx` are refused, with the reason and
  the follow-up path. Also correct any help text or doc page that repeats the false
  "Only .md and .txt files are supported" claim. Linked: S3, S4, S6.
- T9 — gates with exact scope + fallow + record each task's commit. Linked: all.

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
