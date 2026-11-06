/**
 * @file packages/llmwiki-kg/ts/src/core/eval/load.ts
 * @description Parsing and validating the labeled set from disk.
 *
 * ## Why validation is this loud
 *
 * The set is the measuring instrument. An entry that quietly loses a label does not
 * fail anything: the scorer keeps computing from the entries that kept theirs, and
 * the report looks healthier than the data it came from. So every required field is
 * checked here, once, with a message that names the example id and the field, and a
 * missing label is a fatal error rather than a skipped row.
 *
 * ## Why the file is read instead of imported
 *
 * `JSON` imports need `resolveJsonModule`, and the package's `tsconfig` is not the
 * eval's to change. Reading the committed file at runtime also keeps the set
 * editable as data — the point of a labeled set is that a human can add a case
 * without touching code — and keeps the file out of the build output.
 *
 * ## What "extracted" is required to carry
 *
 * `extracted: true` means a candidate exists, so `candidate` and `recorded` are
 * required: an evaluated fact with no recorded answer would be an unevaluated fact
 * in disguise. `extracted: false` means the extractor never produced the fact, so
 * `fact` is required to say which fact was missed and `candidate`/`recorded` must be
 * absent, so a miss cannot also carry a candidate nobody scored.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asRecord, asString } from "../llm/json.js";
import type {
  EvalSet,
  EntityCandidateSpec,
  ExampleBase,
  ExampleLabels,
  LabeledEntityFact,
  LabeledExample,
  LabeledLanguage,
  LabeledRelationFact,
  RecordedAnswers,
  RecordedClassification,
  RecordedSupport,
  RelationCandidateSpec,
  SupportLabel,
} from "./types.js";

/** Raised for every way the labeled set can be wrong. */
export class EvalSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalSetError";
  }
}

/** The committed set, resolved relative to this file so any cwd works. */
export const DEFAULT_EVAL_SET_PATH = new URL("../../../eval/eval-set.json", import.meta.url);

/** The two languages the set may use. */
const LANGUAGES: readonly LabeledLanguage[] = ["es", "en"];

/** The two support labels a human may assign. */
const SUPPORT_LABELS: readonly SupportLabel[] = ["supported", "unsupported"];

/**
 * Reads a required non-empty string.
 *
 * @param record - The object to read.
 * @param key - The field name.
 * @param where - Where the object came from, for the error message.
 * @returns The string.
 * @throws {EvalSetError} When absent, blank, or not a string.
 */
function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = asString(record[key]);
  if (value === undefined || value.trim() === "") {
    throw new EvalSetError(`${where}: ${key} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Reads a required finite number within `[0, 1]`.
 *
 * @param record - The object to read.
 * @param key - The field name.
 * @param where - Where the object came from.
 * @returns The probability.
 * @throws {EvalSetError} When absent or outside the interval.
 */
function requiredProbability(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvalSetError(`${where}: ${key} is required and must be a number within [0, 1]`);
  }
  return value;
}

/**
 * Reads a probability distribution, verbatim.
 *
 * @param record - The object to read.
 * @param key - The field name.
 * @param where - Where the object came from.
 * @returns Label to probability.
 * @throws {EvalSetError} When absent or not a distribution of probabilities.
 */
function requiredDistribution(record: Record<string, unknown>, key: string, where: string): Record<string, number> {
  const raw = asRecord(record[key]);
  if (raw === undefined) throw new EvalSetError(`${where}: ${key} is required and must be an object`);
  const probabilities: Record<string, number> = {};
  for (const [label, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new EvalSetError(`${where}: ${key}.${label} must be a number within [0, 1]`);
    }
    probabilities[label] = value;
  }
  return probabilities;
}

/**
 * Parses the two human labels, refusing a missing or unknown one.
 *
 * @param value - The raw `labels` field.
 * @param where - Where the example came from.
 * @returns The validated labels.
 * @throws {EvalSetError} When a label is missing or outside its closed set.
 */
function parseLabels(value: unknown, where: string): ExampleLabels {
  const record = asRecord(value);
  if (record === undefined) throw new EvalSetError(`${where}: labels is required`);
  const canonical = requiredString(record, "canonical", `${where} labels`);
  const support = requiredString(record, "support", `${where} labels`);
  if (!SUPPORT_LABELS.includes(support as SupportLabel)) {
    throw new EvalSetError(`${where}: labels.support must be one of ${SUPPORT_LABELS.join(", ")}`);
  }
  return { canonical, support: support as SupportLabel };
}

/**
 * Parses a recorded `choice` answer.
 *
 * @param record - The raw `classification` field.
 * @param where - Where the example came from.
 * @returns The recorded answer.
 * @throws {EvalSetError} When a documented field is missing.
 */
function parseRecordedClassification(record: Record<string, unknown>, where: string): RecordedClassification {
  return {
    choice: requiredString(record, "choice", `${where} recorded.classification`),
    probabilities: requiredDistribution(record, "probabilities", `${where} recorded.classification`),
    confidence: requiredProbability(record, "confidence", `${where} recorded.classification`),
    fits: requiredProbability(record, "fits", `${where} recorded.classification`),
  };
}

/**
 * Parses the recorded support answer when present.
 *
 * @param record - The raw `support` field.
 * @param where - Where the example came from.
 * @returns The recorded support answer, or `undefined`.
 * @throws {EvalSetError} When present but incomplete.
 */
function parseRecordedSupport(record: Record<string, unknown> | undefined, where: string): RecordedSupport | undefined {
  if (record === undefined) return undefined;
  const at = `${where} recorded.support`;
  return {
    choice: requiredString(record, "choice", at),
    probabilities: requiredDistribution(record, "probabilities", at),
    confidence: requiredProbability(record, "confidence", at),
  };
}

/**
 * Parses the recorded answers of one example.
 *
 * @param value - The raw `recorded` field.
 * @param where - Where the example came from.
 * @returns The recorded answers.
 * @throws {EvalSetError} When a documented field is missing.
 */
function parseRecorded(value: unknown, where: string): RecordedAnswers {
  const record = asRecord(value);
  if (record === undefined) throw new EvalSetError(`${where}: recorded is required when extracted is true`);
  const classification = asRecord(record["classification"]);
  if (classification === undefined) {
    throw new EvalSetError(`${where}: recorded.classification is required`);
  }
  const support = parseRecordedSupport(asRecord(record["support"]), where);
  const answers: RecordedAnswers =
    classification["failure"] === "provider_failed"
      ? { classification: { failure: "provider_failed" }, ...(support === undefined ? {} : { support }) }
      : { classification: parseRecordedClassification(classification, where), ...(support === undefined ? {} : { support }) };
  return answers;
}

/**
 * Parses the extractor's proposed type, which may be an explicit `null`.
 *
 * @param record - The object to read.
 * @param where - Where the example came from.
 * @returns The proposed type, or `null`.
 * @throws {EvalSetError} When absent or not a string.
 */
function parseProposedType(record: Record<string, unknown>, where: string): string | null {
  const value = record["proposedType"];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new EvalSetError(`${where}: candidate.proposedType is required, and may be null but not absent`);
  }
  return value;
}

/**
 * Reads the object a kind-specific block must be, naming the block.
 *
 * @param value - The raw field.
 * @param block - The block name, for the error message.
 * @param where - Where the example came from.
 * @returns The record.
 * @throws {EvalSetError} When the block is absent.
 */
function requiredBlock(value: unknown, block: string, where: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new EvalSetError(`${where}: ${block} is required and must be an object`);
  return record;
}

/**
 * Parses an emitted entity candidate.
 *
 * @param value - The raw `candidate` field.
 * @param where - Where the example came from.
 * @returns The candidate spec.
 * @throws {EvalSetError} When a required field is missing.
 */
function parseEntityCandidate(value: unknown, where: string): EntityCandidateSpec {
  const record = requiredBlock(value, "candidate", where);
  const at = `${where} candidate`;
  return { name: requiredString(record, "name", at), proposedType: parseProposedType(record, at) };
}

/**
 * Parses an emitted relation candidate.
 *
 * @param value - The raw `candidate` field.
 * @param where - Where the example came from.
 * @returns The candidate spec.
 * @throws {EvalSetError} When a required field is missing.
 */
function parseRelationCandidate(value: unknown, where: string): RelationCandidateSpec {
  const record = requiredBlock(value, "candidate", where);
  const at = `${where} candidate`;
  return {
    from: requiredString(record, "from", at),
    predicate: requiredString(record, "predicate", at),
    to: requiredString(record, "to", at),
    proposedType: parseProposedType(record, at),
  };
}

/**
 * Parses the labeled fact of a missed entity.
 *
 * @param value - The raw `fact` field.
 * @param where - Where the example came from.
 * @returns The labeled fact.
 * @throws {EvalSetError} When the fact is absent.
 */
function parseEntityFact(value: unknown, where: string): LabeledEntityFact {
  return { name: requiredString(requiredBlock(value, "fact", where), "name", `${where} fact`) };
}

/**
 * Parses the labeled fact of a missed relation.
 *
 * @param value - The raw `fact` field.
 * @param where - Where the example came from.
 * @returns The labeled fact.
 * @throws {EvalSetError} When the fact is absent.
 */
function parseRelationFact(value: unknown, where: string): LabeledRelationFact {
  const record = requiredBlock(value, "fact", where);
  const at = `${where} fact`;
  return {
    from: requiredString(record, "from", at),
    predicate: requiredString(record, "predicate", at),
    to: requiredString(record, "to", at),
  };
}

/**
 * Parses one example of either kind.
 *
 * @param record - The raw example object.
 * @param where - Where the example came from.
 * @returns The labeled example.
 * @throws {EvalSetError} When a required field or label is missing.
 */
function parseEntityExample(record: Record<string, unknown>, common: ExampleBase): LabeledExample {
  const where = `example ${common.id}`;
  return common.extracted
    ? {
        ...common,
        kind: "entity",
        candidate: parseEntityCandidate(record["candidate"], where),
        recorded: parseRecorded(record["recorded"], where),
      }
    : { ...common, kind: "entity", fact: parseEntityFact(record["fact"], where) };
}

/**
 * Parses one relation example.
 *
 * @param record - The raw example object.
 * @param common - The fields both kinds share.
 * @returns The labeled example.
 * @throws {EvalSetError} When a required field or label is missing.
 */
function parseRelationExample(record: Record<string, unknown>, common: ExampleBase): LabeledExample {
  const where = `example ${common.id}`;
  return common.extracted
    ? {
        ...common,
        kind: "relation",
        candidate: parseRelationCandidate(record["candidate"], where),
        recorded: parseRecorded(record["recorded"], where),
      }
    : { ...common, kind: "relation", fact: parseRelationFact(record["fact"], where) };
}

/**
 * Parses one example, deriving what its kind requires.
 *
 * @param value - The raw example.
 * @param index - Position in the set, for the error message.
 * @returns The labeled example.
 * @throws {EvalSetError} When any required field or label is missing.
 */
function parseExample(value: unknown, index: number): LabeledExample {
  const record = asRecord(value);
  const id = asString(record?.["id"]) ?? `#${String(index)}`;
  const where = `example ${id}`;
  if (record === undefined) throw new EvalSetError(`${where}: must be an object`);
  const kind = record["kind"];
  if (kind !== "entity" && kind !== "relation") {
    throw new EvalSetError(`${where}: kind must be "entity" or "relation"`);
  }
  const language = requiredString(record, "language", where);
  if (!LANGUAGES.includes(language as LabeledLanguage)) {
    throw new EvalSetError(`${where}: language must be one of ${LANGUAGES.join(", ")}`);
  }
  const extracted = record["extracted"];
  if (typeof extracted !== "boolean") {
    throw new EvalSetError(`${where}: extracted is required and must be a boolean`);
  }
  const common: ExampleBase = {
    id,
    language: language as LabeledLanguage,
    source: requiredString(record, "source", where),
    quote: requiredString(record, "quote", where),
    claim: requiredString(record, "claim", where),
    extracted,
    labels: parseLabels(record["labels"], where),
  };
  return kind === "entity" ? parseEntityExample(record, common) : parseRelationExample(record, common);
}

/**
 * Parses and validates a whole labeled set.
 *
 * @param value - The parsed JSON, or anything else.
 * @returns The validated set.
 * @throws {EvalSetError} When the set is empty, misversioned, or has a duplicate id.
 */
export function parseEvalSet(value: unknown): EvalSet {
  const record = asRecord(value);
  if (record === undefined) throw new EvalSetError("the labeled set must be an object");
  const version = requiredString(record, "version", "labeled set");
  const rawExamples = record["examples"];
  if (!Array.isArray(rawExamples) || rawExamples.length === 0) {
    throw new EvalSetError("labeled set: examples must be a non-empty array");
  }
  const examples = rawExamples.map((item, index) => parseExample(item, index));
  const seen = new Set<string>();
  for (const example of examples) {
    if (seen.has(example.id)) throw new EvalSetError(`labeled set: duplicate example id ${example.id}`);
    seen.add(example.id);
  }
  return { version, examples };
}

/**
 * Loads the labeled set from disk.
 *
 * @param path - The JSON file, or a URL to it.
 * @returns The validated set.
 * @throws {EvalSetError} When the file is unreadable or not valid JSON.
 */
export function loadEvalSet(path: string | URL = DEFAULT_EVAL_SET_PATH): EvalSet {
  const file = typeof path === "string" ? path : fileURLToPath(path);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new EvalSetError(`cannot read the labeled set at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseEvalSet(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof EvalSetError) throw error;
    throw new EvalSetError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
