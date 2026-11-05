/**
 * MCP tool registrations for llmwiki.
 *
 * Each tool wraps an existing pipeline function (ingest, compile, query,
 * search, read, lint, status, context-pack, eval) and converts its structured result into
 * an MCP CallToolResult. Tools that need an LLM provider validate the
 * provider lazily — the server itself starts without credentials so
 * read-only tools always work.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ingestSource } from "@atomicstrata/llmwiki-core/compiler-cli";
import { compileAndReport } from "@atomicstrata/llmwiki-core/compiler-cli";
import { generateAnswer } from "@atomicstrata/llmwiki-core/compiler-cli";
import { lint } from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  withEmbeddingStoreSource,
  withPageScan,
  withPageSource,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { collectStatus } from "@atomicstrata/llmwiki-core/compiler-cli";
import { buildContextPack } from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  ensureCompileProviderAvailable,
  ensureProviderAvailable,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  runEval,
  DEFAULT_SAMPLE_SIZE,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { readPageRecord } from "@atomicstrata/llmwiki-core/compiler-cli";
import type {
  PageListingSource,
  PageRef,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  getPage,
  pickSearchRefs,
  loadSelectedRefs,
  withRegistrySource,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { createDimensionsDatabase } from "../dimensions/activation.js";
import { createPageListingSource } from "../dimensions/wiki/page-write-sink.js";
import { loadNonDefaultProfile } from "@atomicstrata/llmwiki-core/compiler-cli";
import { isSlugSafe } from "@atomicstrata/llmwiki-core/compiler-cli";
import {
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { jsonResult, errorResult } from "./result.js";
import { registerJobTools } from "./job-tools.js";
import { registerStackTools } from "./stack-tools.js";
import { registerWikiReadTools } from "./wiki-read-tools.js";
import { STACK_ARG_REQUIRED_NOTE, STACK_ID_SCHEMA } from "./stack-arg.js";
import { isRefusal, refusalResult, withRequestEnv } from "./tenant-db.js";

/** Register all 10 wiki tools on the given MCP server instance. */
export function registerWikiTools(server: McpServer, root: string): void {
  registerIngestTool(server, root);
  registerCompileTool(server, root);
  registerWikiReadTools(server, root);
  registerEvalTool(server, root);
  registerJobTools(server);
  registerStackTools(server);
}

function registerIngestTool(server: McpServer, root: string): void {
  server.registerTool(
    "ingest_source",
    {
      title: "Ingest Source",
      description:
        "Ingest a URL or a local .md/.txt file into the Stack named by `stackId`: the " +
        "source is fetched and extracted, its document is recorded for that Stack, and " +
        "the call returns the saved filename, character count, and whether content was " +
        "truncated to fit the size limit. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        source: z
          .string()
          .describe("URL (http/https) or absolute path to a .md/.txt file"),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ source, stackId }) => {
      // The tool's argument is the ONLY source of the Stack here: `withRequestEnv`
      // refuses an id this deployment cannot serve, and the service is handed the id
      // directly so it never resolves a default Stack of its own.
      const result = await withRequestEnv(stackId, (env) =>
        ingestSource(root, source, undefined, env, { stackId }),
      );
      if (isRefusal(result)) return refusalResult(result);
      return jsonResult(result);
    },
  );
}

function registerCompileTool(server: McpServer, root: string): void {
  server.registerTool(
    "compile_wiki",
    {
      title: "Compile Wiki",
      description:
        "Run the incremental compile pipeline: extract concepts from new/changed " +
        "sources, generate wiki pages, resolve interlinks, and rebuild the index. " +
        "Requires an LLM provider with credentials. " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: { stackId: STACK_ID_SCHEMA },
    },
    async ({ stackId }) => {
      ensureCompileProviderAvailable();
      // Compile WRITES pages, so the Stack it is given decides which tenant the output
      // lands in. Wrapped rather than threaded because the writer already resolves the
      // Stack from the environment, and inventing a second argument would let a compile
      // write to one Stack while its reads came from another.
      const result = await withRequestEnv(stackId, () => compileAndReport(root));
      if (isRefusal(result)) return refusalResult(result);
      return jsonResult(result);
    },
  );
}

function registerEvalTool(server: McpServer, root: string): void {
  server.registerTool(
    "run_eval",
    {
      title: "Run Eval",
      description:
        "Run the wiki quality eval harness. fast suite checks health and citation " +
        "coverage without LLM calls. full suite also LLM-judges a sample of citations " +
        "(requires an LLM provider). " +
        "Set record: true to append results to eval history (default false — read-only). " +
        STACK_ARG_REQUIRED_NOTE,
      inputSchema: {
        suite: z
          .enum(["fast", "full"])
          .optional()
          .default("fast")
          .describe(
            "fast=no LLM calls, full=includes citation support (requires LLM provider)",
          ),
        sampleSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            `Citations to sample for citation support (full suite only, default ${DEFAULT_SAMPLE_SIZE})`,
          ),
        record: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Append results to eval history (default false; set true to persist a checkpoint)",
          ),
        stackId: STACK_ID_SCHEMA,
      },
    },
    async ({ suite, sampleSize, record, stackId }) => {
      // `runEval` reads the project through the same env the seams use, so wrapping it
      // is enough to make the eval describe the named Stack instead of the bound one.
      const report = await withRequestEnv(stackId, () =>
        runEval(root, suite, sampleSize ?? DEFAULT_SAMPLE_SIZE, record ?? false),
      );
      if (isRefusal(report)) return refusalResult(report);
      return jsonResult(report);
    },
  );
}

/** A 64-character lowercase-hex sha256 digest — the same grammar the manifest and the CLI's `--sha256` flag enforce. */
const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

