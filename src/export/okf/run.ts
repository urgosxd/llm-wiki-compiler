// src/export/okf/run.ts
/** @file Output-free OKF export core shared by CLI/SDK/MCP: collect pages + build the bundle, returning the written paths. */
import path from "path";
import { collectExportPages } from "../collect.js";
import { buildOkfBundle } from "./bundle.js";
import { EXPORT_DIR } from "../../utils/constants.js";
import { journalHealthWarning } from "../../trust/journal-health-warning.js";
import { withRawPageSource } from "../../dimensions/wiki/page-source-seam.js";

export interface OkfExportReport { outDir: string; writtenPaths: string[]; warnings: string[]; }

/** Where the export core reads its pages from. `env` defaults to the ambient environment so every existing caller is unchanged. */
export interface OkfExportOptions { out?: string; env?: NodeJS.ProcessEnv }

/** Export the wiki as an OKF bundle under `out` (default dist/exports/okf). Returns the bundle dir, every written path, and any non-fatal warnings (e.g. cited sources not bundled). Output-free — warnings are data, not prints. `opts.env` decides which Stack the pages are read from; a Stack-scoped caller passes the one its argument named. */
export async function runOkfExport(root: string, opts: OkfExportOptions = {}): Promise<OkfExportReport> {
  const env = opts.env ?? process.env;
  const outDir = opts.out ?? path.join(root, EXPORT_DIR, "okf");
  const pages = await withRawPageSource(root, env, (s) => collectExportPages(root, s, env));
  const warnings: string[] = [];
  // Surface a pending/unavailable compile journal so an OKF-bundle consumer never
  // imports partial post-crash or tampered page bodies as a clean export. The
  // channel is `string[]`, so format the shared warning as `code: message`
  // (matching the other string surfaces). An ok journal adds nothing — parity-safe.
  const journal = await journalHealthWarning(root);
  if (journal) warnings.push(`${journal.code}: ${journal.message}`);
  const writtenPaths = await buildOkfBundle(root, pages, outDir, (m) => warnings.push(m));
  return { outDir, writtenPaths, warnings };
}
