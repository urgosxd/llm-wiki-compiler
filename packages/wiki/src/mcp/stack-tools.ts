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
 *
 * ## Why `stackId` stays optional, and why omitting it is REFUSED
 *
 * A discovery tool cannot demand the identifier of the thing it discovers, so this is the
 * one Stack-scoped tool whose `stackId` is not required. That exemption is about the
 * ARGUMENT, not about where a Stack may come from: the argument is the only source, so a
 * call that names none is refused by name instead of being answered from
 * `AKS_STACK_ID` (S5 of `odd/tasks/stack-authority-per-request.md`). The refusal lives in
 * `tenant-db.ts` beside the other Stack refusals, so a tool added later cannot re-invent
 * the ambient fallback here.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listStacks } from "../services/stacks/stack-store.js";
// Relative, not through `compiler-cli`, for the reason recorded in `job-tools.ts`.
import { jsonResult } from "./result.js";
import {
  isRefusal,
  refusalResult,
  unnamedArgumentProblem,
  withTenantDatabase,
} from "./tenant-db.js";

/** The arguments `list_stacks` accepts, both optional: it is the discovery exemption. */
interface ListStacksArgs {
  readonly limit?: number | undefined;
  readonly stackId?: string | undefined;
}

/**
 * Answer one `list_stacks` call.
 *
 * ## Why the omission is a refusal and not a lookup
 *
 * No Stack is resolved from the environment anywhere on this surface, so the argument is
 * the only way to name one. A call that names none is refused by name, and the wording for
 * each mode (database configured, or the named file mode) lives in `tenant-db.ts` beside
 * the other Stack refusals so a later tool cannot re-invent the ambient fallback here.
 *
 * @param args - The optional `limit`, and the Stack the caller named.
 * @returns The listing envelope, or the refusal.
 */
async function answerListStacks({ limit, stackId }: ListStacksArgs): Promise<
  | ReturnType<typeof jsonResult>
  | ReturnType<typeof refusalResult>
> {
  const named = stackId?.trim() ?? "";
  if (named === "") return refusalResult(unnamedArgumentProblem(process.env));
  const result = await withTenantDatabase(
    (db, resolved) => listStacks(db, resolved, limit ?? 50),
    named,
  );
  if (isRefusal(result)) return refusalResult(result);
  return jsonResult({ stacks: result, count: result.length });
}

/** Register the Stack discovery tool. */
export function registerStackTools(server: McpServer): void {
  server.registerTool(
    "list_stacks",
    {
      title: "List Stacks",
      description:
        "List the Stacks this endpoint can reach, most recently updated first, " +
        "marking the one you named with stackId as current. Use it to discover a " +
        "StackId before calling a Stack-scoped tool. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many Stacks to return (default 50, max 200)."),
        stackId: z
          .string()
          .optional()
          .describe(
            "Stack to treat as the current one. This does NOT narrow the listing — " +
              "it only decides which entry is marked isCurrent. Required in practice: " +
              "this deployment reads no Stack from its environment, so a call that " +
              "omits this argument is refused — pass stackId.",
          ),
      },
    },
    answerListStacks,
  );
}
