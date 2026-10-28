/**
 * @file src/mcp/stack-tools.ts
 * @description MCP tool that lists the Stacks this deployment can reach.
 *
 * ## Why this exists
 *
 * Every other tool addresses "this Stack" — the one the process was started with
 * — and nothing ever named the alternatives. A consumer building a picker had to
 * scrape `GET /stacks` over HTTP to learn the ids, and asked for a tool instead.
 * One MCP endpoint serving one Stack is a coherent deployment shape; pretending a
 * client can discover the others when it cannot was the actual gap.
 *
 * ## What "all the Stacks" honestly means
 *
 * Not "every row in the table". The read runs under the same tenant policy as every
 * other query, so it answers "the Stacks this deployment may reach" — its own, plus
 * the ones sharing its domain. See `stack-store.ts` for why that is the policy's
 * documented intent for this table rather than a widening introduced here. A tool
 * that dumped every tenant's Stacks would be a cross-tenant leak dressed as a
 * convenience, and it would only appear to work because the default deployment
 * happens to connect as a policy-bypassing role.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStacks } from "../services/stacks/stack-store.js";
// Relative, not through `compiler-cli`, for the reason recorded in `job-tools.ts`.
import { jsonResult, errorResult } from "./result.js";
import { isUnavailable, withTenantDatabase } from "./tenant-db.js";

/** Register the Stack discovery tool. */
export function registerStackTools(server: McpServer): void {
  server.registerTool(
    "list_stacks",
    {
      title: "List Stacks",
      description:
        "List the Stacks this endpoint can reach, most recently updated first, " +
        "marking which one this connection is bound to. Use it to discover a " +
        "StackId before calling a Stack-scoped tool. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many Stacks to return (default 50, max 200)."),
      },
    },
    async ({ limit }) => {
      const result = await withTenantDatabase((db, stackId) =>
        listStacks(db, stackId, limit ?? 50),
      );
      if (isUnavailable(result)) return errorResult(result.unavailable);
      return jsonResult({ stacks: result, count: result.length });
    },
  );
}
