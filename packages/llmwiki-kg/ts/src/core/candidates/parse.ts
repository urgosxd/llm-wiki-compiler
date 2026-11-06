/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/parse.ts
 * @description Reading a model's open-extraction answer into candidates, tolerantly but without invention.
 *
 * ## What tolerance is allowed to do, and what it must never do
 *
 * A model omits optional parts, wraps its JSON in a sentence, or spells an
 * endpoint slightly differently than the entity it declared. All of that is
 * tolerated, because discarding a whole answer over a formatting slip loses
 * knowledge the source supports. What is never tolerated is invention: a missing
 * proposed type becomes `null` rather than a default label, a missing predicate
 * becomes a rejection rather than a generic verb, and an endpoint that no entity
 * candidate declared becomes a rejection rather than an entity conjured out of an
 * edge (S7, S31).
 *
 * ## The endpoint rule is what keeps an edge from creating a node
 *
 * In the legacy triplet contract every endpoint implicitly becomes an entity. That
 * is exactly the behaviour this parser refuses: a relation naming `Proceso X` when
 * nothing declared `Proceso X` is reported as `undeclared_endpoint` and produces
 * no node. The consequence is deliberate — a graph node always comes from a
 * candidate an extractor proposed as an entity, so a later stage can always ask
 * "was this node ever proposed, or merely implied by a verb?" and get an honest
 * answer.
 *
 * ## Normalization: trimming and the repository's one label fold
 *
 * Surrounding whitespace is trimmed on every string (padding carries no meaning),
 * and names, endpoint references and predicates are COMPARED through
 * `normalizeCatalogName` — the single folding rule this repository declares for
 * labels — so `Proceso  X` matches a declared `Proceso X`. The stored value is
 * always the model's own spelling: folding decides equality, never content.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import { parseJsonLoosely } from "../graph-parse.js";
import type {
  CandidateProperty,
  CandidateRejection,
  CandidateRejectionReason,
  CandidateSet,
  CandidateSource,
  EntityCandidate,
  RelationCandidate,
} from "./types.js";

/** The response field holding entity candidates. */
const ENTITIES_FIELD = "entities";

/** The response field holding relation candidates. */
const RELATIONS_FIELD = "relations";

/** Narrows an untrusted value to a plain JSON object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Reads one string field, trimmed; `undefined` when absent or blank. */
function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Reads an array field, treating anything else as absent. */
function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The run-scoped reference of one candidate. */
function candidateRef(kind: string, source: CandidateSource, index: number): string {
  return `${kind}:${source.documentId}:${source.chunkIndex}:${index}`;
}

/** Builds one rejection record. */
function rejection(
  candidateKind: CandidateRejection["candidateKind"],
  reason: CandidateRejectionReason,
  offending: readonly string[],
  source: CandidateSource,
): CandidateRejection {
  return { candidateKind, reason, offending, source };
}

/** Reads the property list of one entity, dropping entries that carry no pair. */
function readProperties(value: unknown): readonly CandidateProperty[] {
  const properties: CandidateProperty[] = [];
  for (const entry of readArray(value)) {
    const record = asRecord(entry);
    const name = readText(record?.["name"]);
    const propertyValue = readText(record?.["value"]);
    if (name !== undefined && propertyValue !== undefined) {
      properties.push({ name, value: propertyValue });
    }
  }
  return properties;
}

/** What one parsed response accumulates, so each reader only appends to it. */
interface ParseTally {
  readonly source: CandidateSource;
  readonly entities: EntityCandidate[];
  readonly relations: RelationCandidate[];
  readonly rejections: CandidateRejection[];
}

/**
 * Reads one entity candidate, or records why it was refused.
 *
 * A missing proposed type is NOT a refusal: an entity the source supports is worth
 * keeping even when the model could not name its type, and refusing it would lose
 * knowledge the request explicitly wants preserved.
 */
function absorbEntity(tally: ParseTally, raw: unknown, index: number): void {
  const record = asRecord(raw);
  const name = readText(record?.["name"]);
  if (name === undefined) {
    tally.rejections.push(rejection("entity", "missing_name", [], tally.source));
    return;
  }
  tally.entities.push({
    kind: "entity",
    ref: candidateRef("entity", tally.source, index),
    source: tally.source,
    name,
    proposedType: readText(record?.["type"]) ?? null,
    description: readText(record?.["description"]) ?? null,
    properties: readProperties(record?.["properties"]),
  });
}

/** The folded names of every entity candidate one response declared. */
function declaredEntityNames(entities: readonly EntityCandidate[]): ReadonlySet<string> {
  return new Set(entities.map((entity) => normalizeCatalogName(entity.name)));
}

/** The endpoints of a relation that no entity candidate declared. */
function undeclaredEndpoints(
  fromName: string,
  toName: string,
  declared: ReadonlySet<string>,
): readonly string[] {
  return [fromName, toName].filter((name) => !declared.has(normalizeCatalogName(name)));
}

/**
 * Reads one relation candidate, or records why it was refused.
 *
 * The endpoints are checked at the top of this function, before the predicate is
 * read, so a relation that would conjure a node can never be half-accepted: an
 * undeclared endpoint makes the relation a rejection and nothing else.
 */
function absorbRelation(
  tally: ParseTally,
  raw: unknown,
  index: number,
  declared: ReadonlySet<string>,
): void {
  const record = asRecord(raw);
  const fromName = readText(record?.["from"]);
  const toName = readText(record?.["to"]);
  if (fromName === undefined || toName === undefined) {
    const offending = [fromName ?? "", toName ?? ""].filter((name) => name !== "");
    tally.rejections.push(rejection("relationship", "missing_endpoint", offending, tally.source));
    return;
  }
  const predicate = readText(record?.["predicate"]);
  if (predicate === undefined) {
    tally.rejections.push(
      rejection("relationship", "missing_predicate", [fromName, toName], tally.source),
    );
    return;
  }
  const undeclared = undeclaredEndpoints(fromName, toName, declared);
  if (undeclared.length > 0) {
    tally.rejections.push(
      rejection("relationship", "undeclared_endpoint", undeclared, tally.source),
    );
    return;
  }
  tally.relations.push({
    kind: "relationship",
    ref: candidateRef("relationship", tally.source, index),
    source: tally.source,
    fromName,
    toName,
    predicate,
    description: readText(record?.["description"]) ?? null,
  });
}

/**
 * Parses one chunk's model answer into candidates.
 *
 * The payload is read through the same tolerant JSON parser the legacy triplet
 * path uses, so the two cannot disagree about what a provider actually sent.
 *
 * @param raw - The model's answer, untrusted: bare JSON, JSON in a string, or JSON
 *   wrapped in prose.
 * @param source - The document and chunk the answer belongs to.
 * @returns The parsed set. An answer that cannot be read at all yields an empty
 *   set rather than throwing, exactly like the legacy parse path, because one odd
 *   response must not fail a document.
 */
export function parseCandidates(raw: string, source: CandidateSource): CandidateSet {
  const payload = asRecord(parseJsonLoosely(raw));
  const tally: ParseTally = { source, entities: [], relations: [], rejections: [] };
  readArray(payload?.[ENTITIES_FIELD]).forEach((item, index) => absorbEntity(tally, item, index));
  const declared = declaredEntityNames(tally.entities);
  readArray(payload?.[RELATIONS_FIELD]).forEach((item, index) =>
    absorbRelation(tally, item, index, declared),
  );
  return {
    source,
    entities: tally.entities,
    relations: tally.relations,
    rejections: tally.rejections,
  };
}
