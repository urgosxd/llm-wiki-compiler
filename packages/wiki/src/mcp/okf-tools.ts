// src/mcp/okf-tools.ts
/** @file MCP OKF tool: export_okf (confined). Extracted from tools.ts to stay under the file-size limit. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOkfExport } from "../export/okf/run.js";
import { withQuiet } from "../utils/output.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { jsonResult, errorResult } from "./result.js";
import { STACK_ARG_REQUIRED_NOTE, STACK_ID_SCHEMA } from "./stack-arg.js";
import { isRefusal, refusalResult, withRequestEnv } from "./tenant-db.js";

/** Bundle directory used when the caller names none, relative to the project root. */
const DEFAULT_EXPORT_OUT = "dist/exports/okf";

/**
 * Export the pages of ONE Stack into `out` and shape the tool payload.
 *
 * `env` is the Stack-scoped environment, not the ambient one: the export core reads
 * its pages through `withRawPageSource(root, env, …)`, so a caller that named a Stack
 * gets that Stack's rows instead of whichever Stack the process is bound to.
 *
 * @param root - Project root; `out` is confined under it.
 * @param out - Bundle directory, or undefined for {@link DEFAULT_EXPORT_OUT}.
 * @param env - Environment pointing the page seam at the requested Stack.
 * @returns The MCP success envelope.
 */
async function exportBundle(root: string, out: string | undefined, env: NodeJS.ProcessEnv) {
  const dest = await confineUnderRoot(out ?? DEFAULT_EXPORT_OUT, root, { mustExist: false });
  const report = await runOkfExport(root, { out: dest, env });
  return jsonResult({
    outDir: report.outDir,
    fileCount: report.writtenPaths.length,
    files: report.writtenPaths.slice(0, 20),
    warnings: report.warnings,
  });
}

/** The envelope shape the OKF cores are wrapped in. */
type OkfEnvelope = ReturnType<typeof jsonResult>;

/**
 * Run one OKF tool body under the Stack the call named.
 *
 * The registration needs four things around its core call, and each one was a separate
 * chance to get it wrong: the request env from `withRequestEnv` (so the page seams read
 * the NAMED Stack), `withQuiet` (the cores print via `output.status`, which on the stdio
 * transport would land on the JSON-RPC stream and corrupt it), the refusal translation,
 * and the error envelope.
 *
 * @param stackId - The Stack the caller passed as the tool argument.
 * @param body - The core call, given the environment pointing at that Stack.
 * @returns The MCP envelope, a refusal, or an error result.
 */
async function runOkfTool(
  stackId: string,
  body: (env: NodeJS.ProcessEnv) => Promise<OkfEnvelope>,
): Promise<OkfEnvelope | ReturnType<typeof errorResult>> {
  return withQuiet(async () => {
    try {
      const result = await withRequestEnv(stackId, body);
      return isRefusal(result) ? refusalResult(result) : result;
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Register the OKF export tool. It confines the agent-supplied path under `root`.
 *
 * There is no `import_okf`. It hardcoded `trusted: false` and its schema had no
 * `trusted` field, so an MCP caller could only ever stage — and staging is retired,
 * because no surface promotes a candidate into the wiki. A tool that can only return
 * a refusal advertises something impossible, so it is not registered at all.
 */
export function registerOkfTools(server: McpServer, root: string): void {
  server.registerTool(
    "export_okf",
    {
      title: "Export OKF bundle",
      description: "Export one Stack's wiki as an Open Knowledge Format (OKF) v0.1 bundle. " +
        "Reads the Stack named by `stackId`; `out` defaults to dist/exports/okf and must stay " +
        "inside the project. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        out: z.string().optional().describe("Output dir for the bundle (must resolve inside the project root)"),
        stackId: STACK_ID_SCHEMA,
      },
    },
    // withQuiet: the export core can print skipped-reference warnings via output.status;
    // on the MCP stdio transport those would land on the JSON-RPC stream and corrupt it.
    async ({ out, stackId }) => runOkfTool(stackId, (env) => exportBundle(root, out, env)),
  );
}
