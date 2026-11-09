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
 * Every case runs against its own throwaway wiki from `test/fixtures/temp-root.ts`,
 * so nothing here depends on the repository's own `wiki/`, and captures command
 * output through `test/fixtures/process-io.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import linksHereCommand from "../../packages/wiki/src/commands/links-here.js";
import { useConceptPage } from "../fixtures/concept-page.js";
import { captureProcessIo } from "../fixtures/process-io.js";

/** Throwaway wiki for the current case, plus its concept-page writer. */
const { ctx, page } = useConceptPage();

describe("links-here — human output", () => {
  it("prints the inbound list in page-id order and exits 0", async () => {
    await page("alpha", "Alpha", "See [[beta]] for more.");
    await page("gamma", "Gamma", "See [[beta]] too.");
    await page("beta", "Beta", "Target.");
    const io = captureProcessIo();
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
    const io = captureProcessIo();
    await linksHereCommand("beta", {});
    expect(io.out()).toContain("  [[concepts/alpha]] Alpha (mutual)\n");
  });

  it("reports an orphan as a normal answer, not an error", async () => {
    await page("leaf", "Leaf", "Nothing points here yet.");
    const io = captureProcessIo();
    const code = await linksHereCommand("leaf", {});
    expect(code).toBe(0);
    expect(io.out()).toBe(
      "No pages link to concepts/leaf.\n" +
        "Nothing is broken: an inbound link appears once another page mentions this one.\n",
    );
  });

  it("resolves a dangling target so the page that mentions it is named", async () => {
    await page("alpha", "Alpha", "See [[nowhere]] for more.");
    const io = captureProcessIo();
    const code = await linksHereCommand("nowhere", {});
    expect(code).toBe(0);
    expect(io.out()).toContain("1 page(s) link to concepts/nowhere:");
    expect(io.out()).toContain("  [[concepts/alpha]] Alpha\n");
  });

  it("says so when the requested name matches no page at all", async () => {
    await page("alpha", "Alpha", "No links here.");
    const io = captureProcessIo();
    const code = await linksHereCommand("missing", {});
    expect(code).toBe(0);
    expect(io.out()).toBe('No page named "missing" exists in this wiki.\n');
  });
});
