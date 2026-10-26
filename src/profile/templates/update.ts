/**
 * @file src/profile/templates/update.ts
 * @description Read-only compatibility planning for template profile updates.
 * It never writes and treats every unverifiable profile-owned store as unsafe.
 */
import canonicalize from "canonicalize";
import { diffProfiles, type PageDisposition, type ProfileDiffReport } from "../diff.js";
import { profileDigest } from "../digest.js";
import { loadProfile } from "../load.js";
import { lintProfileEntities } from "../lint.js";
import type { ProfilePack } from "../types.js";
import type { ProfileTemplatePackage } from "./types.js";
import { firstFileUnder } from "./corpus.js";
import { auditArtifactStore } from "./artifact-audit.js";
import { auditCandidateArchive, auditCandidateStore, auditWorkflowHistory } from "./history-audit.js";
import { readTemplateLock } from "./lock.js";
import { getBuiltinTemplate, getBuiltinTemplateRelease } from "./registry.js";


/** One structured refusal reason from the corpus-wide compatibility audit. */
export interface TemplateUpdateReason {
  kind: "drift" | "page" | "lint" | "candidate" | "workflow" | "artifact" | "store";
  message: string;
  path?: string;
}

/**
 * Complete advisory dry-run result. `compatible` describes this read snapshot;
 * it cannot authorize a later write because project state may change afterward.
 */
export interface TemplateUpdatePlan {
  schemaVersion: 1;
  authority: "advisory";
  compatible: boolean;
  from: string;
  to: string;
  oldProfileDigest: string;
  newProfileDigest: string;
  diff: ProfileDiffReport;
  reasons: TemplateUpdateReason[];
}

/** Plan a builtin update using an independently resolved installed release. */
async function planBuiltinTemplateUpdate(root: string, requestedId?: string): Promise<TemplateUpdatePlan> {
  const lockRead = await readTemplateLock(root);
  if (lockRead.kind !== "ok") throw new Error(`cannot plan update: template provenance is ${lockRead.kind}`);
  const lock = lockRead.lock;
  if (lock.sourceType !== "builtin") throw new Error("R1 update dry-run supports builtin installs only");
  const base = getBuiltinTemplateRelease(lock.templateId, lock.version, lock.publisher);
  if (!base) {
    throw new Error(`cannot independently resolve installed builtin ${lock.templateId}@${lock.version}`);
  }
  const candidateId = requestedId ?? lock.templateId;
  if (candidateId !== lock.templateId) throw new Error("template update cannot change template identity");
  const candidate = getBuiltinTemplate(candidateId);
  if (!candidate) throw new Error(`unknown builtin template: ${candidateId}`);
  return planTemplateUpdate(root, (await loadProfile(root)).profile, base, candidate);
}

/** Plan an update from independently verified base and candidate packages. */
export async function planTemplateUpdate(
  root: string,
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): Promise<TemplateUpdatePlan> {
  assertUpdateIdentity(active, base, candidate);
  const reasons: TemplateUpdateReason[] = [];
  const activeDigest = profileDigest(active);
  const baseDigest = profileDigest(base.profile);
  if (activeDigest !== baseDigest) reasons.push({ kind: "drift", message: "active profile has local modifications" });
  const diff = await diffProfiles(root, active, candidate.profile);
  reasons.push(...diffReasons(diff));
  reasons.push(...await lintReasons(root, candidate.profile));
  reasons.push(...await candidateReasons(root));
  reasons.push(...await workflowReasons(root));
  reasons.push(...await artifactReasons(root, active, candidate.profile));
  return {
    schemaVersion: 1,
    authority: "advisory",
    compatible: reasons.length === 0,
    from: `${base.templateId}@${base.version}`,
    to: `${candidate.templateId}@${candidate.version}`,
    oldProfileDigest: activeDigest,
    newProfileDigest: profileDigest(candidate.profile),
    diff,
    reasons,
  };
}

function assertUpdateIdentity(
  active: ProfilePack,
  base: ProfileTemplatePackage,
  candidate: ProfileTemplatePackage,
): void {
  if (base.templateId !== candidate.templateId) throw new Error("template update cannot change template identity");
  if (base.publisher !== candidate.publisher) throw new Error("template update cannot change publisher identity");
  if (base.sourceType !== candidate.sourceType) throw new Error("template update cannot change source identity");
  if (active.profileId !== base.profile.profileId || candidate.profile.profileId !== base.profile.profileId) {
    throw new Error("template update cannot change profile identity");
  }
}

function diffReasons(diff: ProfileDiffReport): TemplateUpdateReason[] {
  const reasons: TemplateUpdateReason[] = diff.problems.map((problem) => ({ kind: "store", message: problem.message, path: problem.directory }));
  for (const page of diff.pages) {
    if (isSafeDisposition(page)) continue;
    reasons.push({ kind: "page", message: `page is ${page.disposition}`, path: `${page.directory}/${page.stem}.md` });
  }
  return reasons;
}

function isSafeDisposition(page: PageDisposition): boolean {
  return page.disposition === "unchanged" || page.disposition === "newly-supported";
}

async function lintReasons(root: string, profile: ProfilePack): Promise<TemplateUpdateReason[]> {
  try {
    const findings = await lintProfileEntities(root, profile);
    return findings
      .filter((finding) => !isContentOnlyFinding(finding.rule))
      .map((finding) => ({ kind: "lint", message: `${finding.rule}: ${finding.message}`, path: finding.file }));
  } catch (error) {
    return [{ kind: "store", message: `candidate-profile validation is unavailable: ${errorMessage(error)}` }];
  }
}

function isContentOnlyFinding(rule: string): boolean {
  return rule === "empty-page" || rule === "malformed-claim-citation" || rule === "low-confidence";
}

/**
 * Reasons the pending candidate queue blocks a template update.
 *
 * The gate is "is anything still pending", and the archive is a separate integrity
 * question. Both are asked through the audit module so the backend decision lives in
 * one place instead of being re-derived here from a directory walk.
 *
 * @param root - Project root, used by the file backend.
 * @returns One reason per blocked condition.
 */
async function candidateReasons(root: string): Promise<TemplateUpdateReason[]> {
  const pending = (await auditCandidateStore(root)).map(classifyStoreReason);
  const archived = (await auditCandidateArchive(root)).map((message) => ({ kind: "store" as const, message }));
  return [...pending, ...archived];
}

/**
 * Label one candidate-store finding as a queue entry or a store fault.
 *
 * The distinction is the caller's: a pending candidate is something a human must
 * resolve (`candidate`), while an unresolvable store is a fault in the store itself
 * (`store`). Collapsing them would tell an operator to review a queue whose contents
 * are unknown, which is the one thing they cannot safely do.
 *
 * @param message - The finding the audit produced.
 * @returns The reason, labelled.
 */
function classifyStoreReason(message: string): TemplateUpdateReason {
  const isQueueEntry = /pending review candidates/i.test(message);
  return { kind: isQueueEntry ? "candidate" : "store", message };
}

async function workflowReasons(root: string): Promise<TemplateUpdateReason[]> {
  return auditWorkflowHistory(root);
}

async function artifactReasons(root: string, active: ProfilePack, candidate: ProfilePack): Promise<TemplateUpdateReason[]> {
  const audit = (await auditArtifactStore(root, candidate)).map((message) => ({ kind: "artifact" as const, message }));
  if (canonicalize(active.artifacts ?? {}) === canonicalize(candidate.artifacts ?? {})) return audit;
  const state = await firstFileUnder(root, "artifacts");
  if (state === "unavailable") return [...audit, { kind: "store", message: "artifact store is unreadable or unsafe" }];
  if (state === "present") return [...audit, { kind: "artifact", message: "artifact contracts changed while stored artifacts exist" }];
  return audit;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
