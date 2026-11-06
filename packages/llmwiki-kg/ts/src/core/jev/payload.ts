/**
 * @file packages/llmwiki-kg/ts/src/core/jev/payload.ts
 * @description Validating an untrusted System One payload before anything reads it.
 *
 * ## Why validation is one function, applied everywhere
 *
 * A decision payload reaches this process from three directions — the HTTP client,
 * a test double replaying a captured body, and any future in-process decision
 * maker — and in all three it is untrusted input. One validator, applied at the
 * boundary that produces a {@link JevDecisionOutcome}, means no caller can end up
 * reading a missing answer as an abstention: a payload that does not match the
 * documented shape is rejected whole, so "the vendor omitted the companion noul"
 * becomes an operational failure instead of `NO_MATCH` (S25).
 *
 * ## What is checked, and what is deliberately tolerated
 *
 * Checked: the envelope has a `model` string and an `answers` record; every answer
 * is one of the two documented variants with its documented fields; `choice`
 * probabilities and the `noul` probability are finite numbers within `[0, 1]`;
 * `confidence` is a finite number.
 *
 * Tolerated: extra keys the vendor may add (ignored, never read), an absent
 * `usage` (opaque to us), and any `confidence` outside `[0, 1]` — the vendor
 * documents it as a derived dispersion measure without pinning a range, and
 * rejecting a value we merely find surprising would discard a real answer.
 */

import { asRecord, asString } from "../llm/json.js";
import type { JevAnswer, JevChoiceAnswer, JevDecisionResponse, JevNoulAnswer } from "./types.js";

/**
 * Whether a value is a usable probability.
 *
 * @param value - Anything the payload carried.
 * @returns True for a finite number within `[0, 1]`.
 */
function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validates a `choice` answer's probability distribution.
 *
 * @param value - The raw `probabilities` field.
 * @returns The distribution, or `undefined` when any entry is not a probability.
 */
function parseProbabilities(value: unknown): Readonly<Record<string, number>> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [label, raw] of Object.entries(record)) {
    if (!isProbability(raw)) return undefined;
    probabilities[label] = raw;
  }
  return probabilities;
}

/**
 * Validates one `choice` answer.
 *
 * @param record - The raw answer object.
 * @returns The answer, or `undefined` when a documented field is missing or wrong.
 */
function parseChoiceAnswer(record: Record<string, unknown>): JevChoiceAnswer | undefined {
  const choice = asString(record["choice"]);
  const probabilities = parseProbabilities(record["probabilities"]);
  const confidence = record["confidence"];
  if (choice === undefined || probabilities === undefined || typeof confidence !== "number") return undefined;
  if (!Number.isFinite(confidence)) return undefined;
  return { type: "choice", choice, probabilities, confidence };
}

/**
 * Validates one `noul` answer.
 *
 * @param record - The raw answer object.
 * @returns The answer, or `undefined` when the single probability is not one.
 */
function parseNoulAnswer(record: Record<string, unknown>): JevNoulAnswer | undefined {
  const noul = record["noul"];
  return isProbability(noul) ? { type: "noul", noul } : undefined;
}

/**
 * Validates one answer of either documented variant.
 *
 * @param value - The raw answer.
 * @returns The answer, or `undefined` when it is neither variant.
 */
function parseAnswer(value: unknown): JevAnswer | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  switch (record["type"]) {
    case "choice":
      return parseChoiceAnswer(record);
    case "noul":
      return parseNoulAnswer(record);
    default:
      return undefined;
  }
}

/**
 * Validates a whole System One response.
 *
 * Any single unusable answer rejects the payload, because a partially usable
 * response cannot be interpreted without guessing which question went wrong.
 *
 * @param value - The parsed JSON body, or anything else.
 * @returns The validated response, or `undefined` when it is not the documented shape.
 */
export function parseDecisionResponse(value: unknown): JevDecisionResponse | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const model = asString(record["model"]);
  const rawAnswers = asRecord(record["answers"]);
  if (model === undefined || rawAnswers === undefined) return undefined;
  const answers: Record<string, JevAnswer> = {};
  for (const [questionId, raw] of Object.entries(rawAnswers)) {
    const answer = parseAnswer(raw);
    if (answer === undefined) return undefined;
    answers[questionId] = answer;
  }
  const usage = record["usage"];
  return usage === undefined ? { model, answers } : { model, answers, usage };
}
