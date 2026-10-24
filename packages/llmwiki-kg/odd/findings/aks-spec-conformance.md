# AKS spec conformance: where this package diverges, and where the spec is silent

**Status:** open — two real divergences, one extension, several unverified MUSTs
**Reference:** `ts/oracle/aks-specification-v0.1.0/` (vendored, commit `bc82307`, spec `0.1.0`)
**Why this exists:** the spec was vendored so protocol decisions can be cited
instead of remembered. Reading it against the code surfaced two payloads this
package emits that the spec's own schema rejects.

## The method

The vendored copy is byte-identical to upstream (verified with `cmp` per file).
Every claim below names the spec artifact it came from — `SCHEMA.json` a JSON
path, `CONFORMANCE.md` a checklist item, `README.md` a line — rather than
paraphrasing a section title. A claim without a citation did not go in.

---

## 1. DIVERGENCE: `AKSDocument.audit` carries a key the schema forbids

**Severity:** real. A strict consumer validating against `SCHEMA.json` rejects
this payload.

`SCHEMA.json` → `$defs.AKSDocumentAudit`:

```json
"additionalProperties": false,
"properties": {
  "duplicate_score", "staleness_score", "quality_classification",
  "contradiction_count", "contradiction_flags", "passed", "recommendation"
}
```

Seven permitted keys. This package writes an eighth:

```json
{"ontology": {"enforced": true, "rejected": 2, "reason_codes": ["UNKNOWN_ENTITY_TYPE"]}}
```

Measured, not inferred:

```
spec allows only: ['contradiction_count', 'contradiction_flags', 'duplicate_score',
                   'passed', 'quality_classification', 'recommendation', 'staleness_score']
we write:         ['ontology']
VIOLATION:        ['ontology']
additionalProperties: False
```

The write is in `src/routes/ingest/pipeline.ts` (`recordOntologyAudit`), using
`jsonb_set(..., create_missing => true)` so it merges rather than replaces. It
reaches the wire through `GET /documents/:id`, whose response includes `audit`.

### Why it happened

The column was chosen *because* it was unused and documented as a placeholder for
"structured audit results later". That reasoning was sound and incomplete: the
column is placeholder-shaped in the DDL, but the spec has already claimed it for
**document quality**, with a closed property set. Reusing a reserved field is not
the same as being its owner.

### The three ways out

| Option | Cost | Consequence |
| --- | --- | --- |
| Move the report out of `audit` — e.g. a sibling column, or keep it in the ingest response instead | DDL for a new column, or a response-shape change that breaks oracle parity | Conformant. `audit` returns to its spec meaning. |
| Keep `audit` and accept the violation, documented | None now | Every strict consumer of `GET /documents/:id` breaks on any document this server ingested. |
| Propose the key upstream | Time, and no guarantee | Correct long-term; does not fix today. |

**Recommendation:** option 1 with a sibling JSONB column. It is the only one that
is both conformant and non-breaking, and the sibling column costs one idempotent
`alter table` of exactly the shape `migration_stack_ontology.sql` already
established. `db/**` is writable by no role in the current contract, so this needs
a human-run migration or a contract amendment — the same situation the ontology
column itself was in.

**Not fixed here:** `db/**` is outside this role's surface, and changing the
ingest response instead would break the nine-key oracle parity this package
treats as its primary contract. Recording the finding is the honest action
available.

---

## 2. EXTENSION: declared ontologies are not in the spec at all

Searching `README.md`, `CONFORMANCE.md`, `GLOSSARY.md` and `SCHEMA.json` for
`entity_types`, `relationship_types`, `declared ontology`, or any type allowlist
returns nothing that defines one:

- `SCHEMA.json`'s `AKSEntity.type` and `AKSRelationship.type` are plain
  `{"type": "string"}` with no `enum`.
- `CONFORMANCE.md` requires only that `type` be **present**
  (`Every entity MUST include id (UUID), name, type, and confidence`).
- The one `relationship_types` reference is `GET /aks/v1/traverse`'s optional
  filter, which narrows a **read**, not a write.

So `stacks.ontology`, its enforcement during extraction, and the backfeed
approval gate are all **extensions of this implementation**. That is legitimate —
a conformant implementation may do more than the standard requires — but it means:

- AKS cannot be cited as authority for the feature.
- A consumer reading only the spec has no way to know a Stack is constrained.
- The extension is invisible in an exported `AKSBundle`: `SCHEMA.json` has no
  declared-type field, so a stack's declaration is lost on export. A bundle
  re-imported elsewhere is unconstrained. **This is worth its own decision**,
  because it means the ontology does not travel with the knowledge it governs.

---

## 1b. DIVERGENCE: exported bundles declare the wrong spec version

**Severity:** MUST violation, inherited from the oracle.

`CONFORMANCE.md:13` — *"Every exported bundle MUST include `aks_version: "0.1.0"`
at the top level"* — and `SCHEMA.json` pins it as a constant:

```json
"aks_version": {"type": "string", "const": "0.1.0"}
```

This package emits `"0.2.0"` (`src/routes/aks/export.ts:166`).

This is not a porting slip: the oracle's own contract records the same value,
`oracle/contracts/openapi.json` → `{"default": "0.2.0"}`. So the reference
implementation this package ports was itself written against a `0.2.0` that the
published standard has not released — while `SCHEMA.json`'s `$id` still reads
`/schemas/v0.1.0/`.

Two consequences worth separating:

- Against `SCHEMA.json`, every bundle this server exports is **invalid**, because
  `const` fails. A consumer that validates before processing rejects the export
  outright.
- The port is behaving correctly *as a port*. Fixing it would break byte-parity
  with the oracle, which this package treats as its primary contract.

That is precisely the ranking tension `README.local.md` describes: (1) oracle
beats (2) spec, so the port wins — which means the fix is not a code change but a
decision about which contract this package serves. Options: emit `0.1.0` and
accept the parity break; keep `0.2.0` and document the export as non-conformant;
or treat it as an upstream bug and propose the spec version be reconciled with
what was actually shipped.

**Not fixed here:** changing it is a contract decision, not a defect repair, and
the same value appears in `AKSBundle`'s DTO default (`dto.ts:361`), so a change
touches both the emitted value and its schema default.

---

## 3. UNVERIFIED MUSTs that touch code in this package

Not claimed as broken — claimed as **unverified**, which is different and is the
honest status. Each needs its own test before anyone says "conformant".

| Requirement (from `CONFORMANCE.md`) | Status |
| --- | --- |
| `source.verified` default `false` for machine-extracted knowledge | `dto.ts:269` declares `.default(false)` and `aks-harness.ts:76` lists the key, but no test asserts that extraction leaves it unset while backfeed sets it |
| `AKSBundle` carries no declared-type field, so a Stack's ontology is lost on export | Confirmed absent: `dto.ts:360-374` has no ontology key, and `SCHEMA.json` has no such property |
| `source.verified` MUST be `true` on knowledge via approved backfeed | Not asserted; approval writes rows but nothing checks the marking |
| `source.source_kind = "backfeed"` on absorbed knowledge (`README.md:499`) | Not asserted |
| Relationships MUST reference entity IDs, not names (`export`) | `src/routes/aks/export.ts` reads ids; not verified against a bundle validator |
| Filtered bundles keep referential integrity | No test found |
| Document quality audit run **before** ingestion (`README.md:517`, SHOULD) | This package's audit is written **after** extraction and reports ontology rejections — a different question. Both legitimate; not the same field's purpose. |

---

## 4. What to do next, in order

1. **Decide the `aks_version` collision** (§1b) and the **`audit` collision**
   (§1). Both make exported or returned payloads fail validation against
   `SCHEMA.json`. `aks_version` is the louder one: it invalidates every bundle.
   `db/**` needs a human-run migration or a contract amendment, as before.
2. **Decide whether an ontology should survive export** (§2). Today it does not,
   which makes it a property of a deployment rather than of knowledge.
3. **Verify the `source.verified` MUSTs** (§3) — cheap, and they are the spec's
   mechanism for distinguishing machine-extracted from human-approved knowledge,
   which is exactly what the backfeed work just started enforcing.

Nothing in §3 should be described as conformant until it has a test.
