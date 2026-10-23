/**
 * Vitest globalSetup: build dist/ once before any test file loads.
 *
 * Several test files spawn `node dist/cli.js` to exercise the CLI surface.
 * Without a shared setup, each file's own beforeAll would call tsup, and
 * vitest's parallel-by-default test workers would race on dist/cli.js
 * (tsup's `clean: true` wipes the file mid-write). Building once globally
 * eliminates the race and saves ~1s per integration test file.
 *
 * THE BUILD IS SKIPPED WHEN ITS INPUTS ARE UNCHANGED. The full build costs
 * ~42s (~36s of it `packages/llmwiki-core`, mostly `dts: true`), which a
 * developer paid again on every run even to execute a single 7ms unit file. A
 * content hash of the build inputs in `.llmwiki/build-stamp.json` decides this;
 * see `scripts/build-stamp.ts`. Every uncertainty rebuilds — a stale build
 * silently tests the wrong code, which is far worse than a slow run.
 *
 * Set `LLMWIKI_TEST_FORCE_BUILD=1` to bypass the cache entirely, e.g. after
 * suspecting a stale artifact.
 *
 * Invokes tsup's CLI with the Node binary ALREADY running this process, rather
 * than through `npx`. On Windows `npx` is `npx.cmd`, and since the Node 22
 * hardening for CVE-2024-27980 `child_process` no longer resolves `.cmd`/`.bat`
 * without `shell: true` — so `execFile("npx", …)` failed with ENOENT there,
 * aborting collection before a single test loaded. vitest then reported the
 * confusingly unrelated "No test files found", which points nowhere near the
 * cause. CI is Linux-only today, so nothing caught it.
 *
 * `shell: true` would also fix it, but re-opens the argument-quoting hole that
 * hardening closed. Resolving the CLI entry and running it directly needs no
 * shell at all and behaves identically on every platform.
 */

import { execFile } from "child_process";
import { resolveTsupCli } from "../scripts/tsup-command.js";
import { clearStamp, isBuildFresh, writeStamp } from "../scripts/build-stamp.js";
import { promisify } from "util";
import path from "path";

const exec = promisify(execFile);

/** Escape hatch for a deliberately forced rebuild. */
const FORCE_BUILD_ENV_VAR = "LLMWIKI_TEST_FORCE_BUILD";

/** True when the caller asked to bypass the cache. */
function forcedBuild(): boolean {
  return process.env[FORCE_BUILD_ENV_VAR] === "1";
}

/** Build once, then record the inputs it was built from. */
async function build(root: string): Promise<void> {
  await exec(process.execPath, [resolveTsupCli()], { cwd: root });
  writeStamp(root);
}

export async function setup(): Promise<void> {
  const root = path.resolve(".");
  if (!forcedBuild() && isBuildFresh(root)) return;
  // Clear first so a failed build cannot leave a stamp that claims success.
  clearStamp(root);
  await build(root);
}
