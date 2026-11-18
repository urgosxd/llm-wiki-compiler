/**
 * @file src/mcp/job-tools.ts
 * @description MCP tools that answer "how is my ingest going" from the DURABLE job
 * table rather than from process memory.
 *
 * ## Why these read Postgres and not the registry
 *
 * `JobRegistry` lives in the memory of the process that owns the job. The MCP server
 * is a different process — MCP is stdio, and the host that runs async ingests is its
 * own launch of the server entry — so the registry is invisible here by construction,
 * not by oversight. `wiki.ingest_job` is the copy the host writes on every transition
 * precisely so this side can read it.
 *
 * ## Why there is no `ingest_source_async` here
 *
 * Starting a job means entering the host's mutation path: the project lock, the
 * transactional coordinator, and the registry that owns the live state. A second
 * process doing that would run a SECOND ingest against the same project, which is
 * the exact race the mutation lock exists to prevent. The host owns starting jobs;
 * this side observes them. `ingest_source` (blocking) stays as the way to ingest
 * over MCP, and the async path remains `POST /api/ingest`.
 *
 * ## Answering without a Stack
 *
 * A project with no `AKS_STACK_ID` has nowhere durable to record a job, so these
 * tools report that plainly instead of returning an empty list that reads like "no
 * jobs ever ran". The distinction matters: an empty list is an answer, and this is
 * an inability to answer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Imported by relative path, NOT through `compiler-cli`.
//
// The core's declaration build resolves a narrower graph than the root bundle, and
// these modules transitively import `llmwiki-kg`, which that build cannot resolve —
// re-exporting them from `compiler-cli.ts` broke `npm run build` with
// "Cannot find module '@repo/kg'". `src/mcp/**` ships in the ROOT bundle, which
// resolves the package fine, so reaching the source directly keeps both builds green
// without widening the core's surface.
import { listIngestJobs, readIngestJob } from "../services/ingest/jobs/job-store.js";
import { deleteRecoverableJob } from "../services/ingest/jobs/delete.js";
import { resolveIngestJobStuckAfterMs, withStatusReason } from "../services/ingest/jobs/status.js";
import type { JobStatusOptions } from "../services/ingest/jobs/status.js";
import { jsonResult, errorResult } from "./result.js";
import { STACK_ARG_REQUIRED_NOTE, STACK_ID_SCHEMA } from "./stack-arg.js";
import { isRefusal, refusalResult, withTenantDatabase } from "./tenant-db.js";

/**
 * The clock and the stuck bound a tool answer is described with.
 *
 * Resolved per call rather than at module load: a long-lived server would otherwise keep
 * describing rows against the bound it started with, and an operator who tuned the env
 * var would see no change without a restart. `new Date()` is the real instant for a
 * tool call — unlike the viewer route there is no host seam to pin, and the derivation
 * itself takes its clock as an argument.
 */
function statusOptions(): JobStatusOptions {
  return { now: new Date(), stuckAfterMs: resolveIngestJobStuckAfterMs() };
}

/** Register the durable job read tools. */
export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "ingest_job_status",
    {
      title: "Ingest Job Status",
      description:
        "Read one async ingest job by id, including both dimensions (ingest and " +
        "compile), their stages, and the transaction attempts so far. `dimensions` is the " +
        "per-dimension report: one entry per dimension saying whether it ran and succeeded, " +
        "was skipped and why (the route does not include it, `LLMWIKI_DIMENSIONS` disables " +
        "it, or it had no changes), or failed with its error. Reads the " +
        "durable record the host writes, so it works even when the host is in " +
        "another process. `statusReason` says WHY it is in that state and whether " +
        "the claim was observed or derived; `compile.retryable` is true when a " +
        "retry is the next step. Read-only. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        jobId: z.string().describe("Job id, of the form ing_<ULID>."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ jobId, stackId }) => {
      const result = await withTenantDatabase(
        (db, resolved) => readIngestJob(db, resolved, jobId),
        stackId,
      );
      if (isRefusal(result)) return refusalResult(result);
      if (result === undefined) return errorResult(`No ingest job '${jobId}' for this Stack.`);
      return jsonResult(withStatusReason(result, statusOptions()));
    },
  );

  server.registerTool(
    "ingest_jobs_list",
    {
      title: "List Ingest Jobs",
      description:
        "List this Stack's recent async ingest jobs, newest transition first, with " +
        "each job's ingest and compile status, its per-dimension report (`dimensions`: " +
        "which dimensions ran, which were skipped and why, and which failed), the reason " +
        "it is in that state " +
        "(`statusReason`), and whether a retry is offered (`compile.retryable`). " +
        "Use it to find a job id or to see what is still running. Read-only. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many jobs to return (default 50, max 200)."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ limit, stackId }) => {
      const result = await withTenantDatabase(
        (db, resolved) => listIngestJobs(db, resolved, limit ?? 50),
        stackId,
      );
      if (isRefusal(result)) return refusalResult(result);
      // One instant and one bound for the whole answer: two rows of the same listing must
      // not disagree about whether the same silence counts as stuck.
      const options = statusOptions();
      const jobs = result.map((job) => withStatusReason(job, options));
      return jsonResult({ jobs, count: jobs.length });
    },
  );

  server.registerTool(
    "ingest_job_delete",
    {
      title: "Delete Ingest Job",
      description:
        "Remove one async ingest job record from this Stack, so a job that can never " +
        "finish stops appearing in the listing. Allowed when the job has settled, or when " +
        "it has made no progress for longer than the stuck bound. REFUSED, with the stored " +
        "record left exactly as it was, when the job is still working or when this Stack " +
        "never had that id. Returns the record it removed. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        jobId: z.string().describe("Job id, of the form ing_<ULID>."),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ jobId, stackId }) => {
      const result = await withTenantDatabase(
        (db, resolved) => deleteRecoverableJob(db, resolved, jobId, statusOptions()),
        stackId,
      );
      if (isRefusal(result)) return refusalResult(result);
      // A refusal is reported as one, never as an empty success: a caller that read
      // "nothing happened" as "deleted" would retry against a job that is still running.
      if (!result.deleted) return errorResult(result.message);
      return jsonResult({ deleted: true, job: result.job });
    },
  );
}
