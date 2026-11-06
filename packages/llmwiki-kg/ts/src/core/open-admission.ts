/**
 * @file packages/llmwiki-kg/ts/src/core/open-admission.ts
 * @description Admission under the OPEN contract: the declaration orients, structure still decides.
 *
 * ## Why this is not `parseTripletsWithOntology`
 *
 * Both functions read the same tool payload and both answer "what may enter the
 * graph", but they answer different questions and must keep answering them
 * differently:
 *
 * - the strict path asks "is this inside the caller's declaration" and drops what
 *   is not, which is the contract `ontology.ts` promises and which callers who want
 *   a closed graph rely on;
 * - this path asks "is this structurally a fact at all", and keeps everything that
 *   is — with the extractor's own proposed type and predicate, even when the
 *   declaration names neither (S1, S3, S7).
 *
 * The distinction that matters is that "unknown to the catalog" is NOT "invalid".
 * A triplet naming `UNICORN` or a predicate the Stack never declared is knowledge
 * the source supports; the classifier decides later what it is. A triplet missing
 * an endpoint or a predicate is not a fact, and is refused with a reason.
 *
 * ## Two observable facts, never one
 *
 * Every answer produces BOTH on request: `rejected` names what was refused and why
 * (`MISSING_ENDPOINT`, `MISSING_PREDICATE`), and `outsideCatalog` names every
 * proposal the declaration does not have but which was KEPT. A caller that sees
 * only one of them cannot tell a thin document from a permissive one, which is
 * exactly the silent limit S9 forbids.
 *
 * ## Agreement with the oracle-parity parser is enforced, not hoped for
 *
 * `parseTriplets` stays the single reader of what a well-formed answer is — it is
 * pinned by parity tests and this module does not re-litigate it. The scan below
 * exists only to EXPLAIN the entries that parser dropped, so an unexplained
 * difference is a bug here, not a tolerance: {@link admitOpenTriplets} throws if
 * every raw entry is not accounted for as accepted, self-referential, or refused.
 */

import {
  capTripletsPerChunk,
  type TripletBudgetOptions,
  type TripletTruncation,
} from "./graph-prompt.js";
import {
  parseJsonLoosely,
  parseStandaloneEntities,
  parseTriplets,
  type StandaloneEntity,
  type Triplet,
} from "./graph-parse.js";
import { isEntityTypeAllowed, normalizeType, type Ontology } from "./ontology.js";

/** Why a triplet was refused even though nothing was invented about it. */
export type StructuralRejectionReason = "MISSING_ENDPOINT" | "MISSING_PREDICATE";

/** One triplet the open path refused, with the part that was wrong. */
export interface OpenRejection {
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly reason: StructuralRejectionReason;
  /** Which part was wrong: `subject`, `object` or `relation`. */
  readonly offendingType: "subject" | "object" | "relation";
}

/**
 * A proposal the declaration does not name, kept rather than dropped (S7).
 *
 * `kind` separates the two axes so a report can say "this node's type is outside
 * the catalog" without implying anything about its predicates, and `proposed` is
 * the extractor's own wording, normalized as the label rule normalizes model
 * output — never a catalog entry, never `related_to`.
 */
export interface CatalogMismatch {
  readonly kind: "entity_type" | "predicate";
  /** The node name, or `subject -> object` for a predicate. */
  readonly of: string;
  /** The proposal itself, as the extractor wrote it. */
  readonly proposed: string;
}

/** Everything one chunk's answer contributes under the open contract. */
export interface OpenAdmissionResult {
  /** Admitted triplets, carrying their proposed types and predicate intact. */
  readonly triplets: readonly Triplet[];
  /** Entities that take part in no relation, unknown types included (S8). */
  readonly entities: readonly StandaloneEntity[];
  /** Endpoints of refused triplets: the edge is lost, the nodes are not. */
  readonly rescued: readonly StandaloneEntity[];
  /** What was refused, and why. */
  readonly rejected: readonly OpenRejection[];
  /** What was kept although the declaration does not name it. */
  readonly outsideCatalog: readonly CatalogMismatch[];
  /** Set only when the per-chunk budget dropped something (S9). */
  readonly truncation: TripletTruncation | undefined;
}

/** How one open admission is budgeted. */
export interface OpenAdmissionOptions extends TripletBudgetOptions {
  /** The chunk being admitted, recorded on a truncation record. */
  readonly chunkIndex?: number;
}

/** Raised when this module and the parser disagree about an answer. */
export class OpenAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAdmissionError";
  }
}

/** Narrows an untrusted value to a plain JSON object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** One endpoint, or `undefined` unless both parts are present and non-blank. */
function endpointOf(value: unknown): StandaloneEntity | undefined {
  const record = asRecord(value);
  const name = record?.["name"];
  const type = record?.["type"];
  if (typeof name !== "string" || typeof type !== "string") return undefined;
  if (name.trim() === "" || type.trim() === "") return undefined;
  return { name: name.trim(), type: normalizeType(type) };
}

/** The predicate of one relation, or `undefined` when absent or blank. */
function predicateOf(value: unknown): string | undefined {
  const raw = asRecord(value)?.["type"];
  return typeof raw === "string" && raw.trim() !== "" ? normalizeType(raw) : undefined;
}

/** The endpoints a refused record did state, so its nodes can survive. */
function statedEndpoints(
  endpoints: readonly (StandaloneEntity | undefined)[],
): StandaloneEntity[] {
  return endpoints.filter((endpoint): endpoint is StandaloneEntity => endpoint !== undefined);
}

/** Why one structurally readable record is still not a fact, if it is not. */
function faultOf(
  subject: StandaloneEntity | undefined,
  object: StandaloneEntity | undefined,
  predicate: string | undefined,
): OpenRejection | undefined {
  const base = {
    subject: subject?.name ?? "",
    relation: predicate ?? "",
    object: object?.name ?? "",
  };
  if (subject === undefined || object === undefined) {
    const offendingType = subject === undefined ? "subject" : "object";
    return { ...base, reason: "MISSING_ENDPOINT", offendingType };
  }
  if (predicate === undefined) {
    return { ...base, reason: "MISSING_PREDICATE", offendingType: "relation" };
  }
  return undefined;
}

/** What explaining the parser's dropped entries produced. */
interface RawScan {
  readonly rawCount: number;
  readonly selfReferences: number;
  readonly rejections: readonly OpenRejection[];
  readonly rescued: readonly StandaloneEntity[];
}

/**
 * Explains every entry of `triplets` that the oracle-parity parser dropped.
 *
 * A self-reference is counted but not refused: pruning it is the oracle's own
 * `_prune_invalid_triplets` behaviour and is not a fault of the model's answer.
 */
function scanRawTriplets(argumentsJson: string): RawScan {
  const entries = asRecord(parseJsonLoosely(argumentsJson))?.["triplets"];
  const raw = Array.isArray(entries) ? entries : [];
  const rejections: OpenRejection[] = [];
  const rescued: StandaloneEntity[] = [];
  let selfReferences = 0;
  for (const entry of raw) {
    const record = asRecord(entry);
    const subject = endpointOf(record?.["subject"]);
    const object = endpointOf(record?.["object"]);
    const predicate = predicateOf(record?.["relation"]);
    const fault = faultOf(subject, object, predicate);
    if (fault !== undefined) {
      rejections.push(fault);
      rescued.push(...statedEndpoints([subject, object]));
      continue;
    }
    if (subject !== undefined && object !== undefined && subject.name.toLowerCase() === object.name.toLowerCase()) {
      selfReferences += 1;
    }
  }
  return { rawCount: raw.length, selfReferences, rejections, rescued };
}

/** The mismatches one admitted triplet carries, never more than three. */
function tripletMismatches(triplet: Triplet, ontology: Ontology): readonly CatalogMismatch[] {
  const found: CatalogMismatch[] = [];
  for (const [name, type] of [
    [triplet.subjectName, triplet.subjectType],
    [triplet.objectName, triplet.objectType],
  ] as const) {
    if (!isEntityTypeAllowed(ontology, type, ontology.entityTypes)) {
      found.push({ kind: "entity_type", of: name, proposed: type });
    }
  }
  if (!ontology.relationshipTypes.includes(triplet.relationType)) {
    found.push({
      kind: "predicate",
      of: `${triplet.subjectName} -> ${triplet.objectName}`,
      proposed: triplet.relationType,
    });
  }
  return found;
}

/** The mismatch one standalone entity carries, if any. */
function entityMismatches(entity: StandaloneEntity, ontology: Ontology): readonly CatalogMismatch[] {
  if (isEntityTypeAllowed(ontology, entity.type, ontology.entityTypes)) return [];
  return [{ kind: "entity_type", of: entity.name, proposed: entity.type }];
}

/**
 * Admits one chunk's answer under the open contract.
 *
 * Pair compatibility is deliberately NOT an admission rule here. A fact whose
 * endpoint types conflict with a declared relationship constraint is still a fact
 * the source supports, so it is kept and its conflict belongs to the compatibility
 * verdict recorded later (S34, S35) — dropping it here would force a
 * classification the catalog is not entitled to make.
 *
 * @param argumentsJson - The model's tool-call argument string, untrusted.
 * @param ontology - The Stack's declaration, used as orientation and for mismatch reporting.
 * @param options - The per-chunk triplet budget and the chunk index to record.
 * @returns Admitted triplets and entities, plus what was refused and what was outside.
 * @throws {OpenAdmissionError} When an entry of the answer is neither accepted,
 *   self-referential, nor explained by a rejection — a bug here, never a tolerance.
 */
export function admitOpenTriplets(
  argumentsJson: string,
  ontology: Ontology,
  options: OpenAdmissionOptions = {},
): OpenAdmissionResult {
  const accepted = parseTriplets(argumentsJson);
  const scan = scanRawTriplets(argumentsJson);
  const accounted = accepted.length + scan.selfReferences + scan.rejections.length;
  if (accounted !== scan.rawCount) {
    throw new OpenAdmissionError(
      `open admission accounted for ${String(accounted)} of ${String(scan.rawCount)} triplets`,
    );
  }
  const capped = capTripletsPerChunk(accepted, options);
  const entities = parseStandaloneEntities(argumentsJson);
  return {
    triplets: capped.triplets,
    entities,
    rescued: scan.rescued,
    rejected: scan.rejections,
    outsideCatalog: [
      ...capped.triplets.flatMap((triplet) => tripletMismatches(triplet, ontology)),
      ...entities.flatMap((entity) => entityMismatches(entity, ontology)),
    ],
    truncation: capped.truncation,
  };
}
