/**
 * Regression test for the SDK ingest activity-journal contract.
 *
 * The #85 activity journal lives inside `ingestSource`, which the SDK's
 * `wiki.ingest()` calls. After the root-explicit ingest change, the journal
 * must be written under the bound project `root` (not `process.cwd()`) and
 * record a root-relative `Saved:` path. The CLI activity-log test cannot catch
 * a root-vs-cwd regression because there cwd === root; this test drives the SDK
 * with cwd deliberately set ELSEWHERE so the distinction is exercised.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";
import { LOG_FILE } from "../../src/utils/constants.js";
import { withJournalSource } from "../../src/dimensions/wiki/activity-log-source.js";
import { useStackEnv } from "../fixtures/stack-env.js";

describe("SDK ingest journaling is root-bound", () => {
  // Every dimension is Postgres-backed, so a Stack is required before any ingest.
  useStackEnv("ingest-journal");
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it("wiki.ingest writes log.md under root (not cwd) with a relative Saved path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-jrnl-root-"));
    const foreignCwd = await mkdtemp(path.join(tmpdir(), "wiki-jrnl-cwd-"));
    const srcFile = path.join(root, "note.md");
    // >= MIN_SOURCE_CHARS (50) so ingest doesn't reject the content.
    await writeFile(srcFile, "Source body content for the SDK journaling regression test.", "utf-8");

    process.chdir(foreignCwd); // cwd != root — the case the CLI test can't cover
    await createWiki({ root }).ingest({ source: srcFile });

    // Journal lands under ROOT, never under the foreign cwd.
    //
    // On a Stack the journal is a ROW, so "the file exists" would be false for the
    // right reason and prove nothing. The invariant under test is positional -- the
    // entry belongs to the ROOT's journal, not to the process cwd -- so it is read
    // through the seam that resolves the ACTIVE backend, and the cwd claim is
    // checked against the filesystem the entry would have landed in if the bug
    // returned.
    //
    // Two backends answer this differently, so the assertion is split by SHAPE
    // rather than by backend: the file render carries `- Saved: <path>`, the row
    // carries the fields the renderer derives it from. Both must show a
    // ROOT-RELATIVE `sources/` path and never an absolute one.
    const saved = await withJournalSource(process.env, async (source) => {
      if (source === undefined) {
        const body = await readFile(path.join(root, LOG_FILE), "utf-8");
        return body.match(/- Saved: (\S+)/)?.[1];
      }
      const entries = await source.read();
      const line = entries.flatMap((entry) => entry.details ?? []).join("\n");
      return line.match(/Saved: (\S+)/)?.[1];
    });
    expect(existsSync(path.join(foreignCwd, LOG_FILE))).toBe(false);
    expect(saved).toMatch(/^sources\//); // root-relative, never absolute

    await rm(root, { recursive: true, force: true });
    await rm(foreignCwd, { recursive: true, force: true });
  });

  it("wiki.ingestText also journals the ingest under root with a relative Saved path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-jrnl-text-"));
    await createWiki({ root }).ingestText({
      title: "My Note",
      text: "Enough inline body content to satisfy the minimum source length requirement.",
    });

    // Same split as above: the row backend stores the fields the file render derives
    // these lines from, so both are asserted through the shared seam.
    const entry = await withJournalSource(process.env, async (source) => {
      if (source === undefined) {
        const body = await readFile(path.join(root, LOG_FILE), "utf-8");
        return { operation: /ingest \| (My Note)/.exec(body)?.[1], saved: /- Saved: (\S+)/.exec(body)?.[1] };
      }
      const rows = await source.read();
      return {
        operation: rows[0]?.description,
        saved: (rows[0]?.details ?? []).map((d) => /Saved: (\S+)/.exec(d)?.[1]).find(Boolean),
      };
    });
    expect(entry.operation).toBe("My Note");
    expect(entry.saved).toMatch(/^sources\//);

    await rm(root, { recursive: true, force: true });
  });
});
