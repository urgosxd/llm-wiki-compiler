/**
 * Subprocess integration tests for `llmwiki quickstart`.
 *
 * Exercises the compiled CLI binary end-to-end through `runCLI` so the
 * documented JSON contract, exit codes, and side-effects are pinned at
 * the same surface real users (and agents) see. Stubs the LLM with the
 * shared aimock helper so no real provider calls are made.
 *
 * Critical invariants pinned here:
 *   - `--json` implies `--no-open` and emits the versioned envelope.
 *   - `--review` never starts the viewer and recommends `review list`.
 *   - returned compiler errors land on `compile.errors`; provider/throw
 *     failures land on `compile.error` and are mutually exclusive.
 *   - `compile.pendingCandidates` is sourced from `countCandidates`.
 *   - missing source exits non-zero without writing into sources/.
 *   - `--provider` overrides LLMWIKI_PROVIDER for the run only.
 *   - `--lang` forwards through to the compile prompt.
 */

import { describe, it, expect } from "vitest";
import { readdir, access, mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  mockClaudeEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit, expectCLIFailure, type CLIResult } from "./fixtures/run-cli.js";
import { useQuickstartProcessLifecycle } from "./fixtures/run-cli-server.js";
import { LLMWIKI_DIR, LAST_LINT_FILE } from "../src/utils/constants.js";
import { countConceptPages, listSourceFilenames } from "./fixtures/source-corpus.js";
import { useStackEnv } from "./fixtures/stack-env.js";
import { createDimensionsDatabase } from "../src/dimensions/activation.js";
import { listStoredPagesUnfiltered } from "../src/dimensions/wiki/page-store.js";
import { holdProjectLockOnNextRelease } from "./fixtures/quickstart-lock-holder.js";

// Every suite here drives quickstart end to end, which ingests.
useStackEnv("quickstart-integration");

/**
 * The two honest outcomes the four formerly-inert expectations now have.
 *
 * All four used to be gated by `it.skipIf(stackAlwaysOn)`, where `stackAlwaysOn`
 * was `testDatabaseUrl() !== ""` -- a tautology, because `testDatabaseUrl()`
 * returns `DEFAULT_TEST_DATABASE_URL` when the override is empty and never returns
 * `""` (`test/fixtures/test-database.ts:62-65`). A predicate that reads like a
 * live guard gated nothing, and none of the four ever executed.
 *
 * RESURRECTED (executes in the default run): the lock-contention expectation. The
 * lock moved from a `.llmwiki/lock` FILE to a Postgres advisory lock keyed by the
 * Stack id, so the contention is now produced honestly by holding that advisory
 * lock from a second session -- see `fixtures/quickstart-lock-holder.ts` for why it
 * has to queue behind the ingest rather than be held up front.
 *
 * RETIRED (marked with the measured reason they can never be true): the three
 * viewer-handoff expectations. They are not waiting on a database or an opt-in; the
 * condition they name cannot be produced by the product at all, on any
 * configuration. `quickstart` decides the handoff with `hasRenderablePages`,
 * which reads `collectProjectState` (`src/project/state.ts:170-181`), and that
 * collector counts pages as MARKDOWN FILES under `wiki/concepts` and `wiki/queries`
 * while a compiled page is a Postgres ROW (`src/dimensions/activation.ts:16`: the
 * file-backed wiki dimension is gone). Measured: after a quickstart that reports
 * `1 compiled` and `Index updated with 2 pages`, the collector still reports zero
 * pages and the run ends with `next: llmwiki compile` instead of the handoff. The
 * fix belongs to `collectProjectState`/`quickstart`, not to this suite. They stay in
 * place marked RETIRED; removing them is a human decision, and its exact command is
 * reported with this task rather than executed here.
 */

/**
 * Env overrides that pin the provider for a run that must never reach a provider.
 *
 * `offline` needs no credential, so `ensureCompileProviderAvailable` -- which runs
 * BEFORE the compile takes the project lock -- passes without aimock and without a
 * network call, which keeps the lock-contention test about the lock.
 */
const OFFLINE_PROVIDER_ENV: NodeJS.ProcessEnv = {
  LLMWIKI_PROVIDER: "offline",
  LLMWIKI_MODEL: "offline-deterministic",
};

/**
 * One concept page as the wiki's read path exposes it.
 *
 * Only the fields that identify WHICH writer produced the page are kept: the compile
 * renders frontmatter (summary, tags) and its own prose, the ingest writes an empty
 * summary, no tags, and the source bytes.
 */
interface StoredConceptPage {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  body: string;
}

/**
 * The concept pages stored for this suite's Stack, page by page.
 *
 * `countConceptPages` answers only HOW MANY pages exist, and after a quickstart that
 * number is already satisfied by the INGEST's own stub row -- `commitPageRow` in
 * `src/dimensions/wiki/store-dimension.ts` upserts one page per source -- so a `>= 1`
 * over it proves nothing about the compile. These are the same rows, one page at a
 * time, read through the page read API the product's own read path uses.
 *
 * @returns Every page in the `concepts` directory of the bound Stack.
 */
async function storedConceptPages(): Promise<StoredConceptPage[]> {
  const handle = createDimensionsDatabase({
    ...process.env,
    AKS_DATABASE_URL: boundDatabaseUrl(),
  });
  try {
    const pages = await listStoredPagesUnfiltered(handle.db, boundStackId());
    return pages
      .filter((page) => page.pageDirectory === "concepts")
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        summary: page.summary,
        tags: [...page.tags],
        body: page.body ?? "",
      }));
  } finally {
    await handle.close();
  }
}

/** The exact string `compileAndReport` returns when it cannot take the lock. */
const LOCK_BUSY_ERROR = "Could not acquire .llmwiki/lock — another compile is in progress.";

const aimock = useAimockLifecycle("quickstart");

/**
 * Stub the canned compile responses (extraction tool call + page body).
 * One shared concept is enough to drive a single happy-path compile.
 */
function stubCompile(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: "Quickstart Concept",
              summary: "Concept produced by aimock for quickstart tests.",
              is_new: true,
              tags: ["quickstart-test"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Body produced for the quickstart test." });
}

/** Inputs that every aimock-backed test in this file repeats. */
interface AimockSetup {
  handle: MockClaudeHandle;
  cwd: string;
  fixturePath: string;
}

/**
 * Boot aimock, stub the canned compile responses, create a temp project
 * workspace, and drop a fixture markdown file outside `sources/` so the
 * quickstart subprocess copies it in.
 */
async function bootQuickstart(fixtureBody: string): Promise<AimockSetup> {
  const handle = await aimock.start();
  stubCompile(handle);
  const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
  const fixturePath = path.join(cwd, "fixture-source.md");
  await writeFile(fixturePath, fixtureBody, "utf-8");
  return { handle, cwd, fixturePath };
}

/**
 * Run quickstart in `--json --no-open` mode on top of an aimock-backed
 * project, returning the CLI result + parsed envelope. Centralises the
 * "spawn + parse" idiom so the per-test bodies stay readable.
 */
async function runJsonHappy(extraArgs: string[] = []): Promise<{
  result: CLIResult;
  envelope: Record<string, unknown>;
  cwd: string;
}> {
  const { handle, cwd, fixturePath } = await bootQuickstart(
    "# Source\n\nA short source for the quickstart test.\n",
  );
  const result = await runCLI(
    ["quickstart", fixturePath, ...extraArgs, "--json", "--no-open"],
    cwd,
    mockClaudeEnv(handle),
  );
  expectCLIExit(result, 0);
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  return { result, envelope, cwd };
}

describe("`llmwiki quickstart --json --no-open` — happy path envelope", () => {
  it("returns version 1 with stable top-level fields", async () => {
    const { envelope } = await runJsonHappy();
    expect(envelope.version).toBe(1);
    expect(Object.keys(envelope)).toEqual([
      "version",
      "source",
      "ingest",
      "compile",
      "viewer",
      "next",
    ]);
  });

  it("populates ingest.ok=true and ingest.path under sources/", async () => {
    const { envelope } = await runJsonHappy();
    const ingest = envelope.ingest as Record<string, unknown>;
    expect(ingest.ok).toBe(true);
    expect(typeof ingest.path).toBe("string");
    expect((ingest.path as string).startsWith("sources/")).toBe(true);
    expect(ingest.error).toBeNull();
    expect(ingest.sourceType).toBe("file");
  });

  it("sets compile.ok=true with errors=[] and error=null on a clean compile", async () => {
    const { envelope } = await runJsonHappy();
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    expect(compile.errors).toEqual([]);
    expect(compile.error).toBeNull();
    expect(compile.compiled).toBeGreaterThanOrEqual(1);
  });

  it("always reports viewer.opened=false, viewer.url=null in --json mode", async () => {
    // --json implies --no-open, so the viewer is never started; the static
    // envelope shape is the permanent contract for agent consumers.
    const { envelope } = await runJsonHappy();
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });

  it("emits no ANSI escapes in --json output", async () => {
    const { result } = await runJsonHappy();
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it("writes the compiled concept page into the Stack's concepts, past the ingest's stub", async () => {
    await runJsonHappy();
    const pages = await storedConceptPages();
    // The compile's page: the stub extraction names one concept and the stub page body
    // is the only prose the renderer sees, so these four fields together come from the
    // compile -- the ingest never writes a summary or a tag.
    const compiled = pages.find((page) => page.slug === "quickstart-concept");
    expect(compiled?.title).toBe("Quickstart Concept");
    expect(compiled?.summary).toBe("Concept produced by aimock for quickstart tests.");
    expect(compiled?.tags).toEqual(["quickstart-test"]);
    expect(compiled?.body).toContain("Body produced for the quickstart test.");
    // ...and it is a SECOND page: the ingest's own stub row is still there, empty
    // summary, no tags, the source's bytes. A `>= 1` over this set was satisfied by
    // that stub alone, which is what made it pass with no compile at all.
    const ingestStub = pages.filter((page) => page.slug !== "quickstart-concept");
    expect(ingestStub).toHaveLength(1);
    expect(ingestStub[0]?.summary).toBe("");
    expect(ingestStub[0]?.tags).toEqual([]);
    expect(ingestStub[0]?.body).toBe("# Source\n\nA short source for the quickstart test.\n");
  });
});

describe("`llmwiki quickstart --review --no-open`", () => {
  it("recommends `llmwiki review list` and never reports a viewer URL", async () => {
    const { envelope } = await runJsonHappy(["--review"]);
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    const next = envelope.next as Record<string, unknown>;
    expect(next.command).toBe("llmwiki review list");
    const executable = next.executable as Record<string, unknown>;
    expect(executable.args).toEqual(["review", "list"]);
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });

  it("reports compile.pendingCandidates from countCandidates(), not from CompileResult", async () => {
    const { envelope } = await runJsonHappy(["--review"]);
    const compile = envelope.compile as Record<string, unknown>;
    // The stubbed extraction emits one concept → exactly one candidate.
    expect(compile.pendingCandidates).toBe(1);
  });
});

describe("`llmwiki quickstart --review` — viewer never auto-starts", () => {
  it("does not start the viewer even when --no-open is absent", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nReview-only test.\n",
    );
    // No --no-open and no --json. Review must still skip the viewer.
    const result = await runCLI(
      ["quickstart", fixturePath, "--review"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    // Human output: should mention the review queue and never the viewer URL pattern.
    expect(result.stdout).not.toMatch(/Viewer ready at http/);
    expect(result.stdout).toContain("llmwiki review list");
  });
});

describe("`llmwiki quickstart --json` (without --no-open)", () => {
  it("implies --no-open: emits JSON, sets viewer.opened=false, exits cleanly", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nJSON-implies-noopen test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--json"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });
});

describe("`llmwiki quickstart <missing>`", () => {
  it("exits non-zero without writing into sources/", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-missing-"));
    try {
      const result = await runCLI(["quickstart", "/path/that/does/not/exist.md"], cwd);
      expectCLIFailure(result);
      // sources/ must not have been created by quickstart on the failure path.
      await expect(access(path.join(cwd, "sources"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits parseable --json envelope and never inspects existing candidates", async () => {
    // Seed a pending candidate up-front so we'd notice if quickstart leaks
    // project-state inspection into the ingest-failure path. The plan says
    // ingest failures must exit 1 without project inspection or mutation.
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-missing-json-"));
    try {
      await mkdir(path.join(cwd, ".llmwiki", "candidates"), { recursive: true });
      await writeFile(
        path.join(cwd, ".llmwiki", "candidates", "preexisting-aabbccdd.json"),
        JSON.stringify({
          id: "preexisting-aabbccdd",
          title: "Preexisting",
          slug: "preexisting",
          summary: "Should not surface on ingest-failure path.",
          sources: ["x.md"],
          body: "stub",
          generatedAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const result = await runCLI(
        ["quickstart", "/path/that/does/not/exist.md", "--json"],
        cwd,
      );
      expectCLIFailure(result);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      const ingest = envelope.ingest as Record<string, unknown>;
      expect(ingest.ok).toBe(false);
      expect(ingest.path).toBeNull();
      const compile = envelope.compile as Record<string, unknown>;
      // Pre-existing candidate must NOT have been counted: ingest failure
      // must not inspect project state at all.
      expect(compile.pendingCandidates).toBe(0);
      expect(compile.ok).toBe(false);
      expect(compile.errors).toBeNull();
      expect(compile.error).toBeNull();
      // sources/ still not created by quickstart on the failure path.
      await expect(access(path.join(cwd, "sources"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Create a workspace and a fixture file for the lock-contention run.
 *
 * No aimock: the compile cannot take the lock, so it never reaches a provider, and
 * `OFFLINE_PROVIDER_ENV` is what makes the provider GUARD (which runs first) pass.
 */
async function bootLockFixture(): Promise<{ cwd: string; fixturePath: string }> {
  const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
  const fixturePath = path.join(cwd, "fixture-source.md");
  await writeFile(
    fixturePath,
    "# Src\n\nThe compile-lock source for the quickstart integration test.\n",
    "utf-8",
  );
  return { cwd, fixturePath };
}

/** The Stack the suite bound for this test. The advisory lock is keyed by it. */
function boundStackId(): string {
  const stackId = (process.env.AKS_STACK_ID ?? "").trim();
  if (stackId === "") throw new Error("no AKS_STACK_ID: useStackEnv did not provision a Stack");
  return stackId;
}

/** The database carrying that Stack; the SAME value the spawned CLI receives. */
function boundDatabaseUrl(): string {
  const dsn = (process.env.AKS_DATABASE_URL ?? "").trim();
  if (dsn === "") throw new Error("no AKS_DATABASE_URL: useStackEnv did not name a database");
  return dsn;
}

/**
 * Every observable effect of "the compile could not take the project lock": the
 * exact exit code, the exact returned error string, the zeroed counters it was
 * returned with, the untouched viewer envelope, and the resumable next action.
 */
function expectLockedOutEnvelope(result: CLIResult): void {
  expectCLIExit(result, 0);
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(envelope.ingest).toMatchObject({ ok: true, sourceType: "file", error: null });
  expect(envelope.compile).toEqual({
    ok: false,
    compiled: 0,
    skipped: 0,
    deleted: 0,
    pendingCandidates: 0,
    errors: [LOCK_BUSY_ERROR],
    error: null,
  });
  expect(envelope.viewer).toEqual({ opened: false, url: null });
  expect(envelope.next).toEqual({
    command: "llmwiki compile",
    reason: "Compile reported errors. Address them and rerun compile.",
    executable: { binary: "llmwiki", args: ["compile"] },
  });
}

describe("`llmwiki quickstart --json` — compile returns errors (lock contention)", () => {
  it("preserves CompileResult.errors verbatim and reports compile.ok=false", async () => {
    const { cwd, fixturePath } = await bootLockFixture();
    // The holder starts BEFORE the child, then queues a blocking acquire behind the
    // child's ingest: the ingest holds the same lock (`tryWithOrdinaryMutationLock`),
    // so holding it up front would fail the INGEST instead of the compile.
    const holder = await holdProjectLockOnNextRelease(boundStackId(), boundDatabaseUrl());
    try {
      const result = await runCLI(
        ["quickstart", fixturePath, "--json", "--no-open"],
        cwd,
        OFFLINE_PROVIDER_ENV,
      );
      // Rejects unless the child really took the lock and this process now owns it,
      // so a run that never contended fails here instead of asserting nothing.
      await holder.hold();
      expectLockedOutEnvelope(result);
      // A refused compile stores nothing: the ingest is the only phase that wrote, and
      // the single concept page below is the ingest's own stub row
      // (`src/dimensions/wiki/store-dimension.ts` upserts it), not a compiled page.
      expect(await listSourceFilenames(cwd)).toHaveLength(1);
      expect(await countConceptPages(cwd)).toBe(1);
    } finally {
      await holder.release();
    }
  }, 60_000);
});

describe("`llmwiki quickstart --json` — compile provider failure after ingest", () => {
  it("preserves the ingested source and emits compile.error.code=provider_unavailable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-noprov-"));
    const fixturePath = path.join(cwd, "src.md");
    await writeFile(fixturePath, "# Src\n\nProvider-failure test.\n", "utf-8");
    try {
      const result = await runCLI(
        ["quickstart", fixturePath, "--json", "--no-open"],
        cwd,
        // Anthropic with no creds and a non-existent Claude settings file
        // so the resolver does not pick up the host's real key.
        {
          LLMWIKI_PROVIDER: "anthropic",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/does/not/exist.json",
        },
      );
      expectCLIExit(result, 0);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      const ingest = envelope.ingest as Record<string, unknown>;
      expect(ingest.ok).toBe(true);
      const compile = envelope.compile as Record<string, unknown>;
      expect(compile.ok).toBe(false);
      expect(compile.errors).toBeNull();
      const compileError = compile.error as Record<string, unknown>;
      expect(compileError.code).toBe("provider_unavailable");
      expect(compileError.recoverable).toBe(true);
      // Source must still be on disk so the user can retry compile.
      expect((await listSourceFilenames(cwd)).length).toBeGreaterThanOrEqual(1);
      // Next action recommends llmwiki compile so the user can resume.
      const next = envelope.next as Record<string, unknown>;
      expect(next.command).toBe("llmwiki compile");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("`llmwiki quickstart --provider`", () => {
  it("overrides LLMWIKI_PROVIDER for the run only (no config persisted)", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nProvider override test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--provider", "anthropic", "--json", "--no-open"],
      cwd,
      {
        ...mockClaudeEnv(handle),
        // Pretend the host has a different provider set; --provider wins.
        LLMWIKI_PROVIDER: "openai",
      },
    );
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    // No durable config file is written; assert nothing landed on disk.
    await expect(access(path.join(cwd, ".llmwiki", "provider.json"))).rejects.toThrow();
  });
});

describe("`llmwiki quickstart --lang`", () => {
  it("forwards the directive into the compile system prompt", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nLang forwarding test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--lang", "Spanish", "--json", "--no-open"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    const seenPrompts = handle.mock.getRequests() as Array<{ body?: unknown }>;
    const allSystem = seenPrompts.flatMap((req) => {
      const body = req.body as { messages?: unknown } | undefined;
      if (!Array.isArray(body?.messages)) return [];
      return (body.messages as Array<{ role?: unknown; content?: unknown }>)
        .filter((m) => m.role === "system" && typeof m.content === "string")
        .map((m) => m.content as string);
    });
    expect(allSystem.some((p) => p.includes("Write the output in Spanish."))).toBe(true);
  });
});

describe("`llmwiki quickstart` — viewer handoff (Slice 3) — RETIRED", () => {
  const lifecycle = useQuickstartProcessLifecycle();

  // RETIRED, not skipped pending work: these three can never be true against this
  // product, on any configuration (see the note at the top of this file, and
  // `src/project/state.ts:170-181` versus `src/dimensions/activation.ts:16`).
  // `quickstart` gates the handoff on `hasRenderablePages(collectProjectState(root))`,
  // and that collector counts markdown FILES that a Stack-backed compile never
  // writes, so the gate is unreachable: measured after `1 compiled` plus `Index
  // updated with 2 pages`, the run still ends with `next: llmwiki compile`. The
  // fixture length the old comment blamed (33 chars) is a red herring: the compile
  // does produce a page, and the collector still reports zero. Same for the lint
  // variant -- `hasLintErrors` DOES outrank `wiki-ready`, but a non-view `Next:` line
  // can only survive a handoff that never starts.

  it.skip("prints the lifecycle line and hands off to the foreground viewer when pages exist", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nViewer-handoff happy path.\n",
    );
    // Spawn without --no-open / --json / --review so the start condition
    // fires. The lifecycle helper sends SIGTERM after the readiness line
    // so the test never hangs on the foreground viewer.
    const proc = await lifecycle.start(cwd, [fixturePath], mockClaudeEnv(handle));
    expect(proc.stdout).toContain("Starting viewer. Press Ctrl+C to stop.");
    expect(proc.stdout).toMatch(/Viewer ready at http:\/\/127\.0\.0\.1:\d+/);
    expect(proc.host).toBe("127.0.0.1");
    expect(proc.port).toBeGreaterThan(0);
  });

  // Retired; see the note at the top of this describe.
  it.skip("suppresses the `Next:` line when handing off (viewer is the action)", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nNext-line suppression test.\n",
    );
    const proc = await lifecycle.start(cwd, [fixturePath], mockClaudeEnv(handle));
    // The human summary still includes the ingest/compile lines, but
    // the `Next:` block must be absent: the viewer that's about to open
    // is itself the next action.
    expect(proc.stdout).toContain("Ingested source");
    expect(proc.stdout).toContain("Compiled wiki");
    expect(proc.stdout).not.toMatch(/^Next:$/m);
  });

  // Retired; see the note at the top of this describe.
  it.skip("preserves a non-view `Next:` recommendation during handoff (lint errors)", async () => {
    // Seed a populated lint cache with errors BEFORE quickstart runs.
    // After compile the project state hits lint-attention (errors > 0
    // outranks wiki-ready), so recommendNextAction returns `llmwiki
    // lint` — NOT `llmwiki view --open`. The suppression must let that
    // through even though shouldStartViewer is still true (pages exist,
    // no --no-open / --json / --review). Regression for the bug where
    // suppressRedundantViewerNext dropped every Next line, not just the
    // redundant view-open one.
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nLint-attention-with-handoff test.\n",
    );
    await mkdir(path.join(cwd, LLMWIKI_DIR), { recursive: true });
    const lintCache = { warnings: 1, errors: 3, at: new Date().toISOString() };
    await writeFile(path.join(cwd, LAST_LINT_FILE), JSON.stringify(lintCache), "utf-8");
    const proc = await lifecycle.start(cwd, [fixturePath], mockClaudeEnv(handle));
    expect(proc.stdout).toMatch(/Viewer ready at http:\/\/127\.0\.0\.1:\d+/);
    expect(proc.stdout).toMatch(/^Next:$/m);
    expect(proc.stdout).toContain("llmwiki lint");
    // Sanity: we did NOT echo the redundant view-open recommendation.
    expect(proc.stdout).not.toContain("llmwiki view --open");
  });
});
