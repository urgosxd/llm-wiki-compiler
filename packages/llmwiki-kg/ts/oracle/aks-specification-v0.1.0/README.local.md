# AKS Specification v0.1.0 — vendored reference

This directory is a **verbatim, unmodified copy** of the upstream specification
that this server implements. It is vendored so that a decision about protocol
behaviour can be checked against the standard without network access, and so a
future reader can tell what the spec said at the version this code targets.

## Provenance

| | |
| --- | --- |
| Source | https://github.com/Agent-Knowledge-Standard/AKS-Specification |
| Commit | `bc823073bcf3c1e47ffc6754cdc02967d9874c63` |
| Commit date | 2026-04-23 |
| Commit subject | `refactor: clean up spec version` |
| Spec version | `0.1.0` (declared in `README.md` and in `SCHEMA.json`'s `aks_version` const) |
| License | Apache License 2.0 — see `LICENSE` in this directory |

**Do not edit these files.** They are a record of what upstream published, not a
place to record local decisions. A local deviation belongs in
`../../odd/findings/aks-spec-conformance.md`, which is where this package already
tracks its disagreements with the reference. If the upstream changes, re-vendor at
a new commit and update the table above rather than patching in place.

`README.local.md` (this file) is the only file in this directory that is not
upstream content.

## What each file is for

| File | Read it when |
| --- | --- |
| `README.md` | You need the normative prose: what a Knowledge Stack is, the export format, the query interface, entity pages, backfeed, document audit, conformance. 693 lines, 24 sections. |
| `SCHEMA.json` | You need the exact wire shape of a bundle, entity, relationship, run, page, backfeed item, or document audit. This is the file to check field names and `additionalProperties` against. |
| `CONFORMANCE.md` | You need the checklist of MUST/SHOULD requirements, grouped by area, as checkbox items. The fastest way to find out whether something is REQUIRED. |
| `GLOSSARY.md` | A term in the spec is being read differently by two people, or a term looks like it means what this codebase means. |
| `DECISIONS.md` | You are about to argue for a design and want to know whether the standard already settled it, and why. |
| `ROADMAP.md` | You are about to build something and want to know whether the standard deliberately left it unspecified. |
| `CONTRIBUTING.md` | You want to propose an upstream change rather than a local deviation. |
| `LICENSE` | Apache 2.0 terms for redistribution. |

## Which one wins

Three different things call themselves authoritative in this repository, and they
do not rank equally. In order:

1. **`oracle/contracts/openapi.json` and the captured corpora** — the frozen
   record of the Python server this package ports. These describe what the
   *implementation being ported* actually did, measured.
2. **This specification** — what an AKS implementation *should* do.
3. **The local code and its comments** — what this port currently does.

Where (1) and (2) agree, there is nothing to decide. Where they disagree, the port
follows (1) by default, because the package's stated purpose is a faithful port,
and a deviation from the oracle is a bug unless it is deliberate and recorded.
Where (2) requires something (1) never did, that is a **feature**, not a port fix:
it needs its own decision and its own evidence.

Concretely: this file does not authorize any behaviour change. It is a citation
source.

## Where this package already diverges, or is silent

Recorded here because the point of vendoring the spec is to make these visible.
Full analysis with measurements: `../../odd/findings/aks-spec-conformance.md`.

### Known divergence: bundles declare `aks_version: "0.2.0"`

`CONFORMANCE.md:13` requires `aks_version: "0.1.0"`, and `SCHEMA.json` pins it as
a `const`. This package emits `"0.2.0"` (`src/routes/aks/export.ts:166`), which is
also what the oracle's contract records — so the port is faithful and
non-conformant at the same time. Every exported bundle fails a strict validator.
Details and options: `../../odd/findings/aks-spec-conformance.md` §1b.

### Known divergence: `AKSDocument.audit` uses a key the spec forbids

`SCHEMA.json` defines `AKSDocumentAudit` with `additionalProperties: false` and
exactly seven permitted properties: `duplicate_score`, `staleness_score`,
`quality_classification`, `contradiction_count`, `contradiction_flags`, `passed`,
`recommendation`.

This package writes `{"ontology": {...}}` into that column — the ontology
enforcement report added after review. That key is **not permitted** by the
schema, so a strict validator reading `GET /documents/:id` against
`SCHEMA.json` would reject the audit object.

This is a real, recorded deviation rather than an oversight; the decision and the
alternatives are in the findings document. It is listed first here because it is
the only place this package currently emits a payload the spec's own schema
rejects.

### The spec is silent on declared ontologies

Nothing in `README.md`, `CONFORMANCE.md`, `GLOSSARY.md` or `SCHEMA.json` defines
an entity-type or relationship-type declaration, an allowlist, or enforcement of
one. `SCHEMA.json`'s `AKSEntity.type` and `AKSRelationship.type` are plain
strings, and `CONFORMANCE.md` requires only that `type` be present.

The closest touchpoint is `GET /aks/v1/traverse`'s optional `relationship_types`
filter (`README.md:410`), which *filters a traversal* rather than constraining
what may be written.

So: the `stacks.ontology` column and its enforcement are an **extension** of this
implementation, not a requirement of the standard. That is worth knowing before
anyone cites AKS as authority for the feature — including in this repository,
where several comments describe the oracle's `strict=False` permissiveness as the
contract and the declaration as an addition to it. Both are correct, but they are
answers to different questions.

### Where the spec does bear directly on code in this package

- **Backfeed requires human review and marks absorbed knowledge as verified**
  (`README.md:499`): on approval, entities and relationships are added with
  `source.verified = true` and `source.source_kind = "backfeed"`. The
  approval-gate work in `../../odd/tasks/kg-stack-ontology-enforcement.md` is
  compatible — it adds a refusal path — but nothing verifies the
  `source.verified` marking, which is a MUST.
- **Document audit is a SHOULD, run *before* ingestion** (`README.md:517`). This
  package's audit is written *after* extraction and records ontology rejections,
  which is a different question from document quality. Both are legitimate; they
  are not the same field's purpose.
- **`GET /aks/v1/export` must satisfy `AKSBundle`**, including
  `source.verified` defaulting to `false` for machine-extracted knowledge
  (`CONFORMANCE.md`, Required). The export path is outside this role's surface;
  recorded here so it is not lost.
