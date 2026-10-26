/**
 * @file src/dimensions/wiki/candidate-store.ts
 * @description Pending review candidates as rows, one Stack at a time.
 *
 * ## What makes this simpler than the file store it replaces
 *
 * `.llmwiki/candidates/<id>.json` needed `candidate-custody.ts` — 483 lines that bind
 * a directory's `dev`/`ino`, refuse a symlinked leaf, detect parent drift and fail
 * closed on a cross-device rename. A row has no inode and no parent directory, so
 * every one of those properties holds BY CONSTRUCTION. The module is not ported; it
 * becomes unnecessary for this store.
 *
 * ## What it FIXES
 *
 * The file store was scoped to a checkout, so two hosts reviewing one Stack kept two
 * queues and neither could see the other's candidates. A reviewer on host A could
 * approve work host B had already superseded.
 *
 * ## Why the shape maps almost one-to-one
 *
 * `ReviewCandidate` is a serialized JSON document, and the columns follow it closely
 * on purpose: the reader, the CLI and the approver all consume that interface, so a
 * column layout that required translation at every boundary would be a second shape
 * to keep in sync. The two places that do NOT map directly are documented on the
 * mapper.
 */

import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import type { ReviewCandidate } from "../../utils/types.js";
import { toArrayLiteral } from "./sql-array.js";

/** The handle shape these queries need. */
type StoreHandle = Parameters<typeof insertCandidate>[0];

/** One `review_candidates` row as Postgres returns it. */
interface CandidateRow extends Record<string, unknown> {
  readonly candidate_id: string;
  readonly target_directory: string;
  readonly target_entity_type: string | null;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly body: string;
  readonly sources: string[] | null;
  readonly generated_at: string | Date;
  readonly review_mode: string;
  readonly held_reasons: unknown;
  readonly trust_decision: string | null;
  readonly expected_target_hash: string | null;
  readonly expect_target_absent: boolean;
  readonly source_states: unknown;
  readonly prompt_modifiers: string | null;
  readonly schema_violations: unknown;
  readonly provenance_violations: unknown;
  readonly okf_path: string | null;
  readonly candidate_kind: unknown;
  readonly citation_manifest: unknown;
  readonly connector_provenance: unknown;
  readonly confidence: number | null;
  readonly contradicted: boolean | null;
}

/**
 * Reassemble a `ReviewCandidate` from a row.
 *
 * ## The two mappings that are not mechanical
 *
 * 1. **Absent optional fields stay absent.** The interface distinguishes an absent
 *    `trustDecision` from an empty one, and `review show` prints them differently.
 *    Each optional column is therefore spread conditionally rather than assigned as
 *    `undefined`, which under `exactOptionalPropertyTypes` is not the same thing.
 * 2. **`expectTargetAbsent` is a real boolean column, not an optional one.** The
 *    interface omits it when false; a row stores false. It is therefore only spread
 *    back onto the object when TRUE, so a round trip preserves the omission.
 *
 * @param row - A `review_candidates` row.
 * @returns The equivalent candidate.
 */
function toCandidate(row: CandidateRow): ReviewCandidate {
  return {
    id: row.candidate_id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    body: row.body,
    sources: row.sources ?? [],
    generatedAt: toIsoString(row.generated_at),
    reviewMode: row.review_mode as ReviewCandidate["reviewMode"],
    heldReasons: (row.held_reasons ?? []) as ReviewCandidate["heldReasons"],
    targetDirectory: row.target_directory as ReviewCandidate["targetDirectory"],
    ...optionalFieldsOf(row),
  };
}

/** A stored timestamp as the ISO string the interface carries. */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Every OPTIONAL candidate field, present only when the row carries it.
 *
 * ## Why absence matters here
 *
 * `ReviewCandidate` distinguishes an absent optional from an empty one, and
 * `review show` prints them differently. Each field is therefore spread only when
 * the column is non-null — assigning `undefined` would create the key, which under
 * `exactOptionalPropertyTypes` is not the same thing as omitting it.
 *
 * Split out of {@link toCandidate} because twelve conditional spreads in one object
 * literal is a function nobody can read at a glance, and `fallow` measured it as such.
 *
 * @param row - A `review_candidates` row.
 * @returns Only the optional fields this row actually holds.
 */
function optionalFieldsOf(row: CandidateRow): Partial<ReviewCandidate> {
  return { ...identityFieldsOf(row), ...payloadFieldsOf(row) };
}

/**
 * The optional fields that describe WHERE an approved page would land.
 *
 * Split from {@link payloadFieldsOf} so each half stays a short list a reviewer can
 * check against the interface at a glance.
 *
 * @param row - A `review_candidates` row.
 * @returns The routing-related optional fields this row holds.
 */
function identityFieldsOf(row: CandidateRow): Partial<ReviewCandidate> {
  return {
    ...(row.target_entity_type === null ? {} : { targetEntityType: row.target_entity_type }),
    ...(row.trust_decision === null
      ? {}
      : { trustDecision: row.trust_decision as ReviewCandidate["trustDecision"] }),
    ...(row.expected_target_hash === null ? {} : { expectedTargetHash: row.expected_target_hash }),
    // Only spread when TRUE: the interface omits the flag when false, and a round
    // trip must preserve the omission rather than materialise `false`.
    ...(row.expect_target_absent ? { expectTargetAbsent: true } : {}),
    ...(row.okf_path === null ? {} : { okfPath: row.okf_path }),
  };
}

/**
 * The optional fields that carry generation-time evidence and compile bookkeeping.
 *
 * @param row - A `review_candidates` row.
 * @returns The evidence-related optional fields this row holds.
 */
function payloadFieldsOf(row: CandidateRow): Partial<ReviewCandidate> {
  return { ...compileBookkeepingOf(row), ...generationEvidenceOf(row) };
}

/**
 * The compile bookkeeping a candidate carries, present only when the row holds it.
 *
 * Split out because ten conditional spreads in one literal is unreadable and
 * `fallow` measured it as such -- the same reason `identityFieldsOf` exists.
 *
 * @param row - A `review_candidates` row.
 * @returns The bookkeeping fields this row holds.
 */
function compileBookkeepingOf(row: CandidateRow): Partial<ReviewCandidate> {
  return {
    ...(row.source_states === null
      ? {}
      : { sourceStates: row.source_states as ReviewCandidate["sourceStates"] }),
    ...(row.prompt_modifiers === null ? {} : { promptModifiers: row.prompt_modifiers }),
  };
}

/**
 * The generation-time evidence a candidate carries, present only when the row holds it.
 *
 * @param row - A `review_candidates` row.
 * @returns The evidence fields this row holds.
 */
function generationEvidenceOf(row: CandidateRow): Partial<ReviewCandidate> {
  return {
    ...(row.schema_violations === null
      ? {}
      : { schemaViolations: row.schema_violations as ReviewCandidate["schemaViolations"] }),
    ...(row.provenance_violations === null
      ? {}
      : { provenanceViolations: row.provenance_violations as ReviewCandidate["provenanceViolations"] }),
    ...(row.candidate_kind === null
      ? {}
      : { candidateKind: row.candidate_kind as ReviewCandidate["candidateKind"] }),
    ...(row.citation_manifest === null
      ? {}
      : { citationManifest: row.citation_manifest as ReviewCandidate["citationManifest"] }),
    ...(row.connector_provenance === null
      ? {}
      : { connectorProvenance: row.connector_provenance as ReviewCandidate["connectorProvenance"] }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    // THREE states, not two: `review show` prints `contradicted: false` when the
    // generator explicitly said "not contradicted" and prints nothing when the
    // field was absent. A nullable column carries that distinction; a
    // not-null-default-false one would collapse it.
    ...(row.contradicted === null ? {} : { contradicted: row.contradicted }),
  };
}

/**
 * List one Stack's pending candidates, newest first.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose queue to read.
 * @returns The candidates, newest first.
 */
export async function listStoredCandidates(db: StoreHandle, stackId: string): Promise<ReviewCandidate[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<CandidateRow>(sql`
      select candidate_id, target_directory, target_entity_type, title, slug, summary,
             body, sources, generated_at, review_mode, held_reasons, trust_decision,
             expected_target_hash, expect_target_absent, source_states,
             prompt_modifiers, schema_violations, provenance_violations, okf_path,
             candidate_kind, citation_manifest, connector_provenance, confidence, contradicted
      from wiki.review_candidates
      where stack_id = ${stackId}
      order by generated_at desc, candidate_id asc
    `);
    return rows.map(toCandidate);
  });
}

/**
 * Read one candidate by id, or undefined when this Stack has no such candidate.
 *
 * @param db - Database handle.
 * @param stackId - The Stack whose candidate to read.
 * @param candidateId - The candidate's stable identifier.
 * @returns The candidate, or undefined.
 */
export async function getStoredCandidate(
  db: StoreHandle,
  stackId: string,
  candidateId: string,
): Promise<ReviewCandidate | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const rows = await tx.execute<CandidateRow>(sql`
      select candidate_id, target_directory, target_entity_type, title, slug, summary,
             body, sources, generated_at, review_mode, held_reasons, trust_decision,
             expected_target_hash, expect_target_absent, source_states,
             prompt_modifiers, schema_violations, provenance_violations, okf_path,
             candidate_kind, citation_manifest, connector_provenance, confidence, contradicted
      from wiki.review_candidates
      where stack_id = ${stackId} and candidate_id = ${candidateId}
    `);
    const row = rows[0];
    return row === undefined ? undefined : toCandidate(row);
  });
}

/**
 * Store one candidate, replacing any candidate with the same id.
 *
 * Upsert rather than insert: a candidate is re-persisted when its review metadata
 * changes, and that must update the existing entry rather than fail on the key.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the candidate.
 * @param candidate - The candidate to store.
 */
async function insertCandidate(
  db: Database,
  stackId: string,
  candidate: ReviewCandidate,
): Promise<void> {
  const v = toInsertValues(stackId, candidate);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    await tx.execute(sql`
      insert into wiki.review_candidates (
        stack_id, candidate_id, target_directory, target_entity_type, title, slug,
        summary, body, sources, generated_at, review_mode, held_reasons,
        trust_decision, expected_target_hash, expect_target_absent, source_states,
        prompt_modifiers, schema_violations, provenance_violations, okf_path,
        candidate_kind, citation_manifest, connector_provenance, confidence, contradicted
      ) values (
        ${v.stackId}, ${v.candidateId}, ${v.targetDirectory}, ${v.targetEntityType},
        ${v.title}, ${v.slug}, ${v.summary}, ${v.body}, ${v.sources}::text[],
        ${v.generatedAt}::timestamptz, ${v.reviewMode}, ${v.heldReasons}::jsonb,
        ${v.trustDecision}, ${v.expectedTargetHash}, ${v.expectTargetAbsent},
        ${v.sourceStates}::jsonb, ${v.promptModifiers}, ${v.schemaViolations}::jsonb,
        ${v.provenanceViolations}::jsonb, ${v.okfPath},
        ${v.candidateKind}::jsonb, ${v.citationManifest}::jsonb,
        ${v.connectorProvenance}::jsonb, ${v.confidence}, ${v.contradicted}
      )
      on conflict (stack_id, candidate_id) do update set
        target_directory = excluded.target_directory,
        target_entity_type = excluded.target_entity_type,
        title = excluded.title,
        slug = excluded.slug,
        summary = excluded.summary,
        body = excluded.body,
        sources = excluded.sources,
        generated_at = excluded.generated_at,
        review_mode = excluded.review_mode,
        held_reasons = excluded.held_reasons,
        trust_decision = excluded.trust_decision,
        expected_target_hash = excluded.expected_target_hash,
        expect_target_absent = excluded.expect_target_absent,
        source_states = excluded.source_states,
        prompt_modifiers = excluded.prompt_modifiers,
        schema_violations = excluded.schema_violations,
        provenance_violations = excluded.provenance_violations,
        okf_path = excluded.okf_path,
        candidate_kind = excluded.candidate_kind,
        citation_manifest = excluded.citation_manifest,
        connector_provenance = excluded.connector_provenance,
        confidence = excluded.confidence,
        contradicted = excluded.contradicted
    `);
  });
}

/**
 * Flatten a candidate into the exact parameter values the insert binds.
 *
 * The JSON columns are stringified here rather than inside the statement, so the
 * query stays a static shape and the one place that decides "absent becomes NULL"
 * is readable on its own.
 *
 * @param stackId - The Stack that owns the candidate.
 * @param c - The candidate to store.
 * @returns Every bound value, ready to interpolate.
 */
function toInsertValues(stackId: string, c: ReviewCandidate) {
  const json = (value: unknown): string | null =>
    value === undefined ? null : JSON.stringify(value);
  return {
    stackId,
    candidateId: c.id,
    targetDirectory: c.targetDirectory ?? "concepts",
    targetEntityType: c.targetEntityType ?? null,
    title: c.title,
    slug: c.slug,
    summary: c.summary,
    body: c.body,
    sources: toArrayLiteral(c.sources),
    generatedAt: c.generatedAt,
    reviewMode: c.reviewMode,
    heldReasons: JSON.stringify(c.heldReasons),
    trustDecision: c.trustDecision ?? null,
    expectedTargetHash: c.expectedTargetHash ?? null,
    expectTargetAbsent: c.expectTargetAbsent === true,
    sourceStates: json(c.sourceStates),
    promptModifiers: c.promptModifiers ?? null,
    schemaViolations: json(c.schemaViolations),
    provenanceViolations: json(c.provenanceViolations),
    okfPath: c.okfPath ?? null,
    candidateKind: json(c.candidateKind),
    citationManifest: json(c.citationManifest),
    connectorProvenance: json(c.connectorProvenance),
    confidence: c.confidence ?? null,
    // Preserve the three-way distinction the reader reconstructs: `undefined`
    // stores as NULL (absent), an explicit `false` stays `false`.
    contradicted: c.contradicted ?? null,
  };
}

/**
 * Store one candidate for a Stack.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the candidate.
 * @param candidate - The candidate to store.
 */
export async function saveStoredCandidate(
  db: Database,
  stackId: string,
  candidate: ReviewCandidate,
): Promise<void> {
  await insertCandidate(db, stackId, candidate);
}

/**
 * Remove one candidate, reporting whether a row was actually removed.
 *
 * Approval and rejection both consume a candidate. Returning the boolean lets the
 * caller distinguish "consumed the queue entry" from "it was already gone", which
 * the file store expressed by whether the unlink succeeded.
 *
 * @param db - Database handle.
 * @param stackId - The Stack that owns the candidate.
 * @param candidateId - The candidate's stable identifier.
 * @returns True when a row was removed.
 */
export async function deleteStoredCandidate(
  db: StoreHandle,
  stackId: string,
  candidateId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
    const removed = await tx.execute<{ candidate_id: string }>(sql`
      delete from wiki.review_candidates
      where stack_id = ${stackId} and candidate_id = ${candidateId}
      returning candidate_id
    `);
    return removed.length > 0;
  });
}

