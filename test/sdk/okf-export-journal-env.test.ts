/**
 * @file test/sdk/okf-export-journal-env.test.ts
 * @description The OKF bundle's `log.md` header comes from the Stack the CALLER's
 * handle names, not from the process the export happens to run in.
 *
 * ## Why the journal header is a door of its own
 *
 * `exportOkf` forwards the handle's `env` into `runOkfExport`, which uses it for every
 * page it collects, for `index.md` and for the report. The bundle's `log.md` was left
 * out: `readJournalMarkdown` (`export/okf/bundle.ts:129`) read
 * `withJournalSource(process.env, …)`, an ambient selection standing in for the
 * caller's argument. A handle bound to Stack B therefore shipped Stack A's journal
 * heading inside an otherwise correct bundle -- a cross-tenant read that no field of
 * the bundle contradicts, and the reason this suite exists rather than a comment.
 *
 * ## Why the case seeds a journal INSTEAD of asserting on pages
 *
 * The page half is already pinned by `test/sdk/okf-export-env.test.ts`. What is specific
 * to this line is that `log.md` carries a HEADING, so the two Stacks are given different
 * journal descriptions and the assertion reads them back out of the written bundle: B's
 * line present (a fix that drops the header cannot pass) and A's line absent (no ambient
 * header survives). The two entries carry different dates, so a failure shows which
 * Stack's journal the bundle was assembled from -- and the date half has its own case, so
 * the heading and the text under it are each witnessed rather than assumed.
 *
 * Default `TESTCONTAINERS_REUSE_ENABLE=false`: a reused container carrying another
 * commit's schema is refused rather than trusted, and no suite here looks green with no
 * database -- `handleOnBoundStack` throws when nothing reached the worker.
 */
import { afterAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  appendStackJournalEntry,
  createTwoStacks,
  handleOnAmbientStack,
  handleOnBoundStack,
} from "./two-stack-env.js";
import type { OkfExportReport } from "../../packages/wiki/src/export/okf/run.js";

/** The journal line only the Stack the PROCESS serves holds. */
const AMBIENT_JOURNAL = "ingested the ambient stack's only source";

/** The journal line only the Stack the HANDLE names holds. */
const BOUND_JOURNAL = "ingested the bound stack's only source";

/** The day only the Stack the HANDLE names journalled in. */
const BOUND_JOURNAL_AT = new Date("2024-03-02T10:00:00Z");

/** The day only the Stack the PROCESS serves journalled in; a different day keeps a failure readable. */
const AMBIENT_JOURNAL_AT = new Date("2024-03-01T10:00:00Z");

const two = await createTwoStacks("sdk-okf-journal-env");
await appendStackJournalEntry(two.ambient, AMBIENT_JOURNAL, AMBIENT_JOURNAL_AT);
await appendStackJournalEntry(two.bound, BOUND_JOURNAL, BOUND_JOURNAL_AT);

afterAll(async () => {
  await two.release();
});

/** Read the bundle's `log.md` back, failing loudly when the export wrote none. */
async function exportedLog(writtenPaths: string[]): Promise<string> {
  const logPath = writtenPaths.find((written) => path.basename(written) === "log.md");
  if (logPath === undefined) throw new Error("the export wrote no log.md");
  return readFile(logPath, "utf8");
}

/** The `## <YYYY-MM-DD>` heading an OKF `log.md` gives one journal day. */
function journalDay(at: Date): string {
  return `## ${at.toISOString().slice(0, 10)}`;
}

it("builds log.md from the journal of the Stack the handle names", async () => {
  const wiki = await handleOnBoundStack(two);
  // The committed facade contract reports `Promise<unknown>` for this door; the shape read
  // below is `runOkfExport`'s, so it is narrowed here rather than in the contract.
  const report = (await wiki.exportOkf({ out: path.join(two.root, "bundle-journal") })) as OkfExportReport;
  const log = await exportedLog(report.writtenPaths);

  expect(log).toContain(BOUND_JOURNAL);
  expect(log).not.toContain(AMBIENT_JOURNAL);
}, 60_000);

// PRESERVE: the documented DEFAULT this change must not move. A handle that names no
// environment addresses the AMBIENT Stack, so its `log.md` is the ambient journal's.
it("still builds log.md from the ambient journal when the handle names no environment", async () => {
  const wiki = handleOnAmbientStack(two);
  const report = (await wiki.exportOkf({ out: path.join(two.root, "bundle-journal-ambient") })) as OkfExportReport;
  const log = await exportedLog(report.writtenPaths);

  expect(log).toContain(AMBIENT_JOURNAL);
  expect(log).not.toContain(BOUND_JOURNAL);
}, 60_000);

// The same header carries a DATE, and the two Stacks journalled on different days, so the
// heading names which Stack's journal the bundle was assembled from. Reverting
// `export/okf/bundle.ts:138` to `process.env` shipped `## 2024-03-01`, the ambient day,
// where this bundle's own day was expected.
it("dates log.md from the journal of the Stack the handle names", async () => {
  const wiki = await handleOnBoundStack(two);
  const report = (await wiki.exportOkf({ out: path.join(two.root, "bundle-journal-dated") })) as OkfExportReport;
  const log = await exportedLog(report.writtenPaths);

  expect(log).toContain(journalDay(BOUND_JOURNAL_AT));
  expect(log).not.toContain(journalDay(AMBIENT_JOURNAL_AT));
}, 60_000);
