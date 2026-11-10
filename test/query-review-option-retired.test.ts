/**
 * @file test/query-review-option-retired.test.ts
 * @description Absence proof for the retired query `review` option and the
 * saved-answer proposer it fed. The option promised an operator workflow
 * (`review approve`) that no surface implements, so it is removed rather than
 * left accepting input it cannot honour.
 *
 * These assertions are derived from the source tree and from the module's own
 * export surface, never from a hand-maintained list of call sites: a new caller
 * of a retired symbol makes them fail without anyone editing this file.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as candidatesModule from "../packages/wiki/src/compiler/candidates.js";
import * as publicationModule from "../packages/wiki/src/commands/query-publication.js";

const SRC_ROOT = path.join(__dirname, "..", "packages", "wiki", "src");
const PROPOSER_MODULE = path.join(SRC_ROOT, "commands", "query-proposal.ts");
const RETIRED_SYMBOLS = ["writeFreshCandidate", "stageQueryProposal", "assertQuerySaveOptions"];

/** Repository-relative label for one source file, for readable failures. */
function relative(file: string): string {
  return path.relative(path.join(__dirname, ".."), file).split(path.sep).join("/");
}

/** Every TypeScript source file under the wiki package, discovered by walking. */
async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_ROOT, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Files naming any retired symbol, as `path: symbol` pairs. */
async function filesNamingRetiredSymbols(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const symbol of RETIRED_SYMBOLS) {
      if (source.includes(symbol)) found.push(`${relative(file)}: ${symbol}`);
    }
  }
  return found;
}

describe("retired query review option", () => {
  it("leaves no module naming a retired symbol", async () => {
    expect(await filesNamingRetiredSymbols()).toEqual([]);
  });

  it("removes the saved-answer proposer module", () => {
    expect(existsSync(PROPOSER_MODULE)).toBe(false);
  });

  it("offers no retired symbol on the surviving module surfaces", () => {
    for (const symbol of RETIRED_SYMBOLS) {
      expect(Object.keys(candidatesModule)).not.toContain(symbol);
      expect(Object.keys(publicationModule)).not.toContain(symbol);
    }
  });
});
