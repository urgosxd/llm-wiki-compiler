/**
 * @file packages/llmwiki-kg/ts/src/core/default_ontology.ts
 * @description The ontology a Stack is enforced against when it declares none.
 *
 * ## Why a default exists at all
 *
 * `stacks.ontology` is nullable, and `null` used to mean "the oracle's
 * behaviour": `graph-prompt.ts` advertises ten entity types and ten relation
 * types in the tool-schema *description*, and nothing validates against them
 * because the extractor runs with `strict=False`. So an unconfigured Stack had
 * type hints and no contract, and the `type` column — `text not null` with no
 * CHECK — accepted whatever the model emitted.
 *
 * That is a defensible default for a document compiler that must never lose an
 * unusual sentence. It is not defensible as the *only* behaviour, because the
 * difference between `COMPANY` and `COMPANY ` (one trailing space, normalised
 * away) and `COMPANY` versus `FIRM` (not normalised at all) is the difference
 * between a graph you can query and a graph you cannot. Two Stacks ingesting the
 * same document should not disagree about what a company is called.
 *
 * ## This is OUR policy, not the specification's
 *
 * The vendored AKS spec is explicit that no global vocabulary exists:
 * `SCHEMA.json:499` documents `AKSEntity.type` as *"Domain-defined category. No
 * global enum."* and `SCHEMA.json:582` does the same for
 * `AKSRelationship.type`. Nothing here contradicts that: the spec governs the
 * **format** of an export, and a Stack still stores and emits whatever types it
 * was given. This module supplies a **starting declaration** for the caller who
 * did not write one, in the same spirit as a default HTTP `Content-Type` — a
 * convenience layered on a format that permits any value.
 *
 * ## Why the vocabulary is not llama_index's
 *
 * The obvious cheap default is `DEFAULT_ENTITIES` / `DEFAULT_RELATIONS` from
 * `graph-prompt.ts`, which would leave the tool schema byte-identical and
 * therefore risk nothing. It was measured and rejected: that list is
 * llama_index's, and it contains no `COMPANY` and no `EMPLOYS`. Enforcing it
 * would reject `Acme EMPLOYS Ada`, the single most natural sentence in this
 * domain, while admitting `MISCELLANEOUS`. A default that refuses real input is
 * worse than no default, because it fails silently into a thin graph.
 *
 * ## Where the declaration is applied, and where it is not
 *
 * The default is resolved at the three points that already answer "the column is
 * null": the ingest pipeline, the backfeed approval gate, and the KG dimension's
 * `prepare`. All three call {@link defaultOntology}, so they cannot drift into
 * disagreeing about what an unconfigured Stack permits.
 *
 * It is deliberately NOT baked into `buildToolSchema()` or into
 * `extractGraphFromChunks`. Those default to the oracle's bytes on purpose:
 * callers that reach them directly — the parity tests, the Python-parity
 * harness, any future consumer — must keep observing the measured behaviour.
 * A Stack's policy belongs at the boundary that knows a Stack exists.
 */

import { validateOntology, type Ontology } from "./ontology.js";

/**
 * Entity types an unconfigured Stack admits.
 *
 * Chosen to describe business and product knowledge — the documents this
 * compiler is fed are specs, tickets, and architecture notes — while staying
 * close enough to llama_index's list that a Stack migrating from the permissive
 * default loses little: `ORGANIZATION` was in that list, and `COMPANY` is a
 * narrower spelling of it. `MISCELLANEOUS` is deliberately absent: a type that
 * means "anything" reintroduces the free-text column this default exists to
 * remove.
 */
export const DEFAULT_ENTITY_TYPES = [
  "COMPANY",
  "PERSON",
  "ORGANIZATION",
  "PRODUCT",
  "TECHNOLOGY",
  "CONCEPT",
  "EVENT",
  "LOCATION",
  "TIME",
  "REQUIREMENT",
  "DECISION",
  "PROCESS",
  "TEAM",
] as const;

/**
 * Relationship types an unconfigured Stack admits.
 *
 * Every entry is a verb phrase, per `SCHEMA.json:582` (*"Typed verb phrase.
 * Domain-defined."*), and every one of them is a relation the extraction prompt
 * can express today: the model builds `subject EMPLOYS object` from a sentence,
 * and nothing about this list changes the triplet shape.
 *
 * `PART_OF`, `USED_FOR`, `USED_BY`, `WORKED_ON`, and `HAS` are carried over from
 * llama_index so that a document that compiled cleanly before still compiles
 * cleanly now. The additions cover the relations this domain actually states and
 * the old list could not name.
 */
export const DEFAULT_RELATIONSHIP_TYPES = [
  "EMPLOYS",
  "WORKS_AT",
  "PART_OF",
  "HAS",
  "USES",
  "USED_FOR",
  "USED_BY",
  "WORKED_ON",
  "DEPENDS_ON",
  "PRODUCES",
  "REQUIRES",
  "TRIGGERS",
  "SUPPLIES",
  "ACQUIRES",
  "LOCATED_IN",
  "IS_A",
  "HAS_ALIAS",
] as const;

/**
 * The ontology an unconfigured Stack is enforced against.
 *
 * Validated through the same {@link validateOntology} as a caller's declaration,
 * so the default cannot be a shape the rest of the code would reject. It is flat
 * — no `subtypes` — because the hierarchy was measured to change nothing for
 * endpoint admission (see `odd/tasks/kg-stack-ontology-enforcement.md`), and a
 * default should not assert structure nobody asked for.
 *
 * Exposed as a function rather than a frozen constant because `Ontology` carries
 * a derived `parentsOf` map. Sharing one instance across concurrent ingests would
 * be safe today, but a function makes it impossible to mutate a graph-wide
 * singleton by holding a reference.
 *
 * @returns A fresh, validated ontology with no subtype edges.
 */
export function defaultOntology(): Ontology {
  return validateOntology({
    entityTypes: [...DEFAULT_ENTITY_TYPES],
    relationshipTypes: [...DEFAULT_RELATIONSHIP_TYPES],
  });
}
