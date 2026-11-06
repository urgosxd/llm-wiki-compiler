/**
 * @file packages/llmwiki-kg/ts/src/core/eval/cli.ts
 * @description The executable entry point: `npm run eval:kg`.
 *
 * A module this small exists so the command logic stays importable. Everything
 * testable lives in `main.ts`; this file only decides whether it is being run as the
 * process entry point and forwards the exit code. Importing it — which a test does
 * not, but a bundler or a future caller might — must never execute a run, so the
 * comparison is against the real entry path resolved through `pathToFileURL`.
 */

import { pathToFileURL } from "node:url";
import { runEvalCli } from "./main.js";

/**
 * Whether this module is the process entry point.
 *
 * @returns True when the current script path resolves to this file.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.exitCode = await runEvalCli(process.argv.slice(2));
}
