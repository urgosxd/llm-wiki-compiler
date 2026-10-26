/**
 * @file test/dimensions/activity-log-rows.test.ts
 * @description The journal lands in rows for a Stack, and renders identically.
 *
 * The assertion that proves wiring is NOT "the row exists" — rows can be written
 * while the file is still written too. It is "`log.md` does not exist", which is why
 * every case below checks the directory as well as the row.
 *
 * The second property is format parity. The OKF export PARSES headings out of this
 * markdown, so "the rows round-trip" is not enough: the rendered text has to be what
 * the file backend would have produced from the same facts.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendLog, formatLogEntry, renderJournal } from "../../src/utils/activity-log.js";
import { withJournalSource } from "../../src/dimensions/wiki/activity-log-source.js";
import { createDimensionsDatabase } from "../../src/dimensions/activation.js";
import { readJournalEntries } from "../../src/dimensions/wiki/activity-log-store.js";
import { withStackEnv } from "../fixtures/stack-env.js";

/** Provision a project root plus a Stack, always tearing both down. */
async function withProject(label: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), `${label}-`));
  try {
    await withStackEnv(label, () => body(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Read one Stack's journal straight from the store, bypassing the seam. */
async function readDirect(stackId: string): Promise<Awaited<ReturnType<typeof readJournalEntries>>> {
  const handle = createDimensionsDatabase(process.env);
  try {
    return await readJournalEntries(handle.db, stackId);
  } finally {
    await handle.close();
  }
}

describe("activity log on rows", () => {
  it("appends to rows and writes no log.md", () =>
    withProject("log-nofile", async (dir) => {
      await appendLog(dir, "ingest", "First ingest", { details: ["- page [[concepts/a]]"] });

      expect(existsSync(path.join(dir, "log.md"))).toBe(false);
      expect(existsSync(path.join(dir, ".llmwiki"))).toBe(false);
      expect(await readdir(dir)).not.toContain("log.md");
    }));

  it("keeps entries in append order", () =>
    withProject("log-order", async (dir) => {
      await appendLog(dir, "ingest", "first");
      await appendLog(dir, "compile", "second");
      await appendLog(dir, "query", "third");

      const viaRows = await withJournalSource(process.env, async (source) =>
        (await source!.read()).map((e) => e.operation),
      );
      expect(viaRows).toEqual(["ingest", "compile", "query"]);
    }));

  it("sanitizes the description once, before storing", () =>
    withProject("log-sanitize", async (dir) => {
      await appendLog(dir, "ingest", "line one\n\nline   two");

      const [entry] = await withJournalSource(process.env, async (source) => source!.read());
      // Collapsed to a single line, so the heading stays greppable.
      expect(entry.description).toBe("line one line two");
    }));

  it("renders the same markdown the file backend would write", () =>
    withProject("log-render", async (dir) => {
      const at = new Date("2026-06-05T14:58:41.000Z");
      await appendLog(dir, "compile", "12 pages", { date: at, details: ["- 12 pages", "- 3 queries"] });

      const rendered = await withJournalSource(process.env, async (source) =>
        renderJournal(await source!.read()),
      );
      const expected = `${formatLogEntry("compile", "12 pages", at, ["- 12 pages", "- 3 queries"])}\n\n`;
      expect(rendered).toBe(expected);
    }));

  it("orders by seq, not by timestamp, when two entries share a second", () =>
    withProject("log-samesecond", async (dir) => {
      const at = new Date("2026-06-05T14:58:41.000Z");
      await appendLog(dir, "ingest", "first", { date: at });
      await appendLog(dir, "query", "second", { date: at });

      const order = await withJournalSource(process.env, async (source) =>
        (await source!.read()).map((e) => e.description),
      );
      expect(order).toEqual(["first", "second"]);
    }));

  it("keeps each Stack's journal separate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "log-tenant-"));
    try {
      // Each Stack is asserted INSIDE its own scope: the fixture restores
      // `process.env` on exit, so reading a previous Stack afterwards would
      // authenticate as nobody and report a connection error as a tenant leak.
      const first = await journalOf("log-tenant-first", dir, "only in first");
      const second = await journalOf("log-tenant-second", dir, "only in second");
      expect(first).toEqual(["only in first"]);
      expect(second).toEqual(["only in second"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Append `description` under a fresh Stack, returning what that Stack then reads. */
async function journalOf(label: string, dir: string, description: string): Promise<string[]> {
  let seen: string[] = [];
  await withStackEnv(label, async () => {
    await appendLog(dir, "ingest", description);
    seen = await withJournalSource(process.env, async (source) =>
      (await source!.read()).map((entry) => entry.description),
    );
  });
  return seen;
}
