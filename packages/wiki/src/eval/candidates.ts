/**
 * Advisory evaluation of pending concept/query candidates. Reads the queue and
 * current sources, then reuses the citation judge without publishing anything.
 * Candidate reports are separate from live history and thresholds by design.
 */
import path from "node:path";
import { readCandidateSnapshot } from "../compiler/candidate-read.js";
import { resolveConfinedCandidatesDir } from "../compiler/candidate-store-paths.js";
import { listCandidateFileIds } from "../utils/candidate-store.js";
import { CANDIDATES_DIR } from "../utils/constants.js";
import { atomicWrite } from "../utils/markdown.js";
import { ensureCompileProviderAvailable, ProviderUnavailableError, UnknownProviderError } from "../utils/provider-guard.js";
import { candidateAssessments, currentEvidenceReader, evaluationHash } from "./candidate-evidence.js";
import { candidateJudgeConfig } from "./candidate-judge-config.js";
import { createCitationJudge, selectDeterministicSample, type CitationPair } from "./citation-support.js";
import type { CandidateAssessment, CandidateEvalReport, CandidateReference } from "./candidate-types.js";
import type { ReviewCandidate } from "../utils/types.js";
import { withCandidateSource } from "../dimensions/wiki/candidate-source.js";

/**
 * The serialized form the evaluator hashes.
 *
 * `revision` and the generation hashes are computed from the record's TEXT, and the
 * file path got that text by reading the leaf. A row has no leaf, so the same shape
 * is reproduced here with the writer's own serialization. Without this the evaluator
 * would hash a different string for the same candidate depending on the backend, and
 * a cached verdict would look stale on every run.
 *
 * @param candidate - The candidate as stored.
 * @returns The text the file backend would have written.
 */
function serializedFor(candidate: ReviewCandidate): string {
  return JSON.stringify(candidate, null, 2);
}

/** The directory approval writes to: any value other than "queries" routes to concepts. */
function approvalDirectory(candidate: ReviewCandidate): "concepts" | "queries" {
  return candidate.targetDirectory === "queries" ? "queries" : "concepts";
}

/** Capture identity of the loaded record, including metadata and full page content. */
function referenceFor(candidate: ReviewCandidate, raw: string): CandidateReference {
  return { id: candidate.id, target: `${approvalDirectory(candidate)}/${candidate.slug}`,
    generatedAt: candidate.generatedAt, revision: evaluationHash(raw),
    contentHash: evaluationHash(candidate.body) };
}

/** Read only hash strings, preserving nested source keys without changing approval sanitization. */
function generationHashes(raw: string): Record<string, string> {
  const states: unknown = (JSON.parse(raw) as Record<string, unknown>).sourceStates;
  if (!states || typeof states !== "object" || Array.isArray(states)) return {};
  return Object.fromEntries(Object.entries(states).flatMap(([file, state]) => {
    const hash = state && typeof state === "object" ? (state as Record<string, unknown>).hash : undefined;
    return typeof hash === "string" && hash.length ? [[file, hash]] : [];
  }));
}

/** Preserve invalid/unsupported queue entries as explicit skips. */
function skipReason(candidate: ReviewCandidate | undefined, id: string): string | undefined {
  if (!candidate || candidate.id !== id) return "Candidate is missing, malformed, or has a mismatched file id.";
  // Only typed candidates leave the default pages; an unrecognized directory is
  // still published by approval (into concepts), so it is assessed like one.
  if (candidate.targetEntityType) return "Typed profile candidates are outside this evaluation scope.";
  return undefined;
}

/** Inventory candidate snapshots without mutating the queue or compile state. */
async function collectPending(root: string, report: CandidateEvalReport): Promise<void> {
  // Rows when a Stack is configured. The file walk below answers "no candidates" on a
  // Stack-backed project because the directory does not exist, so the whole evaluation
  // silently reported an empty queue instead of assessing anything.
  const fromRows = await withCandidateSource(process.env, async (source) => {
    if (source === undefined) return undefined;
    const pending = (await source.list())
      .map((candidate) => ({ candidate, raw: serializedFor(candidate), id: candidate.id }))
      .sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
    return pending;
  });
  const snapshots = fromRows ?? await readFileSnapshots(root);
  const read = currentEvidenceReader(root);
  for (const snapshot of snapshots) {
    const { candidate, raw } = snapshot;
    // A leaf that failed to parse has no candidate at all; report it by id so the
    // skip message is the same one the file backend produced.
    if (candidate === undefined) {
      report.skippedCandidates.push({ id: snapshot.id, reason: skipReason(undefined, snapshot.id)! });
      continue;
    }
    const reason = skipReason(candidate, candidate.id);
    if (reason) {
      report.skippedCandidates.push({ id: candidate.id, reason });
      continue;
    }
    const reference = referenceFor(candidate, raw);
    report.candidates.push(reference);
    const { assessments, prose, cited } = await candidateAssessments(
      { body: candidate.body, hashes: generationHashes(raw) }, reference, read);
    report.assessments.push(...assessments);
    report.coverage.proseParagraphs += prose;
    report.coverage.citedParagraphs += cited;
    if (!prose) report.skippedCandidates.push({ id: candidate.id, reason: "No prose paragraphs in the evaluator's scope." });
  }
}

/** One loaded candidate plus the text the evaluator hashes it from. */
interface CandidateSnapshot {
  /** Absent when the leaf could not be read or parsed. */
  candidate: ReviewCandidate | undefined;
  raw: string;
  /** The id under which a failed leaf was listed. */
  id: string;
}

/** Read the queue from the file backend, in the same id order rows use. */
async function readFileSnapshots(root: string): Promise<CandidateSnapshot[]> {
  const dir = await resolveConfinedCandidatesDir(root, CANDIDATES_DIR);
  const ids = dir ? (await listCandidateFileIds(dir)).sort() : [];
  const snapshots: CandidateSnapshot[] = [];
  for (const id of ids) {
    const snapshot = await readCandidateSnapshot(root, id);
    // An unreadable or malformed leaf is reported as a skip, exactly as before; the
    // caller decides the reason so the message stays identical.
    snapshots.push({ candidate: snapshot?.candidate, raw: snapshot?.raw ?? "", id });
  }
  return snapshots;
}

/** Convert one eligible observation to the shared engine's input. */
function citationPair(item: CandidateAssessment): CitationPair {
  const evidence = item.evidence!;
  return { claimHash: item.id, pageSlug: `candidate:${item.candidate.id}@${item.candidate.revision}`,
    claimText: item.claimText, citedFile: evidence.file, spanText: evidence.spanText!,
    lineStart: evidence.lineStart!, lineEnd: evidence.lineEnd! };
}

/** Configure the chat-only judge once, retaining safe guidance when unavailable. */
async function prepareJudge(root: string, report: CandidateEvalReport) {
  try {
    ensureCompileProviderAvailable(false);
    return await createCitationJudge(root, candidateJudgeConfig());
  } catch (error) {
    report.judgeUnavailable = error instanceof ProviderUnavailableError ? error.message
      : error instanceof UnknownProviderError ? "Unknown chat provider; check LLMWIKI_PROVIDER."
      : "Cannot configure citation judge; check provider settings and the evaluation cache.";
    return null;
  }
}

/** Judge a bounded sample, preserving coverage and failures even when unavailable. */
async function judgePending(root: string, report: CandidateEvalReport, sampleSize: number): Promise<void> {
  const eligible = report.assessments.filter(item => item.status === "eligible");
  if (!eligible.length) return;
  const judge = await prepareJudge(root, report);
  const pairs = selectDeterministicSample(eligible.map(citationPair), sampleSize);
  const selected = new Map(pairs.map(pair => [pair.claimHash, pair]));
  report.coverage.selectedPairs = pairs.length;
  for (const item of eligible) {
    const pair = selected.get(item.id);
    item.status = pair ? "judge-error" : "not-sampled";
    if (!pair) continue;
    if (!judge) {
      item.reason = "Judge unavailable; see judgeUnavailable for configuration guidance.";
      continue;
    }
    try {
      item.judgement = (await judge(pair)).judgement;
      item.status = "judged";
    } catch {
      // Provider errors can include sensitive endpoint details. Keep the report generic.
      item.reason = "Citation judge failed; no support verdict is available.";
    }
  }
}

/** Evaluate pending drafts; only report/cache files under .llmwiki/eval are written. */
export async function evaluateCandidates(root: string, suite: "fast" | "full", sampleSize = 20): Promise<CandidateEvalReport> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0) throw new Error("Sample size must be a positive safe integer");
  const report: CandidateEvalReport = { selection: "candidates", suite,
    timestamp: new Date().toISOString(), evidencePolicy: "current-sources", candidates: [], skippedCandidates: [],
    coverage: { proseParagraphs: 0, citedParagraphs: 0, eligiblePairs: 0, selectedPairs: 0,
      judgedPairs: 0, unjudgeable: 0, judgeErrors: 0 }, meanScore: null, assessments: [] };
  await collectPending(root, report);
  report.coverage.eligiblePairs = report.assessments.filter(item => item.status === "eligible").length;
  if (suite === "full") await judgePending(root, report, sampleSize);
  const judged = report.assessments.flatMap(item => item.judgement ? [item.judgement] : []);
  report.coverage.judgedPairs = judged.length;
  report.coverage.unjudgeable = report.assessments.filter(item => item.status === "unjudgeable").length;
  report.coverage.judgeErrors = report.assessments.filter(item => item.status === "judge-error").length;
  if (judged.length) report.meanScore = judged.reduce((sum, item) => sum + item.score, 0) / judged.length;
  await atomicWrite(path.join(root, ".llmwiki", "eval", "candidates-latest.json"), JSON.stringify(report, null, 2));
  return report;
}

/** Human-readable manual review, with identity and every skipped/unsampled observation. */
export function formatCandidateReport(report: CandidateEvalReport): string {
  const coverage = report.coverage;
  const lines = ["Pending candidate citation support (advisory; not approval)",
    `Current source evidence. ${report.candidates.length} candidates; ${coverage.citedParagraphs}/${coverage.proseParagraphs} prose paragraphs cited.`,
    `Judged ${coverage.judgedPairs}/${coverage.eligiblePairs} eligible pairs; mean score ${report.meanScore ?? "not measured"}/2.`,
    `Unjudgeable: ${coverage.unjudgeable}; judge errors: ${coverage.judgeErrors}.`];
  if (report.judgeUnavailable) lines.push(`Judge unavailable: ${report.judgeUnavailable}`);
  for (const candidate of report.candidates) {
    lines.push(`\n${candidate.id} -> ${candidate.target}\nRevision: ${candidate.revision}\nContent: ${candidate.contentHash}`);
    for (const item of report.assessments.filter(item => item.candidate.id === candidate.id)) {
      lines.push(`  Paragraph ${item.paragraph}: ${item.status}${item.evidence ? ` (${item.evidence.file}, ${item.evidence.status})` : ""}`,
        `    ${item.judgement ? `${item.judgement.score}/2: ${item.judgement.reason}` : item.reason ?? "No verdict requested/selected."}`);
    }
  }
  for (const skipped of report.skippedCandidates) lines.push(`Skipped ${skipped.id}: ${skipped.reason}`);
  lines.push("\nReport: .llmwiki/eval/candidates-latest.json; candidates and live pages unchanged.");
  return lines.join("\n");
}
