/**
 * @file CLI-level pin for `llmwiki links-here <slug>`.
 *
 * WHY A PIN AND NOT A FEATURE TEST. `links-here` shares its name-resolution
 * chain with `race` (`src/context/resolve-target.ts`), so a refactor of that
 * chain can change what this command prints without touching this command. The
 * contract to protect is the printed text and the exit code, so these cases
 * assert the exact stdout of a fixed fixture: an inbound list, the `(mutual)`
 * marker, an orphan, and — the one a "which real page is this?" refactor would
 * break — a dangling target, which this command deliberately resolves so it can
 * name the page that mentions a broken link.
 *
 * Every case builds its own throwaway wiki under `os.tmpdir()` and removes it,
 * so nothing here depends on the repository's own `wiki/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import linksHereCommand from "../../src/commands/links-here.js";
import { writePage } from "../fixtures/write-page.js";

/** Root of the throwaway wiki for the current case. */
let root = "";
/** Directory the process started in, restored after every case. */
let origin = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "links-here-cli-")));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  origin = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(origin);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write one concept page into the throwaway wiki. */
async function page(slug: string, title: string, body: string): Promise<void> {
  await writePage(path.join(root, "wiki/concepts"), slug, { title }, body);
}

/** Capture everything the command writes to stdout and stderr. */
function captureIo(): { out: () => string; err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  return { out: () => stdout.join(""), err: () => stderr.join("") };
}

describe("links-here — human output", () => {
  it("prints the inbound list in page-id order and exits 0", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("gamma", "Gamma", "See [[beta]] too.");
    await page("beta", "Beta", "Target.");
    const io = captureIo();
    const code = await linksHereCommand("beta", {});
    expect(code).toBe(0);
    expect(io.err()).toBe("");
    expect(io.out()).toBe(
      "2 page(s) link to concepts/beta:\n\n" +
        "  [[concepts/alpha]] Alpha\n  [[concepts/gamma]] Gamma\n\n" +
        "Follow any of these page ids with `llmwiki links-here` to keep walking.\n",
    );
  });

  it("marks a pair that links both ways as mutual", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("beta", "Beta", "See [[alpha]] back.");
    const io = captureIo();
    await linksHereCommand("beta", {});
    expect(io.out()).toContain("  [[concepts/alpha]] Alpha (mutual)\n");
  });

  it("reports an orphan as a normal answer, not an error", async () => {
    await page("leaf", "Leaf", "Nothing points here yet.");
    const io = captureIo();
    const code = await linksHereCommand("leaf", {});
    expect(code).toBe(0);
    expect(io.out()).toBe(
      "No pages link to concepts/leaf.\n" +
        "Nothing is broken: an inbound link appears once another page mentions this one.\n",
    );
  });

  it("resolves a dangling target so the page that mentions it is named", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const io = captureIo();
    const code = await linksHereCommand("nowhere", {});
    expect(code).toBe(0);
    expect(io.out()).toContain("1 page(s) link to concepts/nowhere:");
    expect(io.out()).toContain("  [[concepts/alpha]] Alpha\n");
  });

  it("says so when the requested name matches no page at all", async () => {
    await page("alpha", "Alpha", "No links here.");
    const io = captureIo();
    const code = await linksHereCommand("missing", {});
    expect(code).toBe(0);
    expect(io.out()).toBe('No page named "missing" exists in this wiki.\n');
  });
});
