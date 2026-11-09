// src/mcp/okf-tools.ts
/** @file MCP OKF tools: export_okf (confined) + import_okf (staging-only, confined, queue-capped). Extracted from tools.ts to stay under the file-size limit. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runOkfExport } from "../export/okf/run.js";
import { runOkfImport } from "../import/run.js";
import { withQuiet } from "../utils/output.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { jsonResult, errorResult } from "./result.js";
import { STACK_ARG_REQUIRED_NOTE, STACK_ID_SCHEMA } from "./stack-arg.js";
import { isRefusal, refusalResult, withRequestEnv } from "./tenant-db.js";

const MAX_MCP_PENDING_CANDIDATES = 200;

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

/**
 * Import an OKF bundle into ONE Stack and shape the tool payload.
 *
 * Staging is always untrusted here, so nothing becomes live without review; the
 * `env` still decides which Stack the review candidates and (on a trusted run) the
 * page rows belong to.
 *
 * @param root - Project root; `dir` is confined under it.
 * @param dir - Bundle directory inside the project.
 * @param dryRun - Preview only, staging nothing.
 * @param maxPending - Queue cap enforced by the import core.
 * @param env - Environment pointing the page seams at the requested Stack.
 * @returns The MCP success envelope.
 */
async function importBundle(
  root: string,
  dir: string,
  dryRun: boolean | undefined,
  maxPending: number,
  env: NodeJS.ProcessEnv,
) {
  const bundle = await confineUnderRoot(dir, root, { mustExist: true });
  const report = await runOkfImport(root, bundle, { trusted: false, dryRun, maxNewCandidates: maxPending, env });
  return jsonResult({
    mode: report.mode,
    imported: report.pages.length,
    pages: report.pages,
    skipped: report.skipped,
    warnings: report.warnings,
    nextAction: report.mode === "dry-run"
      ? "Preview only — re-run without dryRun to stage these as review candidates."
      : "Imported docs are STAGED as review candidates — approve them via `llmwiki review` (human gate) before they enter the wiki.",
  });
}

/** The envelope shape both OKF cores are wrapped in. */
type OkfEnvelope = ReturnType<typeof jsonResult>;

/**
 * Run one OKF tool body under the Stack the call named.
 *
 * Both registrations need the same four things around their core call, and each one
 * was a separate chance to get it wrong: the request env from `withRequestEnv` (so the
 * page seams read the NAMED Stack), `withQuiet` (the cores print via `output.status`,
 * which on the stdio transport would land on the JSON-RPC stream and corrupt it), the
 * refusal translation, and the error envelope.
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

/** Register the OKF export/import tools. Both confine agent-supplied paths under `root`. `maxPending` is injectable so a test can prove the cap is actually wired into import_okf (default keeps production behavior). */
export function registerOkfTools(server: McpServer, root: string, maxPending: number = MAX_MCP_PENDING_CANDIDATES): void {
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

  server.registerTool(
    "import_okf",
    {
      title: "Import OKF bundle (staged for review)",
      description: "Import an OKF bundle from a path INSIDE the project as review candidates for " +
        "the Stack named by `stackId`. Always staging-only — imported knowledge requires human " +
        "review/approval before it enters the wiki. Use dryRun to preview. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        dir: z.string().describe("Bundle directory (must resolve inside the project root)"),
        dryRun: z.boolean().optional().describe("Preview only — stage nothing"),
        stackId: STACK_ID_SCHEMA,
      },
    },
    // withQuiet: same stdio-stream guard as export_okf (the import core may emit warnings).
    async ({ dir, dryRun, stackId }) =>
      runOkfTool(stackId, (env) => importBundle(root, dir, dryRun, maxPending, env)),
  );
}
