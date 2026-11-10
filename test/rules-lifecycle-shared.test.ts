/**
 * @file test/rules-lifecycle-shared.test.ts
 * @description In-process replacement for the `llmwiki rules …` cases in
 * `test/rules-integration.test.ts` (spec S5, group 2).
 *
 * ## Which rules modules survive, verified rather than assumed
 *
 * The brief named `compiler/rule-candidates.ts`, `compiler/rule-extractor.ts`
 * and `export/rule-candidates-json.ts` and asked for that to be checked before
 * anything was ported. The first two hold: `compiler/rule-candidates.ts` is
 * imported by `compiler/rule-extractor.ts`, and `compiler/rule-extractor.ts` is
 * imported (type-only) by `dimensions/wiki/source-documents-store.ts`.
 *
 * `export/rule-candidates-json.ts` was WITHDRAWN afterwards, and the cases below
 * were trimmed with it. It was reachable only from `commands/rules.ts`: once the
 * CLI left, its only importer was this file, which is exactly the shape the
 * reachability audit rules out — a module kept alive by the test written to cover
 * it. The capability is gone from the product (no surviving entry exports rule
 * candidates), so covering its serializer would be coverage for an orchestrator
 * that no longer exists. Reported as a coverage note, not ported.
 *
 * What remains below is the lifecycle that still has a production referent — the
 * pending-candidate store — plus the provider guard extraction depends on.
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
import {
  archiveRuleCandidate,
  readRuleCandidate,
  setRuleCandidateStatus,
} from "../packages/wiki/src/compiler/rule-candidates.js";
import { candidateFileId } from "../packages/wiki/src/utils/candidate-store.js";
import { ensureProviderAvailable } from "../packages/wiki/src/utils/provider-guard.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { useStackEnv } from "./fixtures/stack-env.js";
import { restoreProviderEnvAfterEach } from "./fixtures/rule-extraction.js";

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
    expect(await pendingFiles(ctx.dir)).toEqual([]);
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
