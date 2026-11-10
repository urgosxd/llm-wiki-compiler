/**
 * @file test/quickstart-shared-steps.test.ts
 * @description In-process replacement for the `llmwiki quickstart` cases in
 * `test/quickstart-integration.test.ts` (spec S5, group 3).
 *
 * ## Which modules the command composed, and which of them survive
 *
 * `quickstart` was a shell around three shared steps: ingest one source, compile
 * the project, then report. The brief pointed at `commands/ingest.ts`; the
 * DECLARER is `services/ingest/service.ts`, and `commands/ingest.ts` is a
 * four-line re-export of it (`:24`) that `sdk/core.ts:28` reaches. The compile
 * step is `compiler/index.ts`'s `compileAndReport`, and the queue count the
 * envelope reported is `compiler/candidate-read.ts`'s `countCandidates`. Both
 * survive, so every case whose subject is one of those steps is restated
 * here against the step.
 *
 * ## What is deliberately NOT ported
 *
 * The `version: 1` envelope, its six top-level keys, `ingest.ok`, `compile.ok`,
 * `compile.error`, `viewer.opened`/`viewer.url`, the ANSI purity of stdout, and
 * the `--json`/`--review`/`--no-open`/`--provider`/`--lang` flags are all
 * `commands/quickstart.ts` surface and die with the 32 CLI-only commands. The
 * three `it.skip` viewer-handoff cases in the source file are marked RETIRED
 * there because the condition they name cannot be produced by the product at
 * all; they are NO-REFERENT, not ports owed.
 *
 * The held-page report is gone with the last candidate stager: a compile can no longer
 * produce a pending candidate, so a case asserting that a `--review` compile fills the
 * queue has no surviving subject.
 *
 * ## Isolation
 *
 * Pages and candidates are Postgres ROWS, so each test runs on a freshly
 * provisioned Stack: a shared one would let one case's compiled page satisfy
 * another case's count, which is exactly the false green this file's strongest
 * case is written to avoid.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestSource } from "../packages/wiki/src/services/ingest/service.js";
import { compileAndReport } from "../packages/wiki/src/compiler/index.js";
import { ensureCompileProviderAvailable } from "../packages/wiki/src/utils/provider-guard.js";
import { acquireLock, releaseLock } from "../packages/wiki/src/utils/lock.js";
import { createDimensionsDatabase } from "../packages/wiki/src/dimensions/activation.js";
import { listStoredPagesUnfiltered } from "../packages/wiki/src/dimensions/wiki/page-store.js";
import { useStackEnv } from "./fixtures/stack-env.js";
import { stubExtractionAndBody } from "./fixtures/compile-reroute-helpers.js";

/** The exact string `compileAndReport` returns when it cannot take the lock. */
const LOCK_BUSY_ERROR = "Could not acquire .llmwiki/lock — another compile is in progress.";

/** A source body long enough to clear the ingest's minimum content length. */
const SOURCE_BODY = "# Source\n\nA short source for the quickstart port.\n";

/** The concept the stubbed extraction names, and the slug it becomes. */
const CONCEPT = "Quickstart Concept";

/** The prose the stubbed renderer returns for that concept. */
const PAGE_BODY = "Body produced for the quickstart port.";

useStackEnv("quickstart-shared-steps");

afterEach(() => {
  vi.restoreAllMocks();
});

/** A scratch project root, removed after the test that asked for it. */
async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "quickstart-shared-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/** A source file outside `sources/`, which ingest copies in. */
async function sourceFile(root: string): Promise<string> {
  const file = path.join(root, "fixture-source.md");
  await writeFile(file, SOURCE_BODY, "utf-8");
  return file;
}

/** One stored page as the product's own read path returns it. */
interface StoredPage {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
  pageDirectory: string;
}

/** Every page stored for the Stack installed in `process.env`. */
async function storedPages(): Promise<StoredPage[]> {
  const handle = createDimensionsDatabase(process.env);
  try {
    const stackId = (process.env.AKS_STACK_ID ?? "").trim();
    const pages = await listStoredPagesUnfiltered(handle.db, stackId);
    return pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      tags: [...page.tags],
      body: page.body ?? "",
      pageDirectory: page.pageDirectory,
    }));
  } finally {
    await handle.close();
  }
}

/** Stub the provider so a compile makes no network call, and silence its log. */
function stubProvider(): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  stubExtractionAndBody(CONCEPT, PAGE_BODY);
}

describe("step 1 — ingest", () => {
  it("reports a created file source whose saved path sits under sources/", async () => {
    const root = await projectRoot();
    try {
      const result = await ingestSource(root, await sourceFile(root));
      expect(result.sourceType).toBe("file");
      expect(result.writeStatus).toBe("created");
      await expect(access(path.join(root, "sources", result.filename))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing source and creates no sources/ directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "quickstart-missing-"));
    try {
      await expect(ingestSource(root, "/path/that/does/not/exist.md")).rejects.toThrow();
      await expect(access(path.join(root, "sources"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("step 2 — compile reports the run", () => {
  it("reports a clean compile with no errors and at least one page", async () => {
    const root = await projectRoot();
    stubProvider();
    try {
      await ingestSource(root, await sourceFile(root));
      const result = await compileAndReport(root);
      expect(result.errors).toEqual([]);
      expect(result.compiled).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe("step 2 — compile writes pages", () => {
  it("writes the compiled page beside the ingest's own stub row", async () => {
    const root = await projectRoot();
    stubProvider();
    try {
      await ingestSource(root, await sourceFile(root));
      await compileAndReport(root);
      const pages = (await storedPages()).filter((page) => page.pageDirectory === "concepts");
      const bySlug = new Map(pages.map((page) => [page.slug, page]));

      expect(bySlug.get("quickstart-concept")).toMatchObject({
        title: CONCEPT,
        summary: `${CONCEPT} summary.`,
        body: expect.stringContaining(PAGE_BODY),
      });

      // The ingest's own stub row is a SECOND page: empty summary, no tags, the
      // source's bytes. A `>= 1` over the set was satisfied by that row alone.
      const ingestStub = pages.filter((page) => page.slug !== "quickstart-concept");
      expect(ingestStub.map((page) => [page.summary, page.tags, page.body])).toEqual([
        ["", [], SOURCE_BODY],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("step 2 — compile failure paths", () => {
  it("preserves the lock-contention error verbatim with every counter zeroed", async () => {
    const root = await projectRoot();
    const held = await acquireLock(root, { quiet: true });
    expect(held).toBe(true);
    try {
      await expect(compileAndReport(root)).resolves.toMatchObject({
        errors: [LOCK_BUSY_ERROR],
        busy: true,
        compiled: 0,
        skipped: 0,
        deleted: 0,
      });
    } finally {
      await releaseLock(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to start without a compile provider and keeps the ingested source", async () => {
    const root = await projectRoot();
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.ANTHROPIC_AUTH_TOKEN = "";
    process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(root, "absent-settings.json");
    try {
      const ingested = await ingestSource(root, await sourceFile(root));
      expect(() => ensureCompileProviderAvailable()).toThrow(/credentials are required/);
      await expect(access(path.join(root, "sources", ingested.filename))).resolves.toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.LLMWIKI_CLAUDE_SETTINGS_PATH;
      await rm(root, { recursive: true, force: true });
    }
  });
});
