/**
 * @file test/next-recommendations.test.ts
 * @description In-process replacement for the `llmwiki next` subprocess cases in
 * `test/next-integration.test.ts` (spec S5, group 1).
 *
 * ## What this file exists for
 *
 * `test/next-integration.test.ts` pins the orientation command by spawning the
 * compiled binary and parsing its stdout. The entry point that produced that
 * stdout is deleted with the CLI, so every assertion whose subject was the
 * RECOMMENDATION rather than the process is re-stated here against the two
 * shared modules the command composed:
 *
 *   - `project/state.ts`      — `collectProjectState`, the read-only collector.
 *   - `project/recommendations.ts` — `recommendNextAction`, the pure rules.
 *
 * Both survive: `context/build.ts` (reached by the SDK's context pack) composes
 * exactly this pair, which is what makes the recommendation a library contract
 * rather than a CLI artefact.
 *
 * ## What is deliberately NOT ported
 *
 * The envelope (`version: 1`, `summary.*`) is built in `commands/next.ts`, the
 * human renderer's prose is written there too, and "no ANSI escape ever reaches
 * JSON stdout" is a property of a process's byte stream. Those legitimate only
 * die with the entry and are enumerated in this task's report, not faked here.
 *
 * ## Invariants pinned
 *
 *   - the seven-way precedence decides `state`
 *   - the PRIMARY action names a registered MCP tool and the input fields that tool
 *     requires, so an agent can actually make the call
 *   - the recommendation never mutates the project it inspects
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectProjectState } from "../packages/wiki/src/project/state.js";
import { recommendNextAction } from "../packages/wiki/src/project/recommendations.js";
import {
  SOURCES_DIR,
  CONCEPTS_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
} from "../packages/wiki/src/utils/constants.js";
import { expectFreshDirUnchanged } from "./fixtures/project-state-helpers.js";
import { seedPendingCandidate, touchMarkdown } from "./fixtures/project-seeding.js";

/** Absolute root of the current test's project; recreated per test. */
let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "next-recommendations-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Write a lint cache reporting the given error/warning counts. */
async function seedLintCache(errors: number, warnings: number): Promise<void> {
  await mkdir(path.join(projectRoot, LLMWIKI_DIR), { recursive: true });
  const entry = { warnings, errors, at: new Date().toISOString() };
  await writeFile(path.join(projectRoot, LAST_LINT_FILE), JSON.stringify(entry), "utf-8");
}

/** Collect this test's project state and classify it in one step. */
async function recommendation(): Promise<ReturnType<typeof recommendNextAction>> {
  return recommendNextAction(await collectProjectState(projectRoot));
}

describe("recommendNextAction — a fresh project", () => {
  it("classifies an empty directory as `fresh`", async () => {
    const rec = await recommendation();
    expect(rec.state).toBe("fresh");
    expect(rec.recommended.reason).toBe("No sources or wiki pages were found.");
  });

  it("recommends the ingest_source call with the fields that tool requires", async () => {
    const rec = await recommendation();
    expect(rec.recommended.command).toBe("ingest_source");
    expect(rec.recommended.executable).toEqual({
      tool: "ingest_source",
      input: { source: "<source>", stackId: "<stackId>" },
    });
  });
});

describe("recommendNextAction — seeded sources and pages", () => {
  it("classifies seeded sources with no pages as `sources-only`", async () => {
    await touchMarkdown(path.join(projectRoot, SOURCES_DIR), "a.md");
    const rec = await recommendation();
    expect(rec.state).toBe("sources-only");
    expect(rec.recommended.executable?.tool).toBe("compile_wiki");
  });

  it("classifies seeded wiki pages as `wiki-ready` and recommends query_wiki", async () => {
    await touchMarkdown(path.join(projectRoot, CONCEPTS_DIR), "a.md");
    const rec = await recommendation();
    expect(rec.state).toBe("wiki-ready");
    expect(rec.recommended.executable).toEqual({
      tool: "query_wiki",
      input: { question: "<question>", stackId: "<stackId>" },
    });
  });

  it("classifies a pending candidate as `review-pending`, outranking wiki-ready", async () => {
    await touchMarkdown(path.join(projectRoot, CONCEPTS_DIR), "a.md");
    await seedPendingCandidate(projectRoot, "candidate-aabbccdd");
    const rec = await recommendation();
    expect(rec.state).toBe("review-pending");
    // Nothing promotes a candidate into `wiki/`, so the honest recommendation names no
    // call at all rather than a review command this product does not have.
    expect(rec.recommended.command).toBeNull();
    expect(rec.recommended.executable).toBeNull();
    expect(rec.recommended.reason).toContain(".llmwiki/candidates/");
  });

  it("classifies a lint cache with errors as `lint-attention` and surfaces its entry", async () => {
    await touchMarkdown(path.join(projectRoot, CONCEPTS_DIR), "a.md");
    await seedLintCache(3, 1);
    const state = await collectProjectState(projectRoot);
    const rec = recommendNextAction(state);
    expect(rec.state).toBe("lint-attention");
    expect(rec.recommended.executable?.tool).toBe("lint_wiki");
    expect(state.lint.present).toBe(true);
    expect(state.lint.entry).toEqual({ warnings: 1, errors: 3, at: expect.any(String) });
  });
});

describe("recommendNextAction — never mutates the project it inspects", () => {
  it("leaves a fresh directory byte-for-byte empty", async () => {
    await recommendation();
    await expectFreshDirUnchanged(projectRoot);
  });
});
