/**
 * Citation / provenance lint rules.
 *
 * This family validates the `^[file.md]` citation markers that anchor wiki
 * prose to its sources: broken citations (source file missing or claim-level
 * line span out of bounds) and malformed claim citations (entries that don't
 * parse against the documented `file.md` / `file.md:N-N` / `file.md:N,N-M`
 * / `file.md#LN-LN` grammar). Each on-disk walker has a pure per-page variant
 * so the in-memory candidate-lint path (`compile --review`) surfaces the same
 * findings before a reviewer approves a candidate. Re-exported through
 * {@link file://./rules.ts}.
 */

import { existsSync } from "fs";
import path from "path";
import {
  isMalformedCitationEntry,
  parseCitationLineRanges,
  parseFrontmatter,
  safeReadFile,
  splitCitationMarker,
} from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { LintResult } from "./types.js";
import { lintSourceText } from "./corpus.js";

/** Rule id for a claim citation that does not parse; the profile registry declares it by this name. */
export const MALFORMED_CLAIM_CITATION_RULE = "malformed-claim-citation";
import {
  CITATION_PATTERN,
  readLintPages,
  findMatchesInContent,
} from "./rules-shared.js";

/** Strip an optional `:start-end` or `#Lstart-Lend` span suffix from a citation entry. */
function stripSpanSuffix(entry: string): string {
  return entry.split(/[:#]/, 1)[0];
}

/** Count the number of lines in a file's text content. */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

/**
 * Find ^[filename.md] citations referencing source files that don't exist, and
 * flag claim-level spans whose line ranges exceed the source file's actual length.
 * Handles both single-source ^[file.md] and multi-source ^[a.md, b.md] forms,
 * plus claim-level spans such as `^[file.md:42-58]`, `^[file.md:1, 4-6]`,
 * and `^[file.md#L42-L58]`. Line counts are cached per source file to avoid
 * redundant reads.
 */
export async function checkBrokenCitations(root: string): Promise<LintResult[]> {
  const pages = await readLintPages(root);
  const sourcesDir = path.join(root, SOURCES_DIR);
  const results: LintResult[] = [];
  const lineCountCache = new Map<string, number>();

  for (const page of pages) {
    const { meta } = parseFrontmatter(page.content);
    // Imported pages cite EXTERNAL bundle sources (not copied into sources/), so
    // local source-existence does not apply — exempt them from broken-citation.
    if (meta.provenanceState === "imported") continue;
    const pageFindings = await checkPageBrokenCitations(
      page.content,
      page.filePath,
      sourcesDir,
      lineCountCache,
    );
    results.push(...pageFindings);
  }

  return results;
}

/**
 * Pure-body variant of {@link checkBrokenCitations} that inspects a single
 * page's content against an in-memory or on-disk sources directory. Used
 * by the on-disk lint walker above, and by the in-memory candidate-lint
 * path so `compile --review` surfaces broken-source-file and out-of-bounds
 * span findings before a reviewer approves the candidate.
 *
 * @param content - Full page markdown including frontmatter.
 * @param filePath - Logical path embedded in diagnostics (may be virtual).
 * @param sourcesDir - Absolute path to the project's sources/ directory.
 * @param lineCountCache - Optional cross-page cache; provide one when
 *   linting many pages so source file line counts aren't re-read.
 */
export async function checkPageBrokenCitations(
  content: string,
  filePath: string,
  sourcesDir: string,
  lineCountCache: Map<string, number> = new Map(),
): Promise<LintResult[]> {
  const results: LintResult[] = [];
  for (const { captured, line } of findMatchesInContent(content, CITATION_PATTERN)) {
    await collectBrokenForMarker(captured, line, filePath, sourcesDir, lineCountCache, results);
  }
  return results;
}

/** Append broken-citation diagnostics for every entry inside a single ^[...] marker. */
async function collectBrokenForMarker(
  captured: string,
  line: number,
  pageFile: string,
  sourcesDir: string,
  lineCountCache: Map<string, number>,
  out: LintResult[],
): Promise<void> {
  for (const part of splitCitationMarker(captured)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const finding = await inspectCitation(
      trimmed, line, pageFile, sourcesDir, lineCountCache,
    );
    if (finding !== null) out.push(finding);
  }
}

/** The diagnostic for a missing cited document. */
function missingSource(filename: string, pageFile: string, line: number): LintResult {
  return {
    rule: "broken-citation",
    severity: "error",
    file: pageFile,
    message: `Broken citation ^[${filename}] — source file not found`,
    line,
  };
}

/**
 * Resolve the text of one cited document.
 *
 * Three answers, and they are not interchangeable: the corpus may KNOW the text
 * (`string`), may know the document does not exist (`null`), or may not be able to
 * answer at all (`undefined`, a file-backed project, where `sources/` is the corpus).
 *
 * @returns The text, or `null` when the document is known to be absent.
 */
async function citedSourceText(
  filename: string,
  citedPath: string,
): Promise<{ readonly text: string | null } | { readonly absent: true }> {
  const corpusText = lintSourceText(filename);
  if (corpusText === null) return { absent: true };
  if (corpusText !== undefined) return { text: corpusText };
  return existsSync(citedPath) ? { text: null } : { absent: true };
}

/**
 * Evaluate one citation entry, returning at most one finding.
 *
 * @param trimmed - The entry with surrounding whitespace removed.
 * @returns The finding, or `null` when the citation is sound.
 */
async function inspectCitation(
  trimmed: string,
  line: number,
  pageFile: string,
  sourcesDir: string,
  lineCountCache: Map<string, number>,
): Promise<LintResult | null> {
  const filename = stripSpanSuffix(trimmed);
  const citedPath = path.join(sourcesDir, filename);
  const resolved = await citedSourceText(filename, citedPath);
  if ("absent" in resolved) return missingSource(filename, pageFile, line);

  const ranges = parseCitationLineRanges(trimmed);
  if (ranges === null || ranges.length === 0) return null;
  const lineCount = resolved.text === null
    ? await resolveLineCount(citedPath, filename, lineCountCache)
    : countLines(resolved.text);
  if (ranges.every((range) => range.end <= lineCount)) return null;
  return {
    rule: "broken-citation",
    severity: "error",
    file: pageFile,
    message: `Claim-level span ^[${trimmed}] is out of bounds (source has only ${lineCount} lines)`,
    line,
  };
}

/** Return the line count for a source file, reading and caching if necessary. */
async function resolveLineCount(
  citedPath: string,
  filename: string,
  cache: Map<string, number>,
): Promise<number> {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached;
  const content = await safeReadFile(citedPath);
  const lineCount = countLines(content);
  cache.set(filename, lineCount);
  return lineCount;
}

/**
 * Find ^[...] markers whose entries do not parse against the documented
 * paragraph or claim-level grammar (e.g. `^[file.md:abc]` or `^[file.md#X]`).
 * Detects malformed claim-level citations without breaking the paragraph form.
 */
export async function checkMalformedClaimCitations(root: string): Promise<LintResult[]> {
  const pages = await readLintPages(root);
  const results: LintResult[] = [];
  for (const page of pages) {
    results.push(...checkPageMalformedCitations(page.content, page.filePath));
  }
  return results;
}

/**
 * Pure-body variant of {@link checkMalformedClaimCitations} that inspects
 * a single page's content. Used by both the on-disk lint walker above and
 * the in-memory candidate-lint path so `compile --review` surfaces
 * malformed claim citations before a reviewer approves the candidate.
 */
export function checkPageMalformedCitations(content: string, filePath: string): LintResult[] {
  const results: LintResult[] = [];
  for (const { captured, line } of findMatchesInContent(content, CITATION_PATTERN)) {
    for (const part of splitCitationMarker(captured)) {
      if (!isMalformedCitationEntry(part)) continue;
      results.push({
        rule: MALFORMED_CLAIM_CITATION_RULE,
        severity: "error",
        file: filePath,
        message: `Malformed claim citation ^[${captured}] — expected file.md, file.md:N-N, file.md:N,N-M,…, or file.md#LN-LN`,
        line,
      });
    }
  }
  return results;
}
