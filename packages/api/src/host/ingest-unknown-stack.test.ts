/**
 * @file packages/api/src/host/ingest-unknown-stack.test.ts
 * @description An ingest naming a Stack that does not exist is refused, not queued.
 *
 * ## The defect
 *
 * `POST /api/ingest?stackId=<absent>` answered **202 with a job id**. The work was
 * accepted, the HTTP caller was told it had started, and the durable mirror then failed
 * on a foreign key inside a `catch` that only writes to stderr. From the caller's side a
 * job existed; from the database's side nothing was ever recorded.
 *
 * Shape validation was already there (`stackIdProblem`), and a well-formed id passes it.
 * The missing question is whether the Stack EXISTS -- the same one the MCP tools answer,
 * and the same one that answered `0 pages` for an absent Stack until b2e2497.
 *
 * ## Why 404 rather than 400
 *
 * The request is well formed; the resource it names is not there. That is what 404
 * means, and a client can tell it apart from "you sent garbage" (400) or "I cannot check
 * right now" (503).
 *
 * ## What the fixture must contain
 *
 * A REAL Stack, not an invented id: the refusal only fires when a lookup actually runs,
 * and a fake that answers "absent" for everything would pass even if the check were
 * deleted. `withStackEnv` provisions one, and the absent case is a well-formed UUID.
 */
import { describe, it, expect } from "vitest";
import { buildViewerSnapshot } from "@repo/wiki/viewer-snapshot";
import { AKS_DATABASE_URL_ENV_VAR, isDatabaseConfigured } from "@repo/wiki/dimensions-activation";
import { startHost } from "./server.js";
import { createJobRegistry } from "@repo/wiki/job-registry";
import { scratchProjectRoot } from "../../../../test/fixtures/host-scratch.js";
import { withStackEnv } from "../../../../test/fixtures/stack-env.js";

/** A well-formed UUID that names no Stack. */
const ABSENT_STACK = "00000000-0000-4000-8000-000000000000";

/** Fire one async ingest at a fresh host and decode whatever comes back. */
async function postIngest(stackId: string): Promise<{
  status: number;
  body: { jobId?: string; error?: { code?: string; message?: string } };
}> {
  const root = await scratchProjectRoot("ingest-unknown-stack-");
  const handle = await startHost({
    viewerSnapshot: await buildViewerSnapshot(root),
    port: 0,
    projectRoot: root,
    ingestJobs: createJobRegistry(),
  });
  try {
    const response = await fetch(`http://${handle.host}:${handle.port}/api/ingest?stackId=${stackId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/tmp/none.md", compile: false, async: true }),
    });
    return { status: response.status, body: (await response.json()) as never };
  } finally {
    await handle.close();
  }
}

describe("POST /api/ingest with a Stack that does not exist", () => {
  it("answers 404 with a code a client can branch on", async () => {
    await withStackEnv("ingest-unknown-stack", async () => {
      const response = await postIngest(ABSENT_STACK);

      expect(response.status).toBe(404);
      // A bare 404 would not distinguish "this Stack is gone" from "no such route".
      expect(response.body.error?.code).toBe("unknown_stack");
      expect(response.body.error?.message).toContain(ABSENT_STACK);
    });
  }, 60_000);

  it("does not mint a job id", async () => {
    await withStackEnv("ingest-unknown-stack-id", async () => {
      const response = await postIngest(ABSENT_STACK);

      // Load-bearing: a 202 was the whole bug. Any jobId in the body means work was
      // accepted for a Stack that cannot hold it.
      expect(response.body.jobId).toBeUndefined();
    });
  }, 60_000);
});

/**
 * The expression `unknownStackRefusal` used to carry itself, kept VERBATIM.
 *
 * Deliberately a copy of the line the extraction removed, not a restatement of it: the
 * assertion below is only worth having if the right-hand side is literally what the
 * function used to decide on. A tidied-up rewrite would compare the shared predicate
 * against a second reading of the same intent, which can agree while the original
 * disagreed.
 *
 * @param env - Environment to read, exactly as the old inline check read it.
 * @returns True when the old check skipped the Stack lookup.
 */
function legacySkippedLookup(env: NodeJS.ProcessEnv): boolean {
  const configured = (env[AKS_DATABASE_URL_ENV_VAR] ?? "").trim();
  return configured === "";
}

/**
 * ## The extraction, pinned from the outside
 *
 * `unknownStackRefusal` used to decide "is a database configured" inline, and skipped its
 * lookup when the answer was no. That predicate now has ONE home — `isDatabaseConfigured`,
 * which the Stack authority reads too — so a second derivation of "is this run file-backed"
 * cannot appear beside it and drift.
 *
 * ## What is pinned here, and what cannot be
 *
 * `unknownStackRefusal` is module-private, so its blank branch cannot be driven through the
 * mount from this suite: every vitest worker is seeded with `AKS_DATABASE_URL`, and deleting
 * it here would send the ACCEPTED request's downstream work to the vendored `localhost:5432`
 * fallback, which is the production port this repository refuses to touch from a test. So the
 * part the extraction could get wrong is pinned directly — the shared predicate must answer
 * exactly what the removed expression answered, for every input the function accepts — and the
 * configured branch is pinned end-to-end by the two tests above, which still reach the lookup
 * and still get 404 `unknown_stack`.
 */
describe("isDatabaseConfigured — the one home for the predicate unknownStackRefusal consumes", () => {
  it("answers exactly what the removed inline expression answered, for every accepted input", () => {
    const cases: NodeJS.ProcessEnv[] = [
      {}, // absent: unconfigured, the lookup is skipped
      { [AKS_DATABASE_URL_ENV_VAR]: "" }, // empty string: unconfigured
      { [AKS_DATABASE_URL_ENV_VAR]: "   " }, // spaces only: unconfigured
      { [AKS_DATABASE_URL_ENV_VAR]: "\t\n\r " }, // other whitespace: unconfigured
      { [AKS_DATABASE_URL_ENV_VAR]: "postgresql://user@host:1/db" }, // a real value: configured
      { [AKS_DATABASE_URL_ENV_VAR]: "  postgresql://user@host:1/db  " }, // padded real value
    ];

    for (const env of cases) {
      // The equivalence itself: the old check skipped the lookup exactly when the shared
      // predicate says no database is configured.
      expect(isDatabaseConfigured(env)).toBe(!legacySkippedLookup(env));
    }
  });

  it("reports no database for absent, empty and whitespace-only values", () => {
    // Stated separately from the equivalence above because these are the three inputs a
    // divergence would move: any of them reading as configured makes the caller open a
    // connection nobody asked for and answer 503 where it used to proceed.
    for (const raw of [undefined, "", " ", "\t", "\n "]) {
      const env: NodeJS.ProcessEnv = raw === undefined ? {} : { [AKS_DATABASE_URL_ENV_VAR]: raw };
      expect(isDatabaseConfigured(env)).toBe(false);
    }
  });

  it("reports a configured database for a real value, so the lookup path is taken", () => {
    expect(isDatabaseConfigured({ [AKS_DATABASE_URL_ENV_VAR]: "postgresql://user@host:1/db" })).toBe(true);
  });

  it("reads process.env when called with no argument, as the call site does", () => {
    // The extraction passes no environment: it calls the predicate bare, exactly where the
    // inline check used to read `process.env`. If that default ever stopped meaning
    // `process.env`, every assertion above would still hold while the host read the wrong
    // environment.
    expect(isDatabaseConfigured()).toBe(isDatabaseConfigured(process.env));
  });
});
