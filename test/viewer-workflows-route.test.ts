/**
 * `#/workflows` list-route contract.
 *
 * `/api/workflow-runs` shipped with no client at all: a run parked waiting for a
 * human to approve a gate or submit a stage output was a work item the UI never
 * showed. These tests pin the reason the route exists — a PARKED run must be
 * distinguishable in the DOM from one merely running or completed, because
 * parked is the only state a reader can act on.
 *
 * The route is a peer of `#/reviews`: same `.list-row` language, same per-visit
 * fetch (runs live under `.llmwiki/workflows/runs/`, outside the frozen
 * snapshot), same empty-state contract. Two contracts are specific to this
 * surface: a `problem` row must render AS a problem — the endpoint deliberately
 * reports a broken run store as a fail-visible row rather than an empty list,
 * and rendering it as a normal run (or dropping it) would undo that — and the
 * renderer must project only the documented status fields, never echoing a
 * field the server did not promise (see the absolute-path regression at
 * `c5c9e5e`).
 */

import { describe, expect, it } from "vitest";
import {
  profileBootstrapResponse,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

/** A run parked on an agent gate: it waits for gate `edited` to be approved. */
const PARKED_ON_GATE = {
  runId: "run-0001",
  classification: "current",
  status: "running",
  currentStage: "file-under-desk",
  workflow: "story-pipeline",
  awaitingGate: "edited",
};

/**
 * A run parked needing a stage output. The two `nextSubmit*` hints ride along
 * exactly as the classifier sets them — and the renderer deliberately ignores
 * them: no command is printed for a park, so the declared kind cannot change
 * the copy. They are kept here so that stays true rather than untested.
 */
const PARKED_ON_OUTPUT = {
  runId: "run-0002",
  classification: "current",
  status: "running",
  currentStage: "draft-article",
  workflow: "story-pipeline",
  awaitingOutput: true,
  nextSubmitEntityType: "articles",
};

/** A run parked on an artifact-only stage: its stage declares no entity write. */
const PARKED_ON_ARTIFACT = {
  runId: "run-0004",
  classification: "current",
  status: "running",
  currentStage: "produce-result",
  workflow: "story-pipeline",
  awaitingOutput: true,
  nextSubmitArtifactType: "result",
};

/**
 * A run parked on a `trust:` gate. It looks like a gate park and is NOT one:
 * it is cleared only by the profile's trusted-write grant on a successful
 * write, never by approving a step.
 */
const PARKED_ON_TRUST_GATE = {
  runId: "run-0005",
  classification: "current",
  status: "running",
  currentStage: "publish-article",
  workflow: "story-pipeline",
  awaitingGate: "trusted-write",
  awaitingTrustGate: true,
  awaitingOutput: true,
  nextSubmitEntityType: "articles",
};

/** A finished run — nothing to act on, and the control case for "parked". */
const COMPLETED = {
  runId: "run-0003",
  classification: "historical",
  status: "completed",
  currentStage: null,
  workflow: "story-pipeline",
};

/** The fail-visible row the endpoint emits for an unreadable run store. */
const PROBLEM_ROW = {
  runId: "(store)",
  classification: "blocked-by-config",
  problem: "run store unavailable: escape",
};

const RUNS = [PARKED_ON_GATE, PARKED_ON_OUTPUT, COMPLETED];

/** Responder serving the given `/api/workflow-runs` rows over an empty project. */
function responderWithRuns(runs: unknown[], workflowJourneys = false): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/workflow-runs")) return jsonResponse({ runs, workflowJourneys });
    return profileBootstrapResponse(url);
  };
}

/** Mount at `#/workflows` with the given rows and return the main pane. */
async function mountWorkflows(runs: unknown[], workflowJourneys = false): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(responderWithRuns(runs, workflowJourneys), "#/workflows");
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

/** The row whose head names `runId`, or undefined when no row does. */
function rowFor(main: HTMLElement, runId: string): HTMLElement | undefined {
  return Array.from(main.querySelectorAll<HTMLElement>(".list-row")).find((row) =>
    row.textContent?.includes(runId),
  );
}

describe("#/workflows", () => {
  it("renders one row per run", async () => {
    const main = await mountWorkflows(RUNS);
    expect(main.querySelectorAll(".list-row")).toHaveLength(3);
    expect(main.querySelector("h1")?.textContent).toBe("Workflows");
  });

  it("names each run's workflow, status, and current stage", async () => {
    const main = await mountWorkflows(RUNS);
    const row = rowFor(main, "run-0001");
    expect(row?.querySelector(".list-title")?.textContent).toBe("story-pipeline");
    expect(row?.textContent).toContain("running");
    expect(row?.textContent).toContain("file-under-desk");
  });

  it("states a historical run's classification, which is not the unremarkable one", async () => {
    const main = await mountWorkflows(RUNS);
    expect(rowFor(main, "run-0003")?.textContent).toContain("History");
    // `current` is the default relationship to the profile, so it earns no chip.
    expect(rowFor(main, "run-0001")?.textContent).not.toContain("Current");
  });
});

describe("#/workflows — parked runs are the reason the route exists", () => {
  it("marks a gate-parked run's row, and names the gate it waits on", async () => {
    const main = await mountWorkflows(RUNS);
    const row = rowFor(main, "run-0001");
    expect(row?.className).toContain("is-parked");
    expect(row?.querySelector(".workflow-flag.is-parked")?.textContent).toContain("edited");
  });

  it("marks an output-parked run's row distinctly from a gate-parked one", async () => {
    const main = await mountWorkflows(RUNS);
    const row = rowFor(main, "run-0002");
    expect(row?.className).toContain("is-parked");
    const flags = Array.from(row?.querySelectorAll(".workflow-flag.is-parked") ?? []);
    expect(flags.map((f) => f.textContent)).toEqual(["Waiting for results"]);
  });

  it("does not mark a merely running or completed run as parked", async () => {
    const main = await mountWorkflows([COMPLETED]);
    const row = rowFor(main, "run-0003");
    expect(row?.className).not.toContain("is-parked");
    expect(row?.querySelector(".workflow-flag.is-parked")).toBeNull();
  });

  it("counts only the parked rows as parked", async () => {
    const main = await mountWorkflows(RUNS);
    expect(main.querySelectorAll(".list-row.is-parked")).toHaveLength(2);
  });
});

describe("#/workflows — what a parked run says", () => {
  // The viewer is a read-only snapshot with no write path, and there is no
  // surface anywhere else either: no package.json in this repository declares a
  // `bin`, and no registered MCP tool approves a gate or submits a stage output.
  // So a row STATES the wait, names the run and gate ids, and says plainly that
  // nothing in this build clears it. It never prints a command line — the old
  // pasteable `workflow …` lines named a deleted CLI — and every assertion here
  // pins both the statement and the absence of an executable shape.
  it("states the gate wait with its run and gate id, and reads as no command", async () => {
    const main = await mountWorkflows(RUNS);
    const next = rowFor(main, "run-0001")?.querySelector(".workflow-next");
    expect(next?.textContent).toBe(
      'Run run-0001 is waiting for gate "edited" to be approved. No surface in this build approves a gate.',
    );
    // The property that matters: no prompt sigil, no argv-shaped flags, nothing
    // a reader could mistake for a line to paste.
    expect(next?.textContent ?? "").not.toMatch(/[$`]|--\w/);
  });

  // The declared write kind used to select which `workflow submit` line was
  // printed. No line is printed for either kind now, so both parks must read
  // identically — that is the surviving property, and the `nextSubmit*` hints
  // staying inert is what this pins.
  it("states the stage-output wait, with no submit command and no argv", async () => {
    const main = await mountWorkflows(RUNS);
    const next = rowFor(main, "run-0002")?.querySelector(".workflow-next");
    expect(next?.textContent).toBe(
      "Run run-0002 is waiting for its stage output to be submitted. No surface in this build submits one.",
    );
    expect(next?.textContent ?? "").not.toMatch(/[$`]|--\w/);
  });

  it("states the same wait for a stage declaring only an artifact write", async () => {
    const main = await mountWorkflows([PARKED_ON_ARTIFACT]);
    const next = rowFor(main, "run-0004")?.querySelector(".workflow-next");
    expect(next?.textContent).toBe(
      "Run run-0004 is waiting for its stage output to be submitted. No surface in this build submits one.",
    );
    expect(next?.textContent ?? "").not.toMatch(/[$`]|--\w/);
  });
});

describe("#/workflows — a parked row offers nothing a reader could run", () => {
  it("offers read-only detail links but no mutating buttons or forms", async () => {
    const main = await mountWorkflows(RUNS, true);
    expect(main.querySelector(".list-row button")).toBeNull();
    const links = Array.from(main.querySelectorAll(".list-row a"));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every(link => /^#\/workflows\/[^/]+\/runs\/[^/]+$/.test(link.getAttribute("href") ?? ""))).toBe(true);
    expect(main.querySelector(".list-row form")).toBeNull();
  });

  it("preserves plain workflow titles without opted-in journey navigation", async () => {
    const main = await mountWorkflows(RUNS);
    expect(main.querySelector(".list-row a")).toBeNull();
    expect(main.querySelector("span.list-title")?.textContent).toBe("story-pipeline");
  });

  it("names no command for a run that is not parked", async () => {
    const main = await mountWorkflows([COMPLETED]);
    expect(rowFor(main, "run-0003")?.querySelector(".workflow-next")).toBeNull();
  });
});

describe("#/workflows — a trust gate is not an approvable gate", () => {
  // A `trust:` gate is cleared by the profile's trusted-write grant on a
  // successful write, never by approving a step. The row must name the grant as
  // the missing piece — it is a real, out-of-workspace mechanism
  // (`src/trust/trusted-write.ts`) — and must not suggest an approval that
  // cannot work.
  it("offers no `gate approve` command line for a trust-gated run", async () => {
    const main = await mountWorkflows([PARKED_ON_TRUST_GATE]);
    const commands = Array.from(
      rowFor(main, "run-0005")?.querySelectorAll(".workflow-next") ?? [],
    ).map((p) => p.textContent ?? "");
    expect(commands.some((c) => c.includes("gate approve"))).toBe(false);
  });

  it("names the trusted-write grant, and promises no submit line", async () => {
    const main = await mountWorkflows([PARKED_ON_TRUST_GATE]);
    const row = rowFor(main, "run-0005");
    expect(row?.querySelector(".workflow-note")?.textContent).toContain("LLMWIKI_TRUSTED_WRITE");
    // Deleting the command left a true statement behind, not silence: the wait
    // is stated, and the slot still carries nothing pasteable.
    const next = row?.querySelector(".workflow-next")?.textContent ?? "";
    expect(next).toBe(
      "Run run-0005 is waiting for its stage output to be submitted. No surface in this build submits one.",
    );
    expect(next).not.toMatch(/[$`]|--\w/);
  });

  it("labels the park a trust gate, not the approvable kind", async () => {
    const main = await mountWorkflows([PARKED_ON_TRUST_GATE]);
    const flags = Array.from(
      rowFor(main, "run-0005")?.querySelectorAll(".workflow-flag.is-parked") ?? [],
    ).map((f) => f.textContent);
    expect(flags).toContain("Write permission required · trusted-write");
    expect(flags).not.toContain("Waiting for approval · trusted-write");
  });

  it("still states the wait for an ordinary gate park, with no approve line", async () => {
    const main = await mountWorkflows([PARKED_ON_GATE]);
    const row = rowFor(main, "run-0001");
    expect(row?.querySelector(".workflow-note")).toBeNull();
    expect(row?.querySelector(".workflow-next")?.textContent).toBe(
      'Run run-0001 is waiting for gate "edited" to be approved. No surface in this build approves a gate.',
    );
  });
});

describe("#/workflows — a problem row", () => {
  // The endpoint reports an unavailable/malformed run store as a fail-visible
  // `problem` row rather than an empty list. Rendering it as a normal run, or
  // filtering it out, would turn a broken store back into "no runs".
  it("renders the problem row rather than dropping it", async () => {
    const main = await mountWorkflows([PROBLEM_ROW]);
    expect(main.querySelectorAll(".list-row")).toHaveLength(1);
    expect(main.querySelector(".empty-state")).toBeNull();
  });

  it("marks it as a problem and shows the reason the store is unreadable", async () => {
    const main = await mountWorkflows([PROBLEM_ROW]);
    const row = main.querySelector(".list-row");
    expect(row?.className).toContain("is-problem");
    expect(row?.querySelector(".workflow-problem")?.textContent).toBe(
      "run store unavailable: escape",
    );
  });

  it("does not dress a problem row as a run with a status and a stage", async () => {
    const main = await mountWorkflows([PROBLEM_ROW]);
    const row = main.querySelector(".list-row");
    expect(row?.className).not.toContain("is-parked");
    expect(row?.querySelector(".workflow-meta")).toBeNull();
    expect(row?.querySelector(".workflow-next")).toBeNull();
  });

  it("keeps a problem row visible alongside healthy runs", async () => {
    const main = await mountWorkflows([...RUNS, PROBLEM_ROW]);
    expect(main.querySelectorAll(".list-row")).toHaveLength(4);
    expect(main.querySelectorAll(".list-row.is-problem")).toHaveLength(1);
  });
});

describe("#/workflows — no runs", () => {
  it("renders the design system's empty state naming the run directory, not a command", async () => {
    const main = await mountWorkflows([]);
    const state = main.querySelector(".empty-state");
    expect(state?.querySelector(".empty-state-title")?.textContent).toBe("No workflow runs");
    const chip = state?.querySelector(".empty-state-command")?.textContent ?? "";
    // A real path runs are read from, checked against the renderer's own
    // constant rather than a paraphrase of it.
    expect(chip).toBe(".llmwiki/workflows/runs/");
    expect(chip).not.toMatch(/[$`]|--\w/);
  });

  it("explains that workflows come from a profile, since most projects have none", async () => {
    const main = await mountWorkflows([]);
    expect(main.querySelector(".empty-state-body")?.textContent).toContain("this project supports");
  });

  it("is neither the italic loading placeholder nor a blank pane", async () => {
    const main = await mountWorkflows([]);
    expect(main.querySelector(".placeholder")).toBeNull();
    expect(main.querySelector("h1")?.textContent).toBe("Workflows");
    expect(main.querySelectorAll(".list-row")).toHaveLength(0);
  });

  it("survives a payload with no `runs` array at all", async () => {
    const main = await mountWorkflows(undefined as unknown as unknown[]);
    expect(main.querySelector(".empty-state")).toBeTruthy();
  });
});

describe("#/workflows — only the documented status fields reach the DOM", () => {
  // An absolute filesystem path leaked through `/api/health` earlier on this
  // branch (`c5c9e5e`), and `/api/reviews` had to reduce `sources` to basenames
  // for the same reason. `WorkflowRunRow` carries no path today; this pins that
  // the RENDERER projects named fields, so a field added to the row later
  // cannot reach a screenshot just by existing.
  const LEAKY_ROW = {
    ...PARKED_ON_GATE,
    runFile: "/Users/someone/projects/wiki/.llmwiki/workflows/runs/run-0001.json",
    root: "/Users/someone/projects/wiki",
  };

  it("does not echo an undocumented field the server never promised", async () => {
    const main = await mountWorkflows([LEAKY_ROW]);
    expect(main.textContent).not.toContain("/Users/someone");
    expect(main.textContent).not.toContain(".llmwiki/workflows/runs");
  });

  it("still renders the documented fields of that same row", async () => {
    const main = await mountWorkflows([LEAKY_ROW]);
    expect(main.querySelector(".list-title")?.textContent).toBe("story-pipeline");
    expect(main.querySelector(".list-row")?.className).toContain("is-parked");
  });
});

/** Mount on the home route, click the sidebar's Workflows entry, and settle. */
async function clickSidebarWorkflows(): Promise<Window> {
  const mounted = await mountViewerDom(responderWithRuns(RUNS));
  const win = mounted.dom.window as unknown as Window;
  (win.document.querySelector('a[data-route="workflows"]') as HTMLElement).click();
  await mounted.flush();
  return win;
}

describe("sidebar Workflows entry", () => {
  it("sits in MAINTAIN and points at #/workflows", async () => {
    const { dom } = await mountViewerDom(responderWithRuns([]));
    const link = dom.window.document.querySelector('a[data-route="workflows"]');
    expect(link?.getAttribute("href")).toBe("#/workflows");
    expect(link?.closest(".nav-section")?.textContent).toContain("MAINTAIN");
  });

  it("lands on #/workflows and highlights itself, not Reviews", async () => {
    const { document: doc, location } = await clickSidebarWorkflows();
    expect(location.hash).toBe("#/workflows");
    expect(doc.querySelector('a[data-route="workflows"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(doc.querySelector('a[data-route="reviews"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("renders the runs once navigated there", async () => {
    const { document: doc } = await clickSidebarWorkflows();
    expect(doc.querySelectorAll("[data-main-pane] .list-row")).toHaveLength(3);
  });
});
