/**
 * Pure recommendation rules for the project state a caller has already collected.
 *
 * Classifies a {@link ProjectState} snapshot into exactly one of seven
 * primary states and produces a primary {@link RecommendedAction} plus
 * the per-state `otherActions` table.
 *
 * ## A recommendation names a CALLABLE target, never a command line
 *
 * No package in this repository declares a `bin`, so `llmwiki <subcommand>` resolves
 * to nothing: the old `executable.binary` field told any agent that obeyed it to run a
 * program that does not exist. Every action now carries an {@link ExecutableSpec} — a
 * registered MCP tool name plus the input fields that tool requires, valued as
 * `<placeholder>` tokens for the caller to fill. `command` is only the label shown to
 * a human, and it is the tool name itself so the two can never disagree.
 */

import type { WikiMcpToolName } from "../mcp/tool-names.js";
import type { ProjectState } from "./state.js";

/** Primary state enum surfaced as `state` in the JSON envelope. */
export type ProjectStateKind =
  | "fresh"
  | "sources-only"
  | "review-pending"
  | "lint-attention"
  | "wiki-ready"
  | "empty-wiki"
  | "broken-project";

/** Single recommended action; `command` labels it for display, `executable` is the call. */
export interface RecommendedAction {
  command: string | null;
  reason: string;
  executable: ExecutableSpec | null;
}

/**
 * A real call an agent can make: one registered MCP tool and the input it needs.
 *
 * Values are `<placeholder>` tokens, not literals — the caller supplies the source
 * path, the question or the Stack id. Only fields the tool's own `inputSchema` admits
 * may appear: the `tool` half is fixed by {@link WikiMcpToolName}, and the `input` half
 * is checked against the live `tools/list` by
 * `test/mcp/advertised-tools-are-registered.test.ts`.
 */
export interface ExecutableSpec {
  tool: WikiMcpToolName;
  input: Record<string, string>;
}

/** Full recommendation envelope returned to the renderer. */
export interface Recommendation {
  state: ProjectStateKind;
  recommended: RecommendedAction;
  otherActions: RecommendedAction[];
}

/**
 * Classify a ProjectState and produce its primary + secondary actions.
 * Precedence (top wins): broken-project, fresh, sources-only,
 * review-pending, lint-attention, wiki-ready, empty-wiki.
 */
export function recommendNextAction(state: ProjectState): Recommendation {
  const kind = classifyState(state);
  return { state: kind, recommended: primaryAction(kind), otherActions: otherActionsFor(kind) };
}

/** Apply the precedence rules from the spec to choose the primary state kind. */
function classifyState(state: ProjectState): ProjectStateKind {
  if (isBrokenProject(state)) return "broken-project";
  if (isSourcesOnly(state)) return "sources-only";
  if (state.pendingCandidates > 0) return "review-pending";
  if (hasLintErrors(state)) return "lint-attention";
  if (hasWikiPages(state)) return "wiki-ready";
  if (isEmptyWiki(state)) return "empty-wiki";
  return "fresh";
}

/** True when the collector flagged the root as unreadable. */
function isBrokenProject(state: ProjectState): boolean {
  return state.warnings.some((w) => w.code === "project-unreadable");
}

/**
 * `empty-wiki` requires `wiki/` to actually exist with zero pages. The
 * spec wording is "wiki/ exists but page count is zero", and the human
 * renderer says so — we must not surface that line when wiki/ is missing.
 */
function isEmptyWiki(state: ProjectState): boolean {
  return state.hasWikiDir && !hasWikiPages(state);
}

/** Sources exist but no concept or query pages have been compiled yet. */
function isSourcesOnly(state: ProjectState): boolean {
  return state.sourceCount > 0 && !hasWikiPages(state);
}

/** True when the lint cache parsed and reports at least one error. */
function hasLintErrors(state: ProjectState): boolean {
  return state.lint.entry !== null && state.lint.entry.errors > 0;
}

/** True when the wiki carries any concept or query page. */
function hasWikiPages(state: ProjectState): boolean {
  return state.conceptCount > 0 || state.queryCount > 0;
}

/** Map a state kind to its primary recommended action. */
function primaryAction(kind: ProjectStateKind): RecommendedAction {
  return PRIMARY_ACTIONS[kind];
}

/** Map a state kind to its `otherActions` list. */
function otherActionsFor(kind: ProjectStateKind): RecommendedAction[] {
  return OTHER_ACTIONS[kind].map((a) => ({ ...a }));
}

/**
 * The Stack every registered wiki tool addresses, as an agent-filled placeholder.
 *
 * `stackId` is a REQUIRED argument of each tool named below — nothing is inherited
 * from the environment — so a recommendation that omitted it would not be a call.
 */
const STACK_PLACEHOLDER = "<stackId>";

/** Ingest: `ingest_source`, with a `source` placeholder for the path or URL. */
const INGEST_ACTION: RecommendedAction = {
  command: "ingest_source",
  reason: "Add sources manually before compiling.",
  executable: {
    tool: "ingest_source",
    input: { source: "<source>", stackId: STACK_PLACEHOLDER },
  },
};

/**
 * Same call as {@link INGEST_ACTION}, framed for a project that has nothing yet.
 *
 * There is no single tool that ingests AND compiles, so the honest suggestion is the
 * ingest call plus the reason that names the compile that follows it.
 */
const QUICKSTART_ACTION: RecommendedAction = {
  command: "ingest_source",
  reason: "Ingest a source, then compile it into wiki pages.",
  executable: {
    tool: "ingest_source",
    input: { source: "<source>", stackId: STACK_PLACEHOLDER },
  },
};

/** Compile: `compile_wiki`. */
const COMPILE_ACTION: RecommendedAction = {
  command: "compile_wiki",
  reason: "Compile sources/ into wiki pages.",
  executable: { tool: "compile_wiki", input: { stackId: STACK_PLACEHOLDER } },
};

/** Lint: `lint_wiki`. */
const LINT_ACTION: RecommendedAction = {
  command: "lint_wiki",
  reason: "Re-run lint to inspect outstanding errors.",
  executable: { tool: "lint_wiki", input: { stackId: STACK_PLACEHOLDER } },
};

/** Query: `query_wiki`, whose required field is `question`. */
const QUERY_ACTION: RecommendedAction = {
  command: "query_wiki",
  reason: "Ask a natural-language question against the compiled wiki.",
  executable: {
    tool: "query_wiki",
    input: { question: "<question>", stackId: STACK_PLACEHOLDER },
  },
};

/** Sentinel for the broken-project state: no command, no executable. */
const BROKEN_PROJECT_ACTION: RecommendedAction = {
  command: null,
  reason: "Project root is unreadable or could not be inspected.",
  executable: null,
};

/**
 * Sentinel for the `review-pending` state, which has no callable target.
 *
 * Candidates are written under `.llmwiki/candidates/` and NOTHING promotes them into
 * `wiki/`: no registered MCP tool does it, and the approval surface those two actions
 * used to promise is gone for good — review does not come back, so no action may name
 * it. They were deleted rather than reworded, because a softened promise is still a promise.
 *
 * The state itself stays: `classifyState` still reads `state.pendingCandidates > 0`,
 * so this is reachable and must not be removed from the state map.
 */
const REVIEW_PENDING_ACTION: RecommendedAction = {
  command: null,
  reason:
    "Candidates are held under .llmwiki/candidates/; no surface promotes them into wiki/.",
  executable: null,
};

/** Primary recommendation for each state kind. */
const PRIMARY_ACTIONS: Record<ProjectStateKind, RecommendedAction> = {
  "broken-project": BROKEN_PROJECT_ACTION,
  fresh: { ...QUICKSTART_ACTION, reason: "No sources or wiki pages were found." },
  "sources-only": { ...COMPILE_ACTION, reason: "Sources exist but no wiki pages have been compiled." },
  "review-pending": REVIEW_PENDING_ACTION,
  "lint-attention": { ...LINT_ACTION, reason: "Lint has reported errors; rerun lint to inspect them." },
  "wiki-ready": { ...QUERY_ACTION, reason: "Wiki pages are compiled and ready to query." },
  "empty-wiki": {
    ...COMPILE_ACTION,
    reason: "wiki/ exists but is empty; run compile or add sources first.",
  },
};

/**
 * Per-state otherActions table.
 *
 * `review-pending` is empty because both of its former entries served the deleted
 * review workflow, and `lint-attention` / `wiki-ready` lost the viewer action: the
 * viewer is served by the host process (`packages/api/src/main.ts`), not by any
 * registered MCP tool, so it is not a target a recommendation may name.
 */
const OTHER_ACTIONS: Record<ProjectStateKind, RecommendedAction[]> = {
  fresh: [INGEST_ACTION, QUICKSTART_ACTION],
  "sources-only": [COMPILE_ACTION, QUICKSTART_ACTION],
  "empty-wiki": [COMPILE_ACTION, INGEST_ACTION],
  "review-pending": [],
  "lint-attention": [LINT_ACTION],
  "wiki-ready": [QUERY_ACTION],
  "broken-project": [],
};
