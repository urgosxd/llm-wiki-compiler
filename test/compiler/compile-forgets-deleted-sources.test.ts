/**
 * @file test/compiler/compile-forgets-deleted-sources.test.ts
 * @description A deleted source must still be NAMEABLE on the run that sees it
 * gone, so the graph can be told which document to retire.
 *
 * WHY THIS IS THE HARD PART. `compile` detects a deletion by FILENAME, but the
 * graph was written under the source IDENTITY (a URL), and the only place that
 * identity lived was the deleted file's frontmatter. If state does not carry it,
 * `forget` can never be called correctly — and guessing from a filename would
 * delete either nothing or the wrong document.
 *
 * The compile runs against a stub provider rather than real credentials: what is
 * under test is where the identity is PERSISTED, not what the model returns.
 */
import { describe, expect, it } from "vitest";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { mockClaudeEnv, stubCannedCompile, useAimockLifecycle } from "../fixtures/aimock-helper.js";
import { runCLI } from "../fixtures/run-cli.js";
import { readState } from "../../src/utils/state.js";

const aimock = useAimockLifecycle("compile-forget");

/** The identity the graph would be written under. */
const SOURCE_IDENTITY = "https://example.test/original-article";

/** A project whose single source declares its identity in frontmatter. */
async function projectWithIdentity(handle: Awaited<ReturnType<typeof aimock.start>>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "compile-forget-")));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, "sources", "article.md"),
    `---\ntitle: Article\nsource: ${SOURCE_IDENTITY}\ningestedAt: 2026-01-01T00:00:00.000Z\n---\n\nBody text describing a concept.\n`,
    "utf8",
  );
  stubCannedCompile(handle, "Article Concept");
  return root;
}

describe("compile records the source identity for retirement", () => {
  it("persists the frontmatter source into state", async () => {
    const handle = await aimock.start();
    const root = await projectWithIdentity(handle);

    const result = await runCLI(["compile"], root, mockClaudeEnv(handle));
    expect(result.code).toBe(0);

    const state = await readState(root);
    // Without this the graph could never be told WHICH document to retire.
    expect(Object.values(state.sources)[0]?.source).toBe(SOURCE_IDENTITY);
  }, 180_000);

  it("keeps the identity readable after the file is deleted", async () => {
    const handle = await aimock.start();
    const root = await projectWithIdentity(handle);
    expect((await runCLI(["compile"], root, mockClaudeEnv(handle))).code).toBe(0);

    // This is the state the retiring run observes: the file that carried the
    // identity no longer exists, so state is the only remaining source of it.
    await rm(path.join(root, "sources", "article.md"));
    const state = await readState(root);
    expect(Object.values(state.sources)[0]?.source).toBe(SOURCE_IDENTITY);
  }, 180_000);
});

