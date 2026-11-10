/**
 * @file test/rules-lifecycle-shared.test.ts
 * @description In-process replacement for the `llmwiki rules …` cases in
 * `test/rules-integration.test.ts` (spec S5, group 2).
 *
 * ## Which rules modules survive, verified rather than assumed
 *
 * The brief named `compiler/rule-candidates.ts`, `compiler/rule-extractor.ts`
 * and `export/rule-candidates-json.ts` and asked for that to be checked before
 * anything was ported. It holds, by import graph and not by name:
 *
 *   - `compiler/rule-candidates.ts` is imported by `export/rule-candidates-json.ts`.
 *   - `compiler/rule-extractor.ts` is imported (type-only) by
 *     `dimensions/wiki/source-documents-store.ts`.
 *   - `export/rule-candidates-json.ts` declares the export scope set and the
 *     serializer; `commands/rules.ts` was only ever the argv shell around them.
 *
 * So the lifecycle — list, mutate, export, extract — has a shared referent for
 * everything except its argv surface, and each case below asserts the shared
 * behaviour the command used to wire up.
 *
 * ## What is deliberately NOT ported
 *
 * `rules`, three subcommand names, `--scope`, the `rules` action names, exit
 * codes, and the two rendered sentences (`No pending rule candidates.`,
 * `Rule candidate not found: …`) live in `commands/rules.ts` and die with it.
 * `rules export --scope bogus` is argv validation whose whole implementation —
 * `resolveScope` — is a deleted private function; the scope SET survives, but a
 * set is not a validation, so that case is reported ENTRY-ONLY rather than
 * dressed up as a port.
 */

import { describe, it, expect } from "vitest";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractRuleCandidates } from "../packages/wiki/src/compiler/rule-extractor.js";
import {
  archiveRuleCandidate,
  readRuleCandidate,
  setRuleCandidateStatus,
} from "../packages/wiki/src/compiler/rule-candidates.js";
import {
  buildRuleCandidatesJson,
  collectRuleCandidatesForExport,
} from "../packages/wiki/src/export/rule-candidates-json.js";
import { candidateFileId } from "../packages/wiki/src/utils/candidate-store.js";
import { ensureProviderAvailable } from "../packages/wiki/src/utils/provider-guard.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { useStackEnv } from "./fixtures/stack-env.js";
import {
  restoreProviderEnvAfterEach,
  seedRuleSource,
  stubRuleExtraction,
} from "./fixtures/rule-extraction.js";
import type { RuleCandidate } from "../packages/wiki/src/utils/rule-types.js";

/** Fixed clock so the persisted records are deterministic. */
const FIXED_NOW = "2026-05-31T00:00:00.000Z";

/** Pending candidates live here for a Stack-backed project. */
const CANDIDATE_DIR = path.join(".llmwiki", "rule-candidates");

/** An id no candidate could carry; the fileId derivation still has to be safe. */
const MISSING_ID = "rulecand.x.does-not-exist";

/** A settings path that cannot exist, so a host key is never picked up. */
const ABSENT_CLAUDE_SETTINGS = path.join(tmpdir(), "llmwiki-nonexistent-claude-settings.json");

restoreProviderEnvAfterEach();
useStackEnv("rules-lifecycle-shared");

/** The candidate ids currently sitting in the pending directory. */
async function pendingFiles(root: string): Promise<string[]> {
  try {
    return await readdir(path.join(root, CANDIDATE_DIR));
  } catch {
    return [];
  }
}

describe("listing the pending queue", () => {
  const ctx = useTempRoot(["sources"]);

  it("reports no pending candidates for a project that has none", async () => {
    expect(await collectRuleCandidatesForExport(ctx.dir, "proposed")).toEqual([]);
    expect(await pendingFiles(ctx.dir)).toEqual([]);
  });
});

describe("mutating an id no candidate carries", () => {
  const ctx = useTempRoot(["sources"]);
  const fileId = candidateFileId(MISSING_ID);

  it("refuses to flip a status and writes no candidate file", async () => {
    expect(await setRuleCandidateStatus(ctx.dir, fileId, "approved")).toBeNull();
    expect(await readRuleCandidate(ctx.dir, fileId)).toBeNull();
    expect(await pendingFiles(ctx.dir)).toEqual([]);
  });

  it("archives nothing and leaves the queue empty", async () => {
    expect(await archiveRuleCandidate(ctx.dir, fileId)).toBe(false);
    expect(await collectRuleCandidatesForExport(ctx.dir, "all")).toEqual([]);
  });
});

describe("exporting the approved scope", () => {
  const ctx = useTempRoot(["sources"]);

  it("emits exactly one approved record with the importer's field names", async () => {
    await seedRuleSource(ctx.dir);
    await stubRuleExtraction();
    const { candidates } = await extractRuleCandidates(ctx.dir, FIXED_NOW);
    await setRuleCandidateStatus(ctx.dir, candidateFileId(candidates[0]!.id), "approved");

    const approved = await collectRuleCandidatesForExport(ctx.dir, "approved");
    expect(approved).toHaveLength(1);
    const parsed = JSON.parse(buildRuleCandidatesJson(approved)) as RuleCandidate[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(candidates[0]!.id);
    expect(parsed[0]!.status).toBe("approved");
  });

  it("excludes a still-proposed candidate from the approved scope", async () => {
    await seedRuleSource(ctx.dir);
    await stubRuleExtraction();
    await extractRuleCandidates(ctx.dir, FIXED_NOW);

    expect(await collectRuleCandidatesForExport(ctx.dir, "approved")).toEqual([]);
    expect(await collectRuleCandidatesForExport(ctx.dir, "proposed")).toHaveLength(1);
  });
});

describe("extraction requires a usable provider", () => {
  it("refuses with the provider named, before any extraction runs", () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.ANTHROPIC_AUTH_TOKEN = "";
    process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = ABSENT_CLAUDE_SETTINGS;
    try {
      expect(() => ensureProviderAvailable()).toThrow(
        'Anthropic credentials are required for the "anthropic" provider.',
      );
    } finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.LLMWIKI_CLAUDE_SETTINGS_PATH;
    }
  });
});
