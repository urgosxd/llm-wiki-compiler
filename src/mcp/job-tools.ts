/**
 * @file src/mcp/job-tools.ts
 * @description MCP tools that answer "how is my ingest going" from the DURABLE job
 * table rather than from process memory.
 *
 * ## Why these read Postgres and not the registry
 *
 * `JobRegistry` lives in the memory of the process that owns the job. `llmwiki serve`
 * is a different process — MCP is stdio, and the host that runs async ingests is a
 * separate `llmwiki host` — so the registry is invisible here by construction, not
 * by oversight. `wiki.ingest_job` is the copy the host writes on every transition
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
// "Cannot find module 'llmwiki-kg'". `src/mcp/**` ships in the ROOT bundle, which
// resolves the package fine, so reaching the source directly keeps both builds green
// without widening the core's surface.
import { listIngestJobs, readIngestJob } from "../services/ingest/jobs/job-store.js";
import { jsonResult, errorResult } from "./result.js";
import { isUnavailable, withTenantDatabase } from "./tenant-db.js";

/** Register the durable job read tools. */
export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "ingest_job_status",
    {
      title: "Ingest Job Status",
      description:
        "Read one async ingest job by id, including both dimensions (ingest and " +
        "compile), their stages, and the transaction attempts so far. Reads the " +
        "durable record the host writes, so it works even when the host is in " +
        "another process. Read-only.",
      inputSchema: {
        jobId: z.string().describe("Job id, of the form ing_<ULID>."),
      },
    },
    async ({ jobId }) => {
      const result = await withTenantDatabase((db, stackId) => readIngestJob(db, stackId, jobId));
      if (isUnavailable(result)) return errorResult(result.unavailable);
      if (result === undefined) return errorResult(`No ingest job '${jobId}' for this Stack.`);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "ingest_jobs_list",
    {
      title: "List Ingest Jobs",
      description:
        "List this Stack's recent async ingest jobs, newest transition first, with " +
        "each job's ingest and compile status. Use it to find a job id or to see " +
        "what is still running. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many jobs to return (default 50, max 200)."),
      },
    },
    async ({ limit }) => {
      const result = await withTenantDatabase((db, stackId) => listIngestJobs(db, stackId, limit ?? 50));
      if (isUnavailable(result)) return errorResult(result.unavailable);
      return jsonResult({ jobs: result, count: result.length });
    },
  );
}
