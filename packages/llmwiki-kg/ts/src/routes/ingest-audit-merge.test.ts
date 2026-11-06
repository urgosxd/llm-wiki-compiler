/**
 * @file packages/llmwiki-kg/ts/src/routes/ingest-audit-merge.test.ts
 * @description The two `jsonb` write branches of the ingest audit, pinned where
 * a sibling producer's key can be lost.
 *
 * WHY THIS FILE EXISTS. `writeIngestAudit` (`routes/ingest/audit.ts`) runs one of
 * two statements: the healthy branch replaces `ontology` and DELETES `extraction`,
 * the degraded branch replaces both. Both are MERGE statements over a column that
 * several producers write to, and the promise the `extraction` section rests on is
 * additive — no producer erases a sibling producer's key.
 *
 * That promise is not observable in any other ingest suite, because every other
 * one starts from `audit = null`: a blob written start to finish by a single
 * ingest has no foreign key to lose, so a statement that REPLACED the column
 * instead of merging into it would pass all of them. These two tests seed a
 * section this run does not produce — the way a later audit producer would — and
 * then assert exactly what survived.
 *
 * ## Why each branch is asserted by name
 *
 * The healthy branch's removal is `jsonb - 'extraction'`, a key-specific delete
 * whose failure mode is silence: a typo deletes nothing, the previous run's
 * counters survive, and nothing else in the codebase ever looks at that key. The
 * degraded branch nests two `jsonb_set` calls, and nesting is the entire reason
 * the second one does not overwrite the first. One test per branch, each asserting
 * the whole blob, so an extra key and a missing key both fail.
 *
 * ## Why it is a separate file
 *
 * `ingest-ontology.test.ts` already overruns the 400-line budget AGENTS.md sets,
 * so these DB-backed probes live here instead of pushing it further.
 *
 * ## The gate
 *
 * Gated on `skipReason` from `ingest-harness.js`, so it skips with the same reason
 * as its sibling rather than failing where no database is reachable.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Provider configuration, hoisted above every import.
 *
 * `config` parses `process.env` once at module load and the pipeline reaches it
 * through `../config.js`, so these values must exist before that import runs.
 * `vi.hoisted` is the only place that guarantees it without a setup file.
 */
vi.hoisted(() => {
  process.env["EXTRACTION_PROVIDER"] = "gateway";
  process.env["EMBEDDING_PROVIDER"] = "gateway";
  process.env["GATEWAY_URL"] = "https://gateway.invalid/v1";
  process.env["GATEWAY_API_KEY"] = "test-key-not-a-credential";
  process.env["EMBEDDING_MODEL"] = "hf:nomic-ai/nomic-embed-text-v1.5";
  process.env["EMBEDDING_DIM"] = "768";
  process.env["EXTRACTION_MODEL"] = "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
});

import request from "supertest";
import express from "express";
import type { Express } from "express";
import { sql } from "drizzle-orm";
import { withFixtureTenant } from "./fixture-tenant.js";

import { createRequireApiKey } from "../auth.js";
import { parseConfig } from "../config.js";
import { createRequestTransactionWrapper } from "../db.js";
import { createStacksRouter } from "./stacks.js";
import { createIngestRouter } from "./ingest.js";
import {
  CLASSIFICATION_DISABLED_CONSEQUENCE,
  UNCLASSIFIED_WARNING_CODE,
  unclassifiedWarningMessage,
} from "./ingest/audit.js";
import {
  createDocument,
  database,
  deleteFixtureRows,
  ingestUrl,
  skipReason,
  useDomainPrefix,
} from "./ingest-harness.js";
import {
  installFetchStub,
  setToolResponse,
  uninstallFetchStub,
} from "../core/extraction-harness.js";

useDomainPrefix("audit-merge");

/** The declaration the Stack is created with, so a fresh run declares itself. */
const DECLARATION = {
  entityTypes: ["COMPANY", "PERSON"],
  relationshipTypes: ["EMPLOYS"],
};

/** One chunk of prose, so the pipeline has something to send to the model. */
const BODY = "Acme employs Ada Lovelace. Globex employs nobody at all.";

/**
 * A response that is not an envelope: the provider answered, so this is the
 * degraded case and takes the branch that writes an `extraction` section.
 */
const MANGLED = { status: "ok" };

/** A triplet inside the declaration: kept, so the run answers cleanly. */
const IN_ONTOLOGY = {
  subject: { type: "COMPANY", name: "Acme" },
  relation: { type: "EMPLOYS" },
  object: { type: "PERSON", name: "Ada Lovelace" },
};

/**
 * A section this ingest never produces, standing in for a later producer's.
 *
 * Its content is arbitrary and deliberately non-empty: a merge that kept only the
 * key with the wrong value would still fail the assertion.
 */
const QUALITY = { score: 0.5, droppedSentences: 2 };

/** The ontology section a previous run of a DIFFERENT kind left behind. */
const STALE_ONTOLOGY = {
  enforced: true,
  declared: false,
  rejected: 9,
  reason_codes: ["UNKNOWN_ENTITY_TYPE"],
  samples: [],
};

/** Degradation counters a previous run left behind, both distinct from zero. */
const STALE_EXTRACTION = { mangledChunks: 9, schemaViolations: 9 };

/** The section a clean, declared run produces: zero rejections, nothing sampled. */
const FRESH_ONTOLOGY = {
  enforced: true,
  declared: true,
  rejected: 0,
  reason_codes: [],
  samples: [],
};

/** Builds an app exposing both routers over one transaction wrapper. */
function buildApp(): Express {
  const wrap = createRequestTransactionWrapper(database());
  const apiKey = createRequireApiKey(parseConfig({ AKS_API_KEY: "" }));

  const app = express();
  app.use(express.json({ strict: false }));
  app.use("/stacks", createStacksRouter({ wrap, apiKey }));
  app.use(createIngestRouter({ wrap, apiKey }));
  app.use((_req, res) => {
    res.status(404).json({ detail: "Not Found" });
  });
  return app;
}

/** Creates a Stack through the API, returning its id. */
async function createStackWith(
  app: Express,
  domain: string,
  ontology?: unknown,
): Promise<string> {
  const created = await request(app)
    .post("/stacks")
    .send({
      name: "Audit Merge",
      domain,
      ...(ontology === undefined ? {} : { ontology }),
    })
    .expect(201);
  return String(created.body.id);
}

/**
 * The classification section an UNCONFIGURED run writes.
 *
 * No classifier is injected in this file, so every run reports `configured: false`
 * plus the `?type=` consequence; the warning appears only when the run actually kept
 * candidates, and its count is the number it left undecided.
 *
 * @param candidateCount - How many candidates the run left unclassified.
 * @returns The section as the audit blob stores it.
 */
function unconfiguredClassification(candidateCount: number): unknown {
  return {
    configured: false,
    consequence: CLASSIFICATION_DISABLED_CONSEQUENCE,
    ...(candidateCount === 0
      ? {}
      : {
          warnings: [
            { code: UNCLASSIFIED_WARNING_CODE, message: unclassifiedWarningMessage(candidateCount) },
          ],
        }),
  };
}

/** The audit blob recorded for one document, or null when none was written. */
async function documentAudit(stackId: string, documentId: string): Promise<unknown> {
  const rows = await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute<{ audit: unknown }>(
      sql`select audit from stack_documents where id = ${documentId}`,
    ),
  );
  return rows[0]?.audit ?? null;
}

/** Writes the blob directly, the way a producer this run does not own would. */
async function seedAudit(
  stackId: string,
  documentId: string,
  audit: unknown,
): Promise<void> {
  await withFixtureTenant(database(), { stackId }, (tx) =>
    tx.execute(
      sql`update stack_documents
          set audit = ${JSON.stringify(audit)}::jsonb
          where id = ${documentId}`,
    ),
  );
}

describe.skipIf(skipReason !== false)("ingest merges into the audit blob", () => {
  let app: Express;
  let sequence = 0;

  /** Unique domain per call, carrying this file's cleanup prefix. */
  function domain(label: string): string {
    sequence += 1;
    return `w2ex-ingest-audit-merge-${label}-${Date.now().toString(36)}-${String(sequence)}`;
  }

  beforeEach(async () => {
    await deleteFixtureRows();
    app = buildApp();
    installFetchStub();
  });

  afterEach(async () => {
    uninstallFetchStub();
    await deleteFixtureRows();
  });

  it("deletes only the extraction section when a re-ingest answers cleanly", async () => {
    setToolResponse([{ triplets: [IN_ONTOLOGY] }]);
    const stackId = await createStackWith(app, domain("clean"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);
    await seedAudit(stackId, documentId, {
      quality: QUALITY,
      ontology: STALE_ONTOLOGY,
      extraction: STALE_EXTRACTION,
    });

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // The whole blob, not a per-key look: `toEqual` fails on an extra key, which
    // is the only way to observe that `extraction` really went, and on a missing
    // one, which is how a branch that cleared the column would show up. The
    // sibling's `quality` key must survive and `ontology` must be THIS run's.
    // `classification` is part of the pinned shape now: no classifier is injected
    // here, so the run must report the unconfigured state and the candidates it
    // left undecided.
    const audit = await documentAudit(stackId, documentId);
    expect(audit).toEqual({
      quality: QUALITY,
      ontology: FRESH_ONTOLOGY,
      classification: unconfiguredClassification(3),
    });
    expect(audit).not.toHaveProperty("extraction");
  });

  it("keeps a sibling section when it also writes the degradation one", async () => {
    setToolResponse([MANGLED]);
    const stackId = await createStackWith(app, domain("degraded"), DECLARATION);
    const documentId = await createDocument(stackId, BODY);
    await seedAudit(stackId, documentId, { quality: QUALITY });

    await request(app).post(ingestUrl(stackId, documentId)).expect(200);

    // The degraded branch is two nested `jsonb_set` calls. Written the other way
    // -- each applied to `coalesce(audit, '{}')` -- the second would overwrite
    // the first and the blob would lose a section nobody asked it to drop. All
    // three keys are asserted, so whichever one got dropped fails here.
    const audit = await documentAudit(stackId, documentId);
    expect(audit).toEqual({
      quality: QUALITY,
      ontology: FRESH_ONTOLOGY,
      extraction: { mangledChunks: 1 },
      // A mangled chunk produced no candidate, so the unconfigured section carries
      // the consequence and no warning: there was nothing to leave undecided.
      classification: unconfiguredClassification(0),
    });
  });
});
