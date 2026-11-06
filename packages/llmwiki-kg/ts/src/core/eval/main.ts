/**
 * @file packages/llmwiki-kg/ts/src/core/eval/main.ts
 * @description The two runners behind one command, and the guard that keeps the real
 * one unreachable by accident.
 *
 * ## The default is offline, and that is a safety property, not a convenience
 *
 * `npm run eval:kg` replays the recorded double. It cannot spend a credential even
 * when `TYPESAFE_API_KEY` happens to be exported in the developer's shell, because the
 * key is read only on the `--real` branch. The real branch additionally refuses to run
 * without the key: both a credential and an explicit flag are required, and neither
 * alone is enough, which is exactly S46's "las llamadas reales deben ser una evaluación
 * opcional y explícita".
 *
 * ## The real run says what it used
 *
 * A real report prints its mode, model id and base URL. Without that, two reports with
 * different numbers cannot be told apart, and a model or endpoint change would look
 * like a scorer change.
 *
 * ## Exit codes
 *
 * `0` a report was produced; `1` the run was refused or failed for a configuration or
 * data reason; `2` the invocation itself was wrong. The refusal message names exactly
 * what is missing, so a caller does not have to read this file to fix it.
 */

import type { TypeCatalog } from "../catalog/types.js";
import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { createJevHttpClientFromEnv } from "../jev/client.js";
import { JevConfigError, parseJevConfig } from "../jev/config.js";
import type { JevEnv } from "../jev/config.js";
import { loadEvalSet, EvalSetError } from "./load.js";
import { runOfflineEval } from "./offline.js";
import { renderJson, renderText } from "./report.js";
import { runEvalSet } from "./runner.js";
import type { EvalReport, EvalSet } from "./types.js";

/** The message printed when `--real` is passed without a credential. */
export const REAL_MISSING_KEY_MESSAGE =
  "refusing the real JEV evaluation: TYPESAFE_API_KEY is not set. --real requires a real credential; run without --real for the offline evaluation.";

/** Everything the command documents about itself. */
export const HELP_TEXT = [
  "Usage: eval:kg [--real] [--json] [--help]",
  "",
  "Scores the labeled ingestion set on four separate axes: extractor coverage,",
  "classifier quality, semantic-support quality and information loss.",
  "",
  "  (no flag)  offline evaluation: the recorded double, the committed labeled set,",
  "             no network and no credential. This is the default.",
  "  --real     real JEV evaluation. Requires TYPESAFE_API_KEY in the environment AND",
  "             this flag; without either the command exits 1 and names what is missing.",
  "             Environment: TYPESAFE_API_KEY, LLMWIKI_JEV_MODEL, LLMWIKI_JEV_BASE_URL,",
  "             LLMWIKI_JEV_TIMEOUT_MS and the four threshold variables read by",
  "             packages/llmwiki-kg/ts/src/core/jev/config.ts.",
  "  --json     print only the machine-readable JSON report.",
  "  --help     print this text.",
  "",
  "There is no aggregate score: the axes measure different stages and are never summed.",
].join("\n");

/** The flags one invocation carries. */
interface CliFlags {
  readonly real: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

/** Either the parsed flags or the invocation error to report. */
type ParsedFlags = { readonly flags: CliFlags } | { readonly error: string };

/** What the command writes to, injectable so tests capture instead of printing. */
export interface EvalCliDeps {
  /** The environment to read; defaults to `process.env`. */
  readonly env?: JevEnv;
  /** The labeled set loader; defaults to reading the committed file. */
  readonly loadSet?: () => EvalSet;
  /** Standard output; defaults to `process.stdout.write`. */
  readonly write?: (text: string) => void;
  /** Standard error; defaults to `process.stderr.write`. */
  readonly writeError?: (text: string) => void;
  /** The catalog to classify against; defaults to the documented default catalog. */
  readonly catalog?: TypeCatalog;
}

/**
 * Parses the command line, refusing anything it does not understand.
 *
 * @param argv - Arguments, without the node and script paths.
 * @returns The flags, or the error to report.
 */
function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags = { real: false, json: false, help: false };
  const known = new Set(["--real", "--json", "--help"]);
  for (const arg of argv) {
    if (!known.has(arg)) return { error: `unknown option ${JSON.stringify(arg)}` };
    if (arg === "--real") flags.real = true;
    if (arg === "--json") flags.json = true;
    if (arg === "--help") flags.help = true;
  }
  return { flags };
}

/**
 * Runs the explicit real evaluation, or refuses and says why.
 *
 * @param set - The labeled set.
 * @param env - The environment holding the credential and configuration.
 * @param catalog - The catalog to classify against.
 * @returns The report, or the message explaining the refusal.
 */
async function realReport(
  set: EvalSet,
  env: JevEnv,
  catalog: TypeCatalog,
): Promise<{ report: EvalReport } | { refusal: string }> {
  const apiKey = env["TYPESAFE_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey === "") return { refusal: REAL_MISSING_KEY_MESSAGE };
  const config = parseJevConfig(env);
  return {
    report: (
      await runEvalSet({
        set,
        catalog,
        client: createJevHttpClientFromEnv(env),
        config,
        run: { mode: "real", model: config.model, baseUrl: config.baseUrl },
      })
    ).report,
  };
}

/**
 * Runs the evaluation command and returns its exit code.
 *
 * @param argv - Arguments, without the node and script paths.
 * @param deps - Environment and stream overrides, for tests.
 * @returns The process exit code.
 */
export async function runEvalCli(argv: readonly string[], deps: EvalCliDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));
  const parsed = parseFlags(argv);
  if ("error" in parsed) {
    writeError(`${parsed.error}\n\n${HELP_TEXT}\n`);
    return 2;
  }
  if (parsed.flags.help) {
    write(`${HELP_TEXT}\n`);
    return 0;
  }
  const env = deps.env ?? process.env;
  try {
    const set = (deps.loadSet ?? loadEvalSet)();
    const catalog = deps.catalog ?? defaultTypeCatalog();
    const outcome = parsed.flags.real
      ? await realReport(set, env, catalog)
      : { report: (await runOfflineEval({ set, catalog })).report };
    if ("refusal" in outcome) {
      writeError(`${outcome.refusal}\n`);
      return 1;
    }
    write(parsed.flags.json ? `${renderJson(outcome.report)}\n` : `${renderText(outcome.report)}\n--- json ---\n${renderJson(outcome.report)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof EvalSetError || error instanceof JevConfigError) {
      writeError(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
