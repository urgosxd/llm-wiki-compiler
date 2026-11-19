/**
 * @file An unreadable citation index is not a Stack with zero pages.
 *
 * `collectAnswerCitationIndex` used to collapse "I could not read my source" into
 * `{ retained: [], pending: [] }`, a value that already means "nothing to check". The
 * two answers are not the same fact and must not share a representation: the first is a
 * failed read, the second a complete one that found no pages. These cases pin the
 * discriminator in both directions, and pin what the two production boundaries do with
 * each.
 *
 * A root that cannot be resolved is the disk-source case (a row-backed caller is
 * readable by construction, because its pages come from `RawPageSource.collect()`).
 * Genuine I/O faults still propagate unchanged; only the unresolved root — which used
 * to become a successful empty index — is named here.
 */
import "./fixtures/file-mode.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AnswerCitationIndexUnreadableError, collectAnswerCitationIndex } from "../packages/wiki/src/citations/answer-index.js";
import { reportAnswerCitations } from "../packages/wiki/src/citations/answer-report.js";
import { validateCitationPublication } from "../packages/wiki/src/citations/answer-publication.js";
import { reportQueryAnswerCitations } from "../packages/wiki/src/commands/query-citation-report.js";
import * as output from "../packages/wiki/src/utils/output.js";

let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "answer-index-unreadable-"))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

/** A path nothing is listening at: no such directory exists under the temp root. */
function unresolvable(): string {
  return path.join(root, `absent-${randomUUID()}`);
}

it("throws for a root it cannot resolve instead of reporting zero pages", async () => {
  const absent = unresolvable();
  await expect(collectAnswerCitationIndex(absent)).rejects.toThrow(absent);
  // The advisory report is built on the index, so it must not answer either.
  await expect(reportAnswerCitations(absent, "Grounded in [[alpha]].")).rejects.toThrow(absent);
  await expect(collectAnswerCitationIndex(absent)).rejects.toBeInstanceOf(AnswerCitationIndexUnreadableError);
});

it("reports an unreadable index as unavailable instead of printing verdicts", async () => {
  const note = vi.spyOn(output, "note").mockImplementation(() => {});
  const status = vi.spyOn(output, "status").mockImplementation(() => {});
  expect(await reportQueryAnswerCitations(unresolvable(), "Grounded in [[alpha]].")).toEqual({});
  expect(note).toHaveBeenCalledTimes(1);
  expect(note.mock.calls[0]?.[0]).toMatch(/^Answer citations: unavailable \(/);
  expect(status).not.toHaveBeenCalled();
});

it("refuses publication validation rather than publishing an unverifiable document", async () => {
  const document = "---\ntitle: An answer\n---\n\nGrounded in [[alpha]].\n";
  await expect(validateCitationPublication(unresolvable(), document, "direct", "an-answer")).rejects
    .toBeInstanceOf(AnswerCitationIndexUnreadableError);
});

it("still returns an empty index for a readable root that has no pages", async () => {
  expect(await collectAnswerCitationIndex(root)).toEqual({ retained: [], pending: [] });
  expect((await reportAnswerCitations(root, "Grounded in [[alpha]].")).citations)
    .toEqual([{ target: "alpha", status: "broken" }]);
});
