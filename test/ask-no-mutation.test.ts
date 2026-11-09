/**
 * @file test/ask-no-mutation.test.ts
 * @description Public ordinary queries retain activity logging on CLI and MCP.
 * Their only allowed filesystem change without saving is log.md; opt-in scoped
 * reads retain the new read-only contract. This deliberately supersedes the
 * internal AS-1 default-no-log behavior to preserve public compatibility.
 *
 * THE MCP ROUTE IS EXERCISED, NOT INFERRED. Both surfaces call the same
 * `generateAnswer`, so it is tempting to test one and reason about the other —
 * but the gate could just as easily have been added at the CLI command, leaving
 * MCP writing silently. This captures the registered `query_wiki` handler and
 * invokes it, so the claim covers the surface it names.
 *
 * The control is an ALLOWLIST of changed paths — a denylist only refuses the
 * writes someone thought of — and it pins its own precondition so an empty
 * fingerprint cannot make it pass vacuously.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { buildCollidingProject, CONCEPT_BODY, echoCallClaudeModule, mockQueryVector } from "./fixtures/typed-grounding.js";
import { changedPaths as changed, fingerprintTree as fingerprint } from "./fixtures/tree-fingerprint.js";
import { journalDescriptions, seedConceptPage } from "./fixtures/mcp-stack-rows.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";
import type { ProbeStack } from "./dimensions/harness-lifecycle.js";

// The selector call is answered with a page id and every other call echoes its
// prompt, which is what `echoCallClaudeModule` does — extended here because a
// Stack-scoped read has no embedding index of its own, so `generateAnswer` falls
// back to the LLM selector and would otherwise get the grounding prompt echoed
// back where it expects JSON. The CLI cases never reach that fallback: their
// staged workspace carries a real chunk store, so selection needs no LLM.
vi.mock("../packages/wiki/src/utils/llm.js", () => {
  const echo = echoCallClaudeModule();
  return {
    callClaude: vi.fn(async (options: { tools?: unknown[]; messages: Array<{ content: string }> }) =>
      options.tools === undefined
        ? echo.callClaude(options)
        : JSON.stringify({ pages: ["concepts/foo"], reasoning: "the row page" }),
    ),
  };
});

// THE MCP ROUTE GUARDS ON CREDENTIALS AND THE CLI ROUTE DOES NOT, so without
// this the MCP case measures whether the machine happens to have an API key
// rather than whether the query wrote anything — passing on a developer's
// machine and failing in CI, which is exactly what it did. The subject here is
// filesystem mutation; provider availability is a different claim with its own
// tests, so it is stubbed rather than depended on.
vi.mock("../packages/wiki/src/utils/provider-guard.js", () => ({ ensureProviderAvailable: () => {} }));


/** A project with two same-slug pages, both retrievable. */
async function project(suffix: string): Promise<string> {
  const root = await buildCollidingProject(suffix, [1, 0], [0, 1]);
  mockQueryVector([1, 1]);
  return root;
}

/**
 * The Stack the MCP route is asked about.
 *
 * `query_wiki` takes a REQUIRED `stackId`, so the call below names one. Provisioning
 * it is cheap and keeps the three filesystem-only cases untouched: nothing is bound
 * in `process.env`, so the CLI route keeps reading the staged `wiki/` tree.
 */
let stack: ProbeStack;

beforeEach(async () => {
  stack = await createProbeStack("ask-no-mutation");
});

afterEach(async () => {
  await stack.harness.cleanup();
});

/** Capture the MCP `query_wiki` handler by registering tools against a stub. */
async function mcpQueryHandler(root: string): Promise<(args: Record<string, unknown>) => Promise<unknown>> {
  const { registerWikiTools } = await import("../packages/wiki/src/mcp/tools.js");
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  registerWikiTools(server as never, root);
  const handler = handlers.get("query_wiki");
  if (handler === undefined) throw new Error(`query_wiki not registered; saw ${[...handlers.keys()].join(",")}`);
  return handler;
}

describe("asking a question without saving", () => {
  it("changes only the public activity log on the CLI route", async () => {
    const root = await project("ask-cli");
    const { generateAnswer } = await import("../packages/wiki/src/commands/query.js");
    const before = await fingerprint(root);
    // Pins the precondition: an empty fingerprint would pass regardless.
    expect(before.size).toBeGreaterThan(0);

    await generateAnswer(root, "scaling?");

    expect(changed(before, await fingerprint(root))).toEqual(["log.md"]);
  });

  it("journals the MCP route's question to the named Stack, not the deployment's log.md", async () => {
    if (!stack.harness.reachable) return;
    const root = await project("ask-mcp");
    // A Stack-scoped query reads its corpus from Postgres, so the colliding-slug project
    // on disk is invisible to it. The body is the same one the fixture writes, so the
    // answer this case produces is the answer it always produced. Only the DEFAULT
    // concept namespace is seeded: `wiki.pages.page_directory` admits `concepts` and
    // `queries` only, so the typed `papers/foo` page has no row to live in.
    await seedConceptPage(stack.harness, "foo", `---\ntitle: Concept Foo\nsummary: cs\n---\n\n${CONCEPT_BODY}`);
    const handler = await mcpQueryHandler(root);
    const before = await fingerprint(root);
    expect(before.size).toBeGreaterThan(0);

    const envelope = await handler({ question: "scaling?", stackId: stack.harness.stackId });

    // A refusal or a degraded empty answer would leave the filesystem untouched and
    // make the assertion below pass for the wrong reason, so the answer is required
    // to have really been produced.
    expect(JSON.parse((envelope as { content: Array<{ text: string }> }).content[0].text)).toMatchObject({
      pageIds: ["concepts/foo"],
    });

    // Both sides, because either alone passes for the wrong reason: the entry is in
    // the Stack the call named...
    expect(await journalDescriptions(stack.harness.stackId)).toEqual(["scaling?"]);
    // ...and the deployment's own journal — `log.md`, which is what a project with no
    // Stack writes — is not touched. Nothing else on disk may change either, so the
    // allowlist stays empty rather than naming a file that should no longer exist.
    expect(changed(before, await fingerprint(root))).toEqual([]);
  });

  it("keeps an explicitly scoped read byte-identical", async () => {
    const root = await project("ask-scoped");
    const { generateAnswer } = await import("../packages/wiki/src/commands/query.js");
    const before = await fingerprint(root);
    expect(before.size).toBeGreaterThan(0);
    await generateAnswer(root, "scaling?", { pageScope: ["concepts/foo", "papers/foo"] });
    expect(changed(before, await fingerprint(root))).toEqual([]);
  });

  it("DOES journal when the answer is saved — the write path is unchanged", async () => {
    // Saving remains an explicit write as well as recording query activity.
    const root = await project("ask-saved");
    const { generateAnswer } = await import("../packages/wiki/src/commands/query.js");
    const before = await fingerprint(root);

    await generateAnswer(root, "scaling?", { save: true });

    expect(changed(before, await fingerprint(root))).toContain("log.md");
  });
});
