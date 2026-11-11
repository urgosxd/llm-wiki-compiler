/**
 * @file scripts/package-tasks-exactness.ts
 * @description Prove that a vitest run executed exactly the derived test selection.
 *
 * ## Why a report comparison instead of trusting the filter
 *
 * The per-package `test` task hands the derived files to vitest as positional
 * filters. Vitest matches a positional filter as a SUBSTRING of the test path, so
 * a filter is not an identity: it can select a file the derivation never named —
 * a silent widen — just as a hand-written path list can omit one, a silent narrow.
 * Both produce a green task that did not do what it claimed, which is the defect
 * class this whole slice exists to remove.
 *
 * So the run is measured instead of assumed. The run is asked to write vitest's
 * JSON report, and this module compares the set of FILES IT ACTUALLY RAN against
 * the derived set. Set equality, not a count: a run that swapped one file for
 * another has the same size and is still not the selection that was derived.
 *
 * ## Both directions fail, and a missing report fails too
 *
 * A run that wrote no report is a run that cannot be verified, so it fails rather
 * than passing by default. Extra files and missing files are named individually,
 * because "12 != 13" sends a reader hunting while the file list ends the hunt.
 *
 * PURE BY CONTRACT: this module reads one JSON file and returns messages. It owns
 * no spawn and writes nothing, so the comparison can be exercised on a report
 * produced any other way.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The slice of vitest's JSON report this module reads. */
interface VitestReport {
  /** One entry per test file the run executed. */
  testResults?: { name: string }[];
}

/** Repository-relative POSIX form of an absolute path, for stable comparison. */
export function repoRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

/** Read the JSON report, or `null` when vitest wrote none. */
function readReport(reportPath: string): VitestReport | null {
  if (!existsSync(reportPath)) return null;
  return JSON.parse(readFileSync(reportPath, "utf8")) as VitestReport;
}

/** The files the report says were executed, repository-relative. */
function ranFiles(root: string, report: VitestReport): Set<string> {
  return new Set((report.testResults ?? []).map((entry) => repoRelative(root, entry.name)));
}

/** Describe one direction of an inexact run, prefixed so a reader sees which side lost. */
function describeSide(label: string, files: readonly string[]): string[] {
  return files.map((file) => `  ${label}: ${file}`);
}

/**
 * Compare the files vitest actually ran with the derived selection.
 *
 * @param root - Absolute repository root the report's absolute paths are made relative to.
 * @param reportPath - Path of the JSON report the run was asked to write.
 * @param expected - The derived selection.
 * @returns One message per problem; an empty list means the run was exact.
 */
export function exactnessErrors(
  root: string,
  reportPath: string,
  expected: readonly string[],
): string[] {
  const report = readReport(reportPath);
  if (report === null) {
    return [`vitest wrote no JSON report at ${reportPath}, so the run cannot be verified`];
  }
  const ran = ranFiles(root, report);
  const wanted = new Set(expected);
  const extra = [...ran].filter((file) => !wanted.has(file)).sort();
  const missing = [...wanted].filter((file) => !ran.has(file)).sort();
  if (extra.length === 0 && missing.length === 0) return [];
  return [
    `vitest ran ${ran.size} file(s) for a ${wanted.size}-file derived selection`,
    ...describeSide("ran but not derived", extra),
    ...describeSide("derived but not run", missing),
  ];
}
