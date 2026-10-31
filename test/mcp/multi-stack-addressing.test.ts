/**
 * @file test/mcp/multi-stack-addressing.test.ts
 * @description One process, several Stacks, no leakage between them.
 *
 * ## The condition this pins
 *
 * Every read tool used to resolve its Stack from the environment the process was
 * started with, so a single host could serve exactly one tenant. Two Stacks with the
 * SAME slug are the fixture that can tell the difference: if a tool ignores the
 * `stackId` it was given, it still answers — with the other tenant's body. An empty
 * Stack or a distinct slug would both pass under that defect, which is why neither is
 * used here.
 *
 * ## Why the tool is driven through MCP rather than through a helper
 *
 * The first draft of this file called `readPageBySlugForTest`, which builds its own
 * environment and never consults the argument the tool was handed. It passed — and it
 * kept passing when `withRequestEnv` was mutated to ignore `stackId` entirely, which
 * is the definition of a test that proves nothing. The defect it was meant to catch
 * lived one layer ABOVE the helper. Calling the registered tool is the only way to
 * exercise the wiring a caller actually hits.
 *
 * ## Why the assertions are on the BODY
 *
 * Returning "a page called `shared`" is true under every broken variant. Only the body
 * proves WHICH row was read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rm } from "node:fs/promises";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { withRequestEnv } from "../../src/mcp/tenant-db.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** Slug shared by BOTH Stacks, so a wrong Stack still finds a page to return. */
const SHARED_SLUG = "shared";

/** Write the same slug into a Stack with a body unique to that Stack. */
async function seedBody(stack: ProbeStack, body: string): Promise<void> {
  await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
    directory: "concepts",
    slug: SHARED_SLUG,
    body: `---\ntitle: Shared\nsummary: s\n---\n\n${body}`,
  });
}

/** Read one page through the registered tool and return its parsed body. */
async function readViaTool(
  server: McpServer,
  stackId: string,
): Promise<string> {
  const result = await callTool(server, "read_page", { slug: SHARED_SLUG, stackId });
  const text = result.content[0]?.text ?? "";
  return (JSON.parse(text) as { body?: string }).body ?? "";
}

describe("multi-Stack addressing", () => {
  let first: ProbeStack;
  let second: ProbeStack;
  let root: string;

  beforeEach(async () => {
    first = await createProbeStack("multi-a");
    second = await createProbeStack("multi-b");
    // No wiki/ tree: both pages exist only as rows, so disk cannot answer for either.
    root = await scratchProjectRoot("multi-stack-");
  });

  afterEach(async () => {
    await first.harness.cleanup();
    await second.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("reads the Stack it was given, not the one the process is bound to", async () => {
    if (!first.harness.reachable || !second.harness.reachable) return;
    await seedBody(first, "BODY_OF_STACK_A");
    await seedBody(second, "BODY_OF_STACK_B");
    const server = buildServer(root);

    // The process is bound to `first`, so a tool that ignored the argument would
    // return BODY_OF_STACK_A for BOTH calls below.
    process.env.AKS_STACK_ID = first.harness.stackId;
    try {
      expect(await readViaTool(server, first.harness.stackId)).toContain("BODY_OF_STACK_A");
      // The load-bearing assertion: same slug, same process, different tenant.
      expect(await readViaTool(server, second.harness.stackId)).toContain("BODY_OF_STACK_B");
    } finally {
      delete process.env.AKS_STACK_ID;
    }
  }, 60_000);

  it("leaves the ambient environment untouched for the next caller", async () => {
    if (!first.harness.reachable) return;
    process.env.AKS_STACK_ID = first.harness.stackId;
    try {
      // A REAL Stack: `withRequestEnv` now refuses an id that exists nowhere, so an
      // invented one would exercise the refusal path and prove nothing about the env.
      const seen = await withRequestEnv(second.harness.stackId, async (env) => ({
        inside: env.AKS_STACK_ID,
        // The process env must NOT have been written: two concurrent tools would
        // otherwise read each other's Stack.
        ambient: process.env.AKS_STACK_ID,
      }));

      expect(seen.inside).toBe(second.harness.stackId);
      expect(seen.ambient).toBe(first.harness.stackId);
      expect(process.env.AKS_STACK_ID).toBe(first.harness.stackId);
    } finally {
      delete process.env.AKS_STACK_ID;
    }
  }, 60_000);
});
