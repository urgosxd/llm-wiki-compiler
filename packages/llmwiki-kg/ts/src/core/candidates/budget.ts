/**
 * @file packages/llmwiki-kg/ts/src/core/candidates/budget.ts
 * @description The bounded candidate budget: caps, run-scoped dedup, and accounting that hides nothing.
 *
 * ## Why a budget exists at all (S9)
 *
 * Open extraction makes an unbounded answer cheap to produce and expensive to
 * process: every candidate costs an evidence check and a classification call
 * later. A budget bounds that work, and the one thing a budget must never do is
 * disappear quietly — an operator who sees eight entities and no record cannot
 * tell a thin document from a truncated one. So every cap that drops something
 * emits a `CandidateTruncation` naming the limit and how many candidates it
 * dropped, and the ledger's summary also reports duplicates and rejections.
 *
 * ## The deduplication key, and why the predicate is in it
 *
 * An entity key is `(<document>, folded name)`; a relation key is
 * `(<document>, folded from, folded predicate, folded to)`, NUL-separated because
 * a normalized label can never contain NUL. Two consequences are deliberate:
 *
 * - The PREDICATE is part of the relation key. A key of `(from, to)` alone, or
 *   `(from, "Unclassified", to)`, would collapse "deja sin efecto" and "modifies"
 *   into one edge and erase one of them (S33).
 * - The DOCUMENT is part of both keys. Collapsing by name across documents would
 *   merge two same-named subjects from two sources before identity resolution ever
 *   saw them, which is the merge S29 forbids; per document, the same pass repeated
 *   over the same chunk is exactly what "a second extraction pass cannot duplicate
 *   candidates" means.
 *
 * The PROPOSED type is deliberately NOT in either key: it is an unconfirmed
 * proposal, so two passes that disagree about the label still describe one
 * candidate, and the classifier makes that decision once.
 *
 * ## One ledger, one document
 *
 * `perDocumentLimit` is a per-document budget, so a ledger accumulates exactly one
 * document. Feeding it a second document throws instead of silently resetting a
 * counter that the summary reports as if it covered both.
 */

import { normalizeCatalogName } from "../catalog/names.js";
import type {
  CandidateRejection,
  CandidateSet,
  CandidateSource,
  EntityCandidate,
  KnowledgeCandidate,
  RelationCandidate,
} from "./types.js";

/** Separator between key parts; NUL cannot occur in a normalized label. */
const KEY_SEPARATOR = "\u0000";

/** The caps one ledger enforces. */
export interface CandidateBudgetConfig {
  /** Maximum candidates admitted from one chunk, entities and relations together. */
  readonly perChunkLimit: number;
  /** Maximum candidates admitted from the whole document, across chunks. */
  readonly perDocumentLimit: number;
}

/**
 * The default budget, and why these two numbers.
 *
 * `perChunkLimit` is 50 because the legacy prompt asks a model for at most 20
 * triplets per chunk (`MAX_TRIPLETS_PER_CHUNK` in `graph-prompt.ts`), and an open
 * answer to the same request needs up to two entity candidates and one relation
 * candidate per triplet — about 40 slots — plus headroom for entities that take
 * part in no relation. Smaller would truncate answers the previous contract
 * accepted; much larger would stop bounding the per-chunk work.
 *
 * `perDocumentLimit` is 500: ten chunks at the per-chunk cap. A document beyond
 * that is unusual, and when it happens the truncation record says so rather than
 * the extra candidates vanishing.
 */
export const DEFAULT_CANDIDATE_BUDGET: CandidateBudgetConfig = Object.freeze({
  perChunkLimit: 50,
  perDocumentLimit: 500,
});

/** Raised when a budget is unusable, or a ledger is driven outside its contract. */
export class CandidateBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateBudgetError";
  }
}

/** A record that a cap actually dropped candidates. */
export interface CandidateTruncation {
  /** Which cap fired: the chunk's own, or the run-wide document budget. */
  readonly scope: "chunk" | "document";
  readonly documentId: string;
  /** The chunk the drop happened in; `null` for a document-scope record. */
  readonly chunkIndex: number | null;
  /** The limit that was reached. */
  readonly limit: number;
  /** How many candidates the limit dropped. */
  readonly dropped: number;
}

/** What one chunk contributed, and what it cost. */
export interface ChunkCandidateAccounting {
  readonly documentId: string;
  readonly chunkIndex: number;
  /** Candidates the parser produced for this chunk, before dedup and caps. */
  readonly consideredEntities: number;
  readonly consideredRelations: number;
  /** Candidates the ledger admitted from this chunk. */
  readonly keptEntities: number;
  readonly keptRelations: number;
  /** Candidates dropped because the run had already seen their key. */
  readonly duplicates: number;
  /** Candidates dropped by either cap. */
  readonly droppedByTruncation: number;
  /** Never empty when something was dropped: the record names every cap that fired. */
  readonly truncations: readonly CandidateTruncation[];
  /** What the parser refused for this chunk, carried through unchanged. */
  readonly rejections: readonly CandidateRejection[];
}

/** What a whole run kept, dropped and refused. */
export interface CandidateAccounting {
  readonly budgets: CandidateBudgetConfig;
  /** One entry per admitted chunk, in admission order. */
  readonly chunks: readonly ChunkCandidateAccounting[];
  /** Every truncation from every chunk, flattened for logging. */
  readonly truncations: readonly CandidateTruncation[];
  readonly keptEntities: number;
  readonly keptRelations: number;
  readonly duplicates: number;
  readonly truncationsDropped: number;
  readonly rejections: number;
  /** True when any cap dropped anything, so a caller can flag a partial run. */
  readonly truncated: boolean;
}

/** What one chunk's admission produced. */
export interface AdmittedCandidates {
  readonly entities: readonly EntityCandidate[];
  readonly relations: readonly RelationCandidate[];
  /** This chunk's accounting, already folded into the ledger's summary. */
  readonly accounting: ChunkCandidateAccounting;
}

/** The budget a pipeline drives: admit chunk by chunk, then read the summary. */
export interface CandidateBudgetLedger {
  /** Admits one chunk's candidates and returns the survivors with their accounting. */
  admit(set: CandidateSet): AdmittedCandidates;
  /** Everything admitted so far, ready to log or persist. */
  summary(): CandidateAccounting;
}

/** The mutable state one ledger accumulates. */
interface LedgerState {
  documentId: string | null;
  readonly seen: Set<string>;
  readonly chunks: ChunkCandidateAccounting[];
  keptEntities: number;
  keptRelations: number;
  duplicates: number;
  truncationsDropped: number;
  rejections: number;
}

/**
 * The deduplication key of one candidate.
 *
 * See the file header for why the predicate and the document are in it, and why
 * the proposed type is not.
 *
 * @param candidate - Any candidate, before or after admission.
 * @returns The key equality is decided on, within one run.
 */
export function candidateDedupKey(candidate: KnowledgeCandidate): string {
  if (candidate.kind === "entity") {
    return ["entity", candidate.source.documentId, normalizeCatalogName(candidate.name)].join(
      KEY_SEPARATOR,
    );
  }
  return [
    "relationship",
    candidate.source.documentId,
    normalizeCatalogName(candidate.fromName),
    normalizeCatalogName(candidate.predicate),
    normalizeCatalogName(candidate.toName),
  ].join(KEY_SEPARATOR);
}

/** Refuses a budget no run could honour. */
function validateBudget(config: CandidateBudgetConfig): void {
  for (const [name, limit] of Object.entries(config)) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new CandidateBudgetError(`candidate budget "${name}" must be a positive integer`);
    }
  }
}

/** Binds the ledger to its document, refusing a second one. */
function claimDocument(state: LedgerState, documentId: string): void {
  if (state.documentId === null) {
    state.documentId = documentId;
    return;
  }
  if (state.documentId !== documentId) {
    throw new CandidateBudgetError(
      `candidate ledger accumulates one document: it holds "${state.documentId}" and was given "${documentId}"`,
    );
  }
}

/** Drops candidates whose key this run already admitted. */
function dedupeCandidates(
  state: LedgerState,
  candidates: readonly KnowledgeCandidate[],
): { readonly kept: readonly KnowledgeCandidate[]; readonly duplicates: number } {
  const kept: KnowledgeCandidate[] = [];
  let duplicates = 0;
  for (const candidate of candidates) {
    const key = candidateDedupKey(candidate);
    if (state.seen.has(key)) {
      duplicates += 1;
      continue;
    }
    state.seen.add(key);
    kept.push(candidate);
  }
  return { kept, duplicates };
}

/** Builds one truncation record. */
function truncationRecord(
  scope: CandidateTruncation["scope"],
  source: CandidateSource,
  limit: number,
  dropped: number,
): CandidateTruncation {
  return {
    scope,
    documentId: source.documentId,
    chunkIndex: scope === "chunk" ? source.chunkIndex : null,
    limit,
    dropped,
  };
}

/** Splits a mixed candidate list back into the two kinds, preserving order. */
function splitKinds(candidates: readonly KnowledgeCandidate[]): {
  entities: EntityCandidate[];
  relations: RelationCandidate[];
} {
  const entities: EntityCandidate[] = [];
  const relations: RelationCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "entity") {
      entities.push(candidate);
    } else {
      relations.push(candidate);
    }
  }
  return { entities, relations };
}

/**
 * Applies the per-chunk cap, then the per-document cap, recording each one that fired.
 *
 * Entities are ordered before relations on entry, so a truncation never keeps an
 * edge whose endpoints the same cap dropped, and a chunk that yields only entities
 * (S8) is protected by the same ordering.
 */
function applyLimits(
  state: LedgerState,
  config: CandidateBudgetConfig,
  set: CandidateSet,
  candidates: readonly KnowledgeCandidate[],
): { entities: EntityCandidate[]; relations: RelationCandidate[]; truncations: CandidateTruncation[] } {
  const truncations: CandidateTruncation[] = [];
  const chunkKept = candidates.slice(0, config.perChunkLimit);
  const chunkDropped = candidates.length - chunkKept.length;
  if (chunkDropped > 0) {
    truncations.push(truncationRecord("chunk", set.source, config.perChunkLimit, chunkDropped));
  }
  const remaining = Math.max(0, config.perDocumentLimit - state.keptEntities - state.keptRelations);
  const documentKept = chunkKept.slice(0, remaining);
  const documentDropped = chunkKept.length - documentKept.length;
  if (documentDropped > 0) {
    truncations.push(
      truncationRecord("document", set.source, config.perDocumentLimit, documentDropped),
    );
  }
  state.truncationsDropped += chunkDropped + documentDropped;
  return { ...splitKinds(documentKept), truncations };
}

/** Admits one chunk: dedup, caps, counters, and the chunk's accounting. */
function admitChunk(
  state: LedgerState,
  config: CandidateBudgetConfig,
  set: CandidateSet,
): AdmittedCandidates {
  claimDocument(state, set.source.documentId);
  const { kept, duplicates } = dedupeCandidates(state, [...set.entities, ...set.relations]);
  const limited = applyLimits(state, config, set, kept);
  state.duplicates += duplicates;
  state.rejections += set.rejections.length;
  state.keptEntities += limited.entities.length;
  state.keptRelations += limited.relations.length;
  const accounting: ChunkCandidateAccounting = {
    documentId: set.source.documentId,
    chunkIndex: set.source.chunkIndex,
    consideredEntities: set.entities.length,
    consideredRelations: set.relations.length,
    keptEntities: limited.entities.length,
    keptRelations: limited.relations.length,
    duplicates,
    droppedByTruncation: limited.truncations.reduce((total, entry) => total + entry.dropped, 0),
    truncations: limited.truncations,
    rejections: set.rejections,
  };
  state.chunks.push(accounting);
  return { entities: limited.entities, relations: limited.relations, accounting };
}

/** Builds the run summary from the accumulated state. */
function summarize(state: LedgerState, config: CandidateBudgetConfig): CandidateAccounting {
  return {
    budgets: config,
    chunks: [...state.chunks],
    truncations: state.chunks.flatMap((chunk) => chunk.truncations),
    keptEntities: state.keptEntities,
    keptRelations: state.keptRelations,
    duplicates: state.duplicates,
    truncationsDropped: state.truncationsDropped,
    rejections: state.rejections,
    truncated: state.truncationsDropped > 0,
  };
}

/**
 * Creates the budget ledger for one document's extraction run.
 *
 * @param config - The caps to enforce; defaults to {@link DEFAULT_CANDIDATE_BUDGET}.
 * @returns A ledger that admits chunk by chunk and reports what it did.
 * @throws {CandidateBudgetError} when a cap is not a positive integer.
 */
export function createCandidateLedger(
  config: CandidateBudgetConfig = DEFAULT_CANDIDATE_BUDGET,
): CandidateBudgetLedger {
  validateBudget(config);
  const state: LedgerState = {
    documentId: null,
    seen: new Set(),
    chunks: [],
    keptEntities: 0,
    keptRelations: 0,
    duplicates: 0,
    truncationsDropped: 0,
    rejections: 0,
  };
  return {
    admit: (set: CandidateSet): AdmittedCandidates => admitChunk(state, config, set),
    summary: (): CandidateAccounting => summarize(state, config),
  };
}

/** The counters a merged summary adds up. */
type AccountingCounter =
  | "keptEntities"
  | "keptRelations"
  | "duplicates"
  | "truncationsDropped"
  | "rejections";

/** Sums one counter across the parts of a run. */
function totalOf(parts: readonly CandidateAccounting[], counter: AccountingCounter): number {
  return parts.reduce((total, part) => total + part[counter], 0);
}

/**
 * Merges several summaries into the single record a run logs and persists.
 *
 * The parts must share one budget: two different caps describe two different
 * answers to "was this truncated?", and a merged record that quietly used one of
 * them would report a limit the run never applied.
 *
 * @param parts - Summaries from the documents of one run.
 * @returns One summary covering all of them.
 * @throws {CandidateBudgetError} when the list is empty or the budgets differ.
 */
export function mergeCandidateAccounting(
  parts: readonly CandidateAccounting[],
): CandidateAccounting {
  const first = parts[0];
  if (first === undefined) {
    throw new CandidateBudgetError("cannot merge an empty candidate accounting list");
  }
  for (const part of parts) {
    if (
      part.budgets.perChunkLimit !== first.budgets.perChunkLimit ||
      part.budgets.perDocumentLimit !== first.budgets.perDocumentLimit
    ) {
      throw new CandidateBudgetError(
        "cannot merge candidate accounting produced under different budgets",
      );
    }
  }
  return {
    budgets: first.budgets,
    chunks: parts.flatMap((part) => part.chunks),
    truncations: parts.flatMap((part) => part.truncations),
    keptEntities: totalOf(parts, "keptEntities"),
    keptRelations: totalOf(parts, "keptRelations"),
    duplicates: totalOf(parts, "duplicates"),
    truncationsDropped: totalOf(parts, "truncationsDropped"),
    rejections: totalOf(parts, "rejections"),
    truncated: parts.some((part) => part.truncated),
  };
}
