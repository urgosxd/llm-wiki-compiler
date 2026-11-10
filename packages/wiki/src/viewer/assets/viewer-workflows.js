/**
 * llmwiki viewer — the #/workflows list route.
 *
 * A peer of #/reviews: same `.list-row` language, same empty-state contract,
 * and the same reason for living outside viewer-lists.js — the routes there all
 * render from the already-fetched /api/pages envelope, while workflow runs live
 * under `.llmwiki/workflows/runs/`, outside the frozen snapshot, so this route
 * is fed by a per-visit /api/workflow-runs fetch.
 *
 * The route exists for the PARKED runs. A run waiting on a gate approval or a
 * stage-output submission is a work item blocked on a human; a run that is
 * merely running or completed needs nothing. So a parked row is marked as such
 * on the row itself and says which of the two waits it is in — and nothing more.
 *
 * It names no surface that could move the run, because none exists to name:
 * there is no CLI (no package.json in this repository declares a `bin`, and the
 * only launcher, `dist/api.js`, has no subcommands), and no registered MCP tool
 * approves a gate or submits a stage output. Every row here used to print a
 * pasteable `workflow …` command line; those lines were deleted rather than
 * reworded, because a command nobody can run is the same lie as a dead button.
 * What is left is the state a reader can act on elsewhere: the run id, the gate
 * id, and which wait it is in.
 *
 * A `problem` row (an unavailable or malformed run store) renders AS a problem.
 * The endpoint deliberately reports a broken store as a fail-visible row rather
 * than an empty list — dropping it here, or dressing it as a normal run, would
 * undo that and let a broken store read as "no runs".
 */

import { el, emptyState, heading } from "./viewer-dom.js";

/**
 * Human wording for the classifications worth stating (see
 * `src/workflows/status.ts`). `current` is deliberately absent: it is the
 * unremarkable default relationship to the active profile, and a chip on every
 * healthy row would bury the two that mean the run cannot be acted on. An
 * unknown classification falls through to its raw value, so one added later is
 * visible-but-ugly rather than silently invisible.
 */
const CLASSIFICATION_LABELS = {
  historical: "History",
  "needs-adaptation": "Project setup has changed",
  "blocked-by-config": "Project configuration needs attention",
};

/** Shown in place of the stage id when a run sits on no stage (e.g. a finished run). */
const NO_STAGE = "no active step";

/**
 * What a `trust:` gate actually needs, said as a fact rather than as a command.
 *
 * A trust gate is NOT a human approval: the Trust Guard clears it on a
 * successful write under the profile's trusted-write grant (see
 * `src/trust/trusted-write.ts`), never by approving a step. Nothing in this
 * build clears it — no CLI subcommand, no registered MCP tool — so the note
 * states what the run waits on instead of naming a line to paste.
 */
const TRUST_GATE_NOTE =
  "This run waits on the profile's trusted-write grant. A review approval does not grant it; " +
  "the operator grants it out of workspace through LLMWIKI_TRUSTED_WRITE, and this read-only " +
  "viewer cannot.";

/**
 * Render the workflow-runs route from an `/api/workflow-runs` payload.
 *
 * @param {HTMLElement} main - The main pane to render into.
 * @param {{runs?: unknown[], workflowJourneys?: boolean}} payload - The `/api/workflow-runs` envelope.
 */
export function renderWorkflowRunsList(main, payload) {
  const runs = runsIn(payload);
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Workflows"));
  const body = el("div", "list-body");
  main.appendChild(body);
  if (runs.length === 0) {
    body.appendChild(emptyWorkflowsState());
    return;
  }
  for (const run of runs) body.appendChild(buildRunRow(run, payload?.workflowJourneys === true));
}

/** The rows in an `/api/workflow-runs` envelope, defended against a malformed payload. */
function runsIn(payload) {
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

/**
 * Empty state for a project with no runs. Most projects have none — workflows
 * are a Configurable Lifecycle Profile feature and the default profile declares
 * none — so this is a normal, common state, not a failure, and it gets the
 * teaching card rather than the italic loading placeholder.
 *
 * The slot that used to print the `workflow list` command line names the
 * directory runs are read from instead: that subcommand does not exist, no
 * registered MCP tool lists workflows, and the path is a fact the reader can
 * check on disk.
 */
function emptyWorkflowsState() {
  return emptyState(
    "No workflow runs",
    "Workflows organize a task into steps. No runs are recorded here yet, and this viewer cannot show which workflows this project supports: it only reports the runs that exist. A run can wait for approval or for results to be submitted.",
    ".llmwiki/workflows/runs/",
  );
}

/** True when the row describes an unavailable or malformed run store, not a run. */
function isProblemRow(run) {
  return typeof run?.problem === "string" && run.problem.length > 0;
}

/** True when the run is blocked on a human — a gate approval or a stage output. */
function isParked(run) {
  return typeof run?.awaitingGate === "string" || run?.awaitingOutput === true;
}

/** Build one row, dispatching on whether it reports a run or a broken store. */
function buildRunRow(run, journeys) {
  if (isProblemRow(run)) return buildProblemRow(run);
  const row = el("div", `list-row workflow-row${isParked(run) ? " is-parked" : ""}`);
  row.appendChild(buildRunHead(run, journeys));
  row.appendChild(el("p", "workflow-meta", runMetaText(run)));
  const flags = buildRunFlags(run);
  if (flags) row.appendChild(flags);
  appendNextCommands(row, run);
  return row;
}

/**
 * Head line: the workflow the run belongs to, plus the run id. The workflow is
 * the title because it is what the reader recognises; the id identifies the run
 * the park notes below name, so it sits beside the title in mono rather than
 * being hidden.
 */
function buildRunHead(run, journeys) {
  const head = el("div", "workflow-head");
  const linked = hasJourneyLink(run, journeys);
  const title = el(linked ? "a" : "span", "list-title", workflowNameOf(run));
  if (linked) {
    title.href = "#/workflows/" + encodeURIComponent(run.workflow) + "/runs/" + encodeURIComponent(run.runId);
  }
  head.appendChild(title);
  head.appendChild(el("span", "workflow-run-id", String(run.runId ?? "")));
  return head;
}

/** A journey link needs opt-in and both route identities. */
function hasJourneyLink(run, journeys) {
  return journeys && typeof run.workflow === "string" && typeof run.runId === "string";
}

/**
 * The workflow id, or a plain statement when the row carries none. A readable
 * run always names its workflow; a row without one is malformed, and an empty
 * title line would read as a rendering bug rather than as missing data.
 */
function workflowNameOf(run) {
  const workflow = typeof run.workflow === "string" ? run.workflow.trim() : "";
  return workflow.length > 0 ? workflow : "Unknown workflow";
}

/** Meta line: lifecycle status and the stage the run currently sits on. */
function runMetaText(run) {
  const status = typeof run.status === "string" && run.status.length > 0 ? run.status : "unknown";
  return `${status} · ${stageTextOf(run)}`;
}

/** The current stage id, or the no-stage wording when the run sits on none. */
function stageTextOf(run) {
  const stage = typeof run.currentStage === "string" ? run.currentStage.trim() : "";
  return stage.length > 0 ? stage : NO_STAGE;
}

/**
 * Build the chip row. Returns null when there is nothing to say, so an
 * ordinary running row does not carry an empty strip.
 */
function buildRunFlags(run) {
  const labels = flagLabels(run);
  if (labels.length === 0) return null;
  const wrap = el("div", "workflow-flags");
  for (const { text, parked } of labels) wrap.appendChild(buildFlag(text, parked));
  return wrap;
}

/**
 * The chips a run earns, in reading order: what it is parked on, then how it
 * relates to the active profile when that is worth stating.
 */
function flagLabels(run) {
  const parked = parkLabels(run).map((text) => ({ text, parked: true }));
  const classification = CLASSIFICATION_LABELS[run.classification];
  return classification ? [...parked, { text: classification, parked: false }] : parked;
}

/** One chip. A parked chip takes the warn treatment; anything else is neutral. */
function buildFlag(text, parked) {
  return el("span", `workflow-flag${parked ? " is-parked" : ""}`, text);
}

/**
 * The parked states, in the order they must be cleared: a stage output is
 * submitted before the gate guarding that stage can be approved, so a run
 * carrying both reads top-to-bottom as the sequence of work it needs.
 *
 * A `trust:` gate is named as one. It parks the run exactly like a human/agent
 * gate but is cleared by a different act entirely, and a chip that called both
 * "Awaiting gate" would leave the reader with the wrong idea of what is missing.
 */
function parkLabels(run) {
  const labels = [];
  if (run.awaitingOutput === true) labels.push("Waiting for results");
  if (typeof run.awaitingGate === "string") labels.push(gateLabel(run));
  return labels;
}

/** The chip text for a gate park, distinguishing a trust gate from an approvable one. */
function gateLabel(run) {
  const kind = run.awaitingTrustGate === true ? "Write permission required" : "Waiting for approval";
  return `${kind} · ${run.awaitingGate}`;
}

/**
 * Append the park guidance: the trust-gate note when one applies, then one plain
 * statement per wait the run is in. Text only, never a control, and never a
 * command line: this viewer cannot move a run, and no registered MCP tool can
 * either.
 */
function appendNextCommands(row, run) {
  if (run.awaitingTrustGate === true) row.appendChild(el("p", "workflow-note", TRUST_GATE_NOTE));
  for (const note of parkNotes(run)) {
    row.appendChild(el("p", "workflow-next", note));
  }
}

/** The run id, or an empty string when the row carries none. */
function runIdOf(run) {
  return String(run.runId ?? "");
}

/** True when the run waits on a stage output. */
function waitsOnOutput(run) {
  return run.awaitingOutput === true;
}

/**
 * True when the run waits on a gate a human or agent could approve. A `trust:`
 * gate parks the run too, but no approval clears it (see {@link TRUST_GATE_NOTE}),
 * so it earns no note of its own.
 */
function waitsOnGate(run) {
  return typeof run.awaitingGate === "string" && run.awaitingTrustGate !== true;
}

/** The note for a stage-output wait: the wait named, and that nothing here clears it. */
function outputNote(run) {
  return `Run ${runIdOf(run)} is waiting for its stage output to be submitted. No surface in this build submits one.`;
}

/** The note for an approvable gate wait, naming the gate and that nothing here clears it. */
function gateNote(run) {
  return `Run ${runIdOf(run)} is waiting for gate "${run.awaitingGate}" to be approved. No surface in this build approves a gate.`;
}

/**
 * The waits a parked run can be in, in the order they must be cleared: a stage
 * output is submitted before the gate guarding that stage can be approved. Pairing
 * each predicate with its note keeps that ordering in one place and keeps
 * {@link parkNotes} free of the branching.
 */
const PARK_NOTES = [
  { applies: waitsOnOutput, note: outputNote },
  { applies: waitsOnGate, note: gateNote },
];

/**
 * One statement per wait the run is in, in the same order as {@link parkLabels}:
 * a stage output before the gate guarding that stage. Each names the id it waits
 * on and says plainly that this build has nothing that clears it — the honest
 * form of the command line it replaced, which pointed at a deleted subcommand.
 */
function parkNotes(run) {
  return PARK_NOTES.filter((wait) => wait.applies(run)).map((wait) => wait.note(run));
}

/**
 * Build a problem row: the run (or store) the trouble is attributed to, and why
 * it could not be read. No status, stage, or unpark command — the row describes
 * something unreadable, and inventing lifecycle fields for it would present a
 * broken store as a working run.
 */
function buildProblemRow(run) {
  const row = el("div", "list-row workflow-row is-problem");
  const head = el("div", "workflow-head");
  head.appendChild(el("span", "list-title", String(run.runId ?? "Unknown run")));
  head.appendChild(el("span", "workflow-flag is-problem", "Problem"));
  row.appendChild(head);
  row.appendChild(el("p", "workflow-problem", run.problem));
  return row;
}
