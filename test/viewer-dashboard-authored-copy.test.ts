/**
 * The dashboard must not describe authored pages as compiled, and must not name
 * a surface that cannot be called.
 *
 * Rule 1 — vocabulary. A default project's pages are produced by the compiler,
 * so the mockup's "Recently compiled" title is accurate there and stays
 * verbatim. A profile's typed entity pages are AUTHORED by hand under the
 * directories the profile declares — the compiler never produces one — so the
 * same title would describe authored pages as compiled. `viewer-lists.js`
 * already draws this distinction for a typed list's empty state; these tests
 * pin the dashboard to the same line.
 *
 * Rule 2 — no unreachable surface. There is no CLI: no package.json declares
 * `bin`, and the only launcher (`dist/api.js`) is a server entry with no
 * subcommands, so a rendered `llmwiki <subcommand>` names nothing a reader can
 * run. Every slot that used to hold one holds either the registered MCP tool
 * that does the work (`compile_wiki`, `lint_wiki`, `export_okf`) or no surface
 * at all, and nothing in it reads as a line to paste.
 */

import { describe, expect, it } from "vitest";
import { flushMicrotasks, jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const ENTITY_TYPES = [
  { type: "articles", pageCount: 0 },
  { type: "desks", pageCount: 0 },
];

function envelope(withProfile: boolean): Record<string, unknown> {
  return {
    project: { title: "demo", rootName: "demo" },
    profileId: withProfile ? "newsroom" : "default",
    counts: { concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0 },
    pages: [],
    recentPages: [],
    index: { available: false },
    ...(withProfile ? { profilePipeline: { entityTypes: ENTITY_TYPES } } : {}),
  };
}

function responderFor(withProfile: boolean): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelope(withProfile));
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.endsWith("/api/graph")) return jsonResponse({ nodes: [], edges: [] });
    return null;
  };
}

/** The dashboard's recent panel, mounted for a default or profile project. */
async function recentPanel(withProfile: boolean): Promise<Element> {
  const { dom } = await mountViewerDom(responderFor(withProfile));
  await flushMicrotasks();
  const panels = [...dom.window.document.querySelectorAll("[data-main-pane] .panel")];
  return panels.find((p) => /Recently/.test(p.textContent ?? ""))!;
}

describe("a default project keeps the mockup's compile vocabulary", () => {
  it('titles the panel "Recently compiled"', async () => {
    expect((await recentPanel(false)).querySelector(".panel-title")?.textContent).toBe("Recently compiled");
  });

  it("names the registered compile_wiki tool in the empty state", async () => {
    const panel = await recentPanel(false);
    expect(panel.querySelector(".empty-state-title")?.textContent).toBe("Nothing compiled yet");
    const chip = panel.querySelector(".empty-state-command")?.textContent ?? "";
    expect(chip).toBe("compile_wiki");
    // A tool name, not a command line: no prompt sigil, no arguments to paste.
    expect(chip).not.toMatch(/[$`]/);
  });
});

describe("a profile project does not call authored pages compiled", () => {
  it('titles the panel "Recently updated"', async () => {
    expect((await recentPanel(true)).querySelector(".panel-title")?.textContent).toBe("Recently updated");
  });

  it("names no surface, because none produces an entity page", async () => {
    const panel = await recentPanel(true);
    expect(panel.querySelector(".empty-state-title")?.textContent).toBe("Nothing authored yet");
    expect(panel.querySelector(".empty-state-command")).toBeNull();
  });

  it("never says compiled anywhere in the panel", async () => {
    expect((await recentPanel(true)).textContent).not.toMatch(/compil/i);
  });
});

/** The rail's next-action hints and the closing snapshot note, as rendered. */
async function rail(): Promise<{ hints: string[]; snapshotNote: Element | null }> {
  const { dom } = await mountViewerDom(responderFor(false));
  await flushMicrotasks();
  const doc = dom.window.document;
  const hints = [...doc.querySelectorAll("[data-next-actions] .action-hint")].map(
    (node) => node.textContent ?? "",
  );
  return { hints, snapshotNote: doc.querySelector(".snapshot-note") };
}

describe("the rail names only callable surfaces", () => {
  it("gives every next action a registered MCP tool, never a CLI subcommand", async () => {
    const { hints } = await rail();
    // Lint has never run in this envelope (see `responderFor`), so the lint row
    // is present and the export row always applies. No stale page here, so no
    // recompile row.
    expect(hints).toEqual(["lint_wiki", "export_okf"]);
  });

  it("states that a restart is what re-reads the snapshot, naming no command", async () => {
    const { snapshotNote } = await rail();
    expect(snapshotNote?.textContent).toBe(
      "The viewer serves a frozen snapshot. Changes on disk appear after a restart.",
    );
    // The span that carried the removed `llmwiki view` command is gone with it.
    expect(snapshotNote?.querySelector(".snapshot-command")).toBeNull();
  });
});
