/**
 * @file test/mcp/list-stacks-no-ambient-stack.test.ts
 * @description S5: `list_stacks` refuses a call that names no Stack instead of
 * resolving one from the process environment.
 *
 * ## The exemption survives; the ambient resolution does not
 *
 * `list_stacks` stays the one tool whose `stackId` is OPTIONAL, because a discovery tool
 * cannot demand the identifier of the thing it discovers. What it no longer does is fill
 * that omission from `AKS_STACK_ID`. That was ambient resolution wearing a tool's clothes:
 * a call with no tenant in mind was answered from whichever Stack the process happened to
 * serve, silently. The argument is now the only way to name one, and a call that names
 * none is refused by name.
 *
 * ## Why the ambient Stack is REAL and really bound
 *
 * The old code answered from it, so a case that merely asserted "a refusal" would pass
 * against the old code as well. Each refusing case below binds a provisioned Stack that
 * really holds rows, so the ANSWER the old code gave is observable in the assertion: the
 * reply must not carry the listing shape (`isCurrent`) nor the bound Stack's id.
 *
 * ## What must NOT change
 *
 * A call that DOES name a Stack still answers, and every Stack-scoped tool still refuses
 * an unknown id — both asserted here, because the exemption and the refusal are the two
 * behaviours most at risk of being "fixed" past their contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import type { McpToolEnvelope } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { usePerCaseFileMode, withFileMode } from "../fixtures/file-mode.js";
import { createEnvSnapshot } from "../fixtures/env-snapshot.js";

// A mixed file: the row-backed cases need the worker's database, the S7 case declares its
// absence for itself.
usePerCaseFileMode();

/**
 * What a deployment with NO database has always answered, verbatim.
 *
 * Preserved rather than reworded: this is the file-mode message (`tenant-db.ts`), and
 * changing its wording is not what S5 asked for. It is pinned because dropping the
 * environment fallback could easily have replaced it with the database-configured refusal.
 */
const NO_STACK_MESSAGE =
  "This project has no AKS_STACK_ID, so no Stack-scoped data can be read. " +
  "Set AKS_STACK_ID to the Stack this deployment serves.";

let stack: ProbeStack;
let root: string;
const env = createEnvSnapshot(["AKS_STACK_ID", "AKS_DATABASE_URL"]);

beforeEach(async () => {
  root = await scratchProjectRoot("list-stacks-no-ambient-");
  stack = await createProbeStack("list-stacks-no-ambient");
});

afterEach(async () => {
  env.restore();
  await stack.harness.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** Point the process at the provisioned Stack: the ambient binding the old code answered with. */
function bindProcessToTheStack(): void {
  env.setEnv({ AKS_DATABASE_URL: stack.harness.url, AKS_STACK_ID: stack.harness.stackId });
}

/** The text a tool answered with, joined from its content blocks. */
function textOf(result: McpToolEnvelope): string {
  return result.content.map((block) => block.text).join("");
}

/** One `list_stacks` call against the registered tool. */
async function listStacks(args: Record<string, unknown>): Promise<McpToolEnvelope> {
  return await callTool(buildServer(root), "list_stacks", args);
}

describe("list_stacks with a database configured", () => {
  it("refuses a call that names no Stack, even with AKS_STACK_ID naming a real one", async () => {
    if (!stack.harness.reachable) return;
    bindProcessToTheStack();

    const result = await listStacks({});

    expect(result.isError).toBe(true);
    const text = textOf(result);
    // The situation, named: a database is configured, so the omission is a caller error.
    expect(text).toContain("AKS_DATABASE_URL is configured");
    expect(text).toContain("list_stacks was called with no stackId");
    // The answer the old code gave, by name: neither the listing's `isCurrent` marker nor
    // the bound Stack's id may appear in a refusal.
    expect(text).not.toContain("isCurrent");
    expect(text).not.toContain(stack.harness.stackId);
  });

  it("answers a call that names a Stack", async () => {
    if (!stack.harness.reachable) return;
    bindProcessToTheStack();

    const result = await listStacks({ stackId: stack.harness.stackId });

    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(textOf(result)) as {
      stacks: Array<{ id: string; isCurrent: boolean }>;
      count: number;
    };
    expect(payload.count).toBe(payload.stacks.length);
    expect(payload.stacks.filter((entry) => entry.isCurrent).map((entry) => entry.id)).toEqual([
      stack.harness.stackId,
    ]);
  });

  it("still refuses a Stack-scoped tool that names an unknown Stack", async () => {
    if (!stack.harness.reachable) return;
    bindProcessToTheStack();
    const absent = randomUUID();

    const result = await callTool(buildServer(root), "read_page", {
      slug: "nobody",
      stackId: absent,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`No Stack '${absent}' exists.`);
  });
});

describe("list_stacks with no database configured", () => {
  it("keeps the file-mode answer it has always given", async () => {
    await withFileMode(async () => {
      delete process.env.AKS_STACK_ID;

      const result = await listStacks({});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(NO_STACK_MESSAGE);
    });
  });
});
