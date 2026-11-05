/**
 * @file test/mcp/ambient-state-isolation.test.ts
 * @description A named Stack's answer must not carry the ambient deployment's compile state.
 *
 * ## The defect this pins
 *
 * `wiki_status` resolved its page corpus and its source corpus from the `stackId`
 * argument, and its COMPILE STATE from `process.env`: `collectStatus` called
 * `readStateClassifiedFor(root)` with no environment, so `sources`,
 * `lastCompiledAt` and `pendingChanges` came from whichever Stack the process was
 * bound to. The measured symptom was one object built from two deployments —
 * `pages: { total: 0 }` for the Stack that was asked about, beside `sources: 2`, a
 * `lastCompiledAt`, and `pendingChanges` naming files of a wiki nobody named.
 *
 * ## Why the two fixtures disagree in every field
 *
 * A test that gives both Stacks the same shape keeps passing while the leak is open,
 * because the wrong answer and the right one are identical. Each Stack here carries a
 * different page count, a different source count, a different compile time and a
 * different pending change, so every field answered from the ambient deployment is
 * visible in an assertion.
 *
 * ## Why the tool is driven through the registered handler
 *
 * `collectStatus` takes its seams as an option, so calling it directly would test the
 * option plumbing and never the wiring an MCP caller hits. The defect lived in that
 * wiring, not in the collector.
 *
 * ## Why the project root has no `wiki/` and no `sources/` files
 *
 * Every number the tool reports has to come from rows. A populated checkout would let
 * a disk read answer where the leak made the ambient Stack answer, and the test would
 * pass for a reason unrelated to what it measures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPageWriteSink } from "../../src/dimensions/wiki/page-write-sink.js";
import { saveStoredCandidate } from "../../src/dimensions/wiki/candidate-store.js";
import {
  hashSourceContent,
  saveSourceDocument,
  stableSourceContent,
} from "../../src/dimensions/wiki/source-documents-store.js";
import { writeWikiStateToRows } from "../../src/dimensions/wiki/wiki-state-source.js";
import type { WikiState } from "../../src/utils/types.js";
import { buildServer, callTool } from "../fixtures/mcp-test-env.js";
import { createProbeStack } from "../dimensions/harness-lifecycle.js";
import type { ProbeStack } from "../dimensions/harness-lifecycle.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";

/** Compile time recorded for the Stack the call NAMES. */
const NAMED_COMPILED_AT = "2026-02-02T10:00:00.000Z";
/** Compile time recorded for the Stack the process is BOUND to. */
const BOUND_COMPILED_AT = "2025-01-01T01:00:00.000Z";
/** The one source identity only the named Stack contains. */
const NAMED_IDENTITY = "https://named.test/alpha";
/** The two identities only the bound Stack contains. */
const BOUND_IDENTITIES = ["https://bound.test/one", "https://bound.test/two"] as const;
/** Page counts differ too, so `pages.total` discriminates as well. */
const NAMED_SLUGS = ["named-page", "second-named-page"] as const;
/** A single page, so "the other Stack's count" is never mistaken for this one's. */
const BOUND_SLUGS = ["bound-page"] as const;

/** One Stack's rows, described so both fixtures differ in every reported field. */
interface StackShape {
  slugs: readonly string[];
  identities: readonly string[];
  compiledAt: string;
  /** True when the recorded hash matches the stored document, so nothing is pending. */
  compiledAlready: boolean;
  /** Review candidates waiting for approval; a field the pack and the status both report. */
  candidates: number;
}

/** The document text a Stack stores for one identity. */
function documentFor(identity: string): string {
  return `${identity} body\n`;
}

/** Build the compile state a Stack's rows carry for its identities. */
function stateFor(shape: StackShape): WikiState {
  const sources: WikiState["sources"] = {};
  for (const identity of shape.identities) {
    sources[identity] = {
      // A recorded hash from an EARLIER run is what makes the source "changed"; the
      // matching hash is what makes the Stack's pending list empty.
      hash: shape.compiledAlready
        ? hashSourceContent(stableSourceContent(documentFor(identity)))
        : "hash-recorded-by-an-earlier-compile",
      // Ownership is what makes a page classify as stale or fresh: a slug no source
      // owns is `unverified`, which is indistinguishable from "nobody compiled this".
      concepts: [...shape.slugs],
      compiledAt: shape.compiledAt,
      source: identity,
    };
  }
  return { version: 2, indexHash: "", sources };
}

/** Write one Stack's page rows, source rows and compile state. */
async function seedStack(stack: ProbeStack, shape: StackShape): Promise<void> {
  const sink = createPageWriteSink(stack.harness.db, stack.harness.stackId);
  for (const slug of shape.slugs) {
    await sink({
      directory: "concepts",
      slug,
      body: `---\ntitle: ${slug}\nsummary: s\n---\n\n${slug} body\n`,
    });
  }
  for (const identity of shape.identities) {
    await saveSourceDocument(stack.harness.db, stack.harness.stackId, {
      title: identity,
      source: identity,
      document: documentFor(identity),
    });
  }
  await writeWikiStateToRows(stack.harness.db, stack.harness.stackId, stateFor(shape));
  for (let index = 0; index < shape.candidates; index++) {
    await saveStoredCandidate(stack.harness.db, stack.harness.stackId, {
      id: `candidate-${index}`,
      title: `Candidate ${index}`,
      slug: `candidate-${index}`,
      summary: "s",
      sources: [],
      body: "body",
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "policy",
      heldReasons: [],
    });
  }
}

/** The fields of the `wiki_status` payload this suite answers about. */
interface StatusPayload {
  pages: { concepts: number; queries: number; total: number };
  sources: number;
  lastCompiledAt: string | null;
  pendingCandidates: number;
  pendingChanges: Array<{ file: string; status: string }>;
}

/** Call the registered `wiki_status` tool and decode its payload. */
async function statusFor(server: McpServer, stackId: string): Promise<StatusPayload> {
  const result = await callTool(server, "wiki_status", { stackId });
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text) as StatusPayload;
}

/** The prompt the pack is asked about: it matches the NAMED Stack's pages only. */
const PACK_PROMPT = "named";

/** The fields of the `get_context_pack` payload this suite answers about. */
interface PackPayload {
  project: { root: string | null; pages: number; pendingCandidates: number };
  primary: Array<{ id: string; freshnessStatus: string }>;
  warnings: Array<{ code: string; message: string }>;
}

/** Call the registered `get_context_pack` tool and decode its payload. */
async function packFor(server: McpServer, stackId: string): Promise<PackPayload> {
  const result = await callTool(server, "get_context_pack", { prompt: PACK_PROMPT, stackId });
  return JSON.parse(result.content[0]?.text ?? "{}") as PackPayload;
}

describe("a named Stack's answer never carries the ambient deployment's state", () => {
  let named: ProbeStack;
  let bound: ProbeStack;
  let root: string;
  let server: McpServer;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    named = await createProbeStack("ambient-named");
    bound = await createProbeStack("ambient-bound");
    saved = { ...process.env };
    root = await scratchProjectRoot("ambient-state-");
    // `collectProjectState` only consults the review queue when the internal
    // directory exists, so the pack fixture has to be shaped like a real project.
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    server = buildServer(root);
  });

  afterEach(async () => {
    process.env = saved;
    await named.harness.cleanup();
    await bound.harness.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  /** Seed both Stacks; false when the database is unreachable, as the suite convention skips. */
  async function seedBoth(): Promise<boolean> {
    if (!named.harness.reachable || !bound.harness.reachable) return false;
    await seedStack(named, {
      slugs: NAMED_SLUGS,
      identities: [NAMED_IDENTITY],
      compiledAt: NAMED_COMPILED_AT,
      compiledAlready: false,
      candidates: 1,
    });
    await seedStack(bound, {
      slugs: BOUND_SLUGS,
      identities: BOUND_IDENTITIES,
      compiledAt: BOUND_COMPILED_AT,
      compiledAlready: true,
      candidates: 0,
    });
    return true;
  }

  it("answers about the named Stack while a different Stack is bound ambiently", async () => {
    if (!(await seedBoth())) return;
    // The process serves the OTHER Stack. The call names `named`.
    process.env.AKS_STACK_ID = bound.harness.stackId;

    const status = await statusFor(server, named.harness.stackId);

    expect(status.pages.total).toBe(NAMED_SLUGS.length);
    expect(status.sources).toBe(1);
    expect(status.lastCompiledAt).toBe(NAMED_COMPILED_AT);
    expect(status.pendingChanges).toEqual([{ file: NAMED_IDENTITY, status: "changed" }]);
    // The review queue is part of the same answer: `countCandidates` read the
    // AMBIENT environment too, so a named Stack's status reported the bound
    // deployment's queue length.
    expect(status.pendingCandidates).toBe(1);
  });

  it("answers a deployment bound to that same Stack exactly as before", async () => {
    if (!(await seedBoth())) return;
    process.env.AKS_STACK_ID = bound.harness.stackId;
    const withAmbientLeak = await statusFor(server, named.harness.stackId);

    // The single-Stack deployment, which is every deployment that worked before:
    // the ambient environment names the Stack the call names.
    process.env.AKS_STACK_ID = named.harness.stackId;
    const withAmbientAgreement = await statusFor(server, named.harness.stackId);

    // Deep equality, not a field list: an answer that gains or loses a field when the
    // ambient environment agrees would be a regression this control has to catch.
    expect(withAmbientAgreement).toEqual(withAmbientLeak);
    expect(withAmbientAgreement.sources).toBe(1);
  });

  it("builds get_context_pack from the named Stack while another is bound", async () => {
    if (!(await seedBoth())) return;
    process.env.AKS_STACK_ID = bound.harness.stackId;

    const pack = await packFor(server, named.harness.stackId);

    // `project.pages` counts the viewer snapshot's page list, which was read from the
    // AMBIENT page source; `pendingCandidates` came from the ambient review queue.
    expect(pack.project.pages).toBe(NAMED_SLUGS.length);
    expect(pack.project.pendingCandidates).toBe(1);
    expect(pack.project.root).toBe(root);
    const ownIds = new Set(NAMED_SLUGS.map((slug) => `concepts/${slug}`));
    expect(pack.primary.length).toBeGreaterThan(0);
    expect(pack.primary.every((page) => ownIds.has(page.id))).toBe(true);
    // Freshness is computed against the compile state, so a page owned by a source
    // that changed since the recorded hash must read `stale` -- never the bound
    // deployment's `fresh`.
    expect(pack.primary.map((page) => page.freshnessStatus)).toEqual(
      pack.primary.map(() => "stale"),
    );
    expect(pack.warnings.map((warning) => warning.code)).toContain("pending-candidates");
    // Nothing from the bound deployment anywhere in the payload, including text.
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("bound-page");
    expect(serialized).not.toContain("bound.test");
  });

  it("builds the same pack when the ambient environment names that Stack", async () => {
    if (!(await seedBoth())) return;
    process.env.AKS_STACK_ID = bound.harness.stackId;
    const withAmbientLeak = await packFor(server, named.harness.stackId);

    process.env.AKS_STACK_ID = named.harness.stackId;
    const withAmbientAgreement = await packFor(server, named.harness.stackId);

    expect(withAmbientAgreement).toEqual(withAmbientLeak);
    expect(withAmbientAgreement.project.pages).toBe(NAMED_SLUGS.length);
  });
});
