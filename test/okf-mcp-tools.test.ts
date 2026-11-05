// test/okf-mcp-tools.test.ts
/**
 * The OKF tools are Stack-scoped: `export_okf` reads the pages of the Stack named by
 * `stackId` and `import_okf` stages for it. These cases drive the handlers directly
 * (they bypass the SDK's schema validation, which is pinned in `test/mcp/`), so every
 * call here has to carry the required argument itself.
 *
 * Pages are seeded as ROWS, not files: the export resolves its corpus through
 * `withRawPageSource(root, env, …)`, which reads Postgres whenever a Stack is named.
 * A `wiki/concepts/*.md` file would be invisible to it, and the bundle assertions
 * would then pass against an empty bundle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { listCandidates } from "../src/compiler/candidates.js";
import { createPageWriteSink } from "../src/dimensions/wiki/page-write-sink.js";
import { assertNoOutput } from "./fixtures/no-output.js";
import { collectOkfHandlers } from "./fixtures/okf-tools-harness.js";
import { createProbeStack } from "./dimensions/harness-lifecycle.js";
import type { ProbeStack } from "./dimensions/harness-lifecycle.js";

let dir: string;
let stack: ProbeStack;

beforeEach(async () => {
  stack = await createProbeStack("mcp-okf-tools");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  await stack.harness.cleanup();
});

/**
 * Store one concept page as a row on the fixture's Stack.
 *
 * @param slug - Page slug.
 * @param body - Page body, after the generated frontmatter.
 */
async function seedConceptRow(slug: string, body: string): Promise<void> {
  await createPageWriteSink(stack.harness.db, stack.harness.stackId)({
    directory: "concepts",
    slug,
    body: `---\ntitle: ${slug.toUpperCase()}\nsummary: seeded for the OKF tool\n---\n\n${body}\n`,
  });
}

/** The Stack id every call must name. */
function stackId(): string {
  return stack.harness.stackId;
}

describe("MCP OKF tools", () => {
  it("export_okf writes a confined bundle; rejects out outside root", async () => {
    if (!stack.harness.reachable) return;
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf-"));
    await seedConceptRow("rag", "Body.");
    const h = collectOkfHandlers(dir);
    const res = await h.get("export_okf")!({ stackId: stackId() });
    expect(res.isError).toBeUndefined();
    expect((await stat(path.join(dir, "dist/exports/okf/index.md"))).isFile()).toBe(true);
    // The page came from the named Stack, so a bundle that ignored the argument and
    // exported nothing cannot pass behind the index.md check above.
    expect((await stat(path.join(dir, "dist/exports/okf/concepts/rag.md"))).isFile()).toBe(true);
    const bad = await h.get("export_okf")!({ out: "../escape", stackId: stackId() });
    expect(bad.isError).toBe(true);
  });
  it("import_okf stages (no trusted reachable) and rejects dir outside root", async () => {
    if (!stack.harness.reachable) return;
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf2-"));
    const b = path.join(dir, "kb"); await mkdir(path.join(b, "concepts"), { recursive: true });
    await writeFile(path.join(b, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    const h = collectOkfHandlers(dir);
    const res = await h.get("import_okf")!({ dir: "kb", stackId: stackId() });
    expect(res.isError).toBeUndefined();
    expect(await listCandidates(dir)).toHaveLength(1);
    const bad = await h.get("import_okf")!({ dir: "/etc", stackId: stackId() });
    expect(bad.isError).toBe(true);
  });
  it("export_okf stays silent even when a cited source is unbundled (stdio-stream safety)", async () => {
    if (!stack.harness.reachable) return;
    dir = await mkdtemp(path.join(tmpdir(), "mcp-okf3-"));
    // ^[missing.md:1-2] cites a source that does not exist → reportSkippedReferences would print.
    await seedConceptRow("rag", "Claim. ^[missing.md:1-2]");
    const h = collectOkfHandlers(dir);
    const res = await assertNoOutput(() => h.get("export_okf")!({ stackId: stackId() }));
    expect(res.isError).toBeUndefined();
  });
});
