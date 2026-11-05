// test/okf-mcp-queue-cap.test.ts  (≤40 lines)
/**
 * The queue cap is enforced for the Stack the caller named, so the handler is driven
 * directly with the required `stackId` — this file bypasses schema validation, which
 * is pinned in `test/mcp/`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectOkfHandlers } from "./fixtures/okf-tools-harness.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";
import type { ProbeStack } from "./dimensions/harness-lifecycle.js";

let dir: string;
let stack: ProbeStack;

beforeEach(async () => { stack = await createProbeStack("mcp-okf-cap"); });
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  await stack.harness.cleanup();
});

describe("import_okf honors the candidate cap", () => {
  it("refuses to stage when the cap would be exceeded, but dry-run is allowed", async () => {
    if (!stack.harness.reachable) return;
    dir = await mkdtemp(path.join(tmpdir(), "mcp-cap-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const handlers = collectOkfHandlers(dir, 0); // injected cap of 0 → any staging is over the cap
    const stackId = stack.harness.stackId;
    const refused = await handlers.get("import_okf")!({ dir: "kb", stackId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/queue/i);
    const preview = await handlers.get("import_okf")!({ dir: "kb", dryRun: true, stackId });
    expect(preview.isError).toBeUndefined(); // dry-run is never blocked
  });
});
