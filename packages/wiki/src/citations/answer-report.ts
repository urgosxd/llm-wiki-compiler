/**
 * Answer-body diagnostics using the production tokenizer and retained resolver.
 * Unique normalized targets retain first-occurrence order; admitted pending
 * proposals are considered only after retained resolution fails. Reports are
 * snapshots, not factual-support judgments or authority to publish an answer.
 */
import type { AnswerCitation, AnswerCitationIndex, AnswerCitationReport } from "./answer-types.js";
import type { RawPageSource } from "../dimensions/wiki/page-scan-source.js";
import { recognizedWikilinkTargets } from "../wiki/wikilink-tokens.js";
import { resolveBareSlug } from "../viewer/collect.js";
import { collectAnswerCitationIndex } from "./answer-index.js";

/**
 * Build a fresh snapshot and classify the caller's canonical answer body.
 *
 * @param root - Project root, read on the file-backed path.
 * @param body - Canonical answer body to classify.
 * @param source - The row page reader the caller's seam resolved, or `undefined` to read
 *   `wiki/` from disk. Forwarded untouched: this function has no opinion about the
 *   backend, and a fallback here is exactly how a Stack's citations resolved nothing.
 * @returns The report; a source that cannot be read throws rather than reporting no links.
 */
export async function reportAnswerCitations(
  root: string,
  body: string,
  source?: RawPageSource,
): Promise<AnswerCitationReport> {
  return classifyAnswerCitations(body, await collectAnswerCitationIndex(root, source));
}

/** Classify unique answer wikilinks in first-occurrence order. */
export function classifyAnswerCitations(body: string, index: AnswerCitationIndex): AnswerCitationReport {
  const citations = [...new Set(recognizedWikilinkTargets(body))].map((target): AnswerCitation => {
    const pageId = resolveBareSlug(target, index.retained);
    if (pageId) return { target, status: "resolved", pageId };
    const candidateIds = [...new Set(index.pending
      .filter((entry) => entry.target === target)
      .map((entry) => entry.candidateId))].sort();
    return candidateIds.length
      ? { target, status: "pending", candidateIds }
      : { target, status: "broken" };
  });
  return { version: 1, citations };
}
