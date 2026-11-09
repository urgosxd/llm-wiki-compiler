/**
 * @file Refuse a boundary zone that names a directory the tree does not have.
 *
 * A zone is a directory spelling, and a zone that matches no files reports zero
 * violations — indistinguishable from a clean tree. That failure mode bit this
 * slice twice: `API_ZONE = tree("api/")` was inert while `@repo/api` lived at
 * `packages/api/`, and `WIKI_ZONE` would have gone blind the moment the source
 * moved to `packages/wiki/`. Both were caught by re-deriving the census by hand,
 * never by a gate, so the spelling itself is pinned here.
 *
 * `eslint.config.mjs` is parsed rather than regex-scanned on purpose: its own
 * comments quote the pre-move spelling (`tree("api/")`) while explaining the
 * fix, and a text scan would fail on the explanation of the repair.
 */

import { readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The config whose zone spellings are pinned. */
const CONFIG = "eslint.config.mjs";

/** One zone directory the config derives, with the constant it is assigned to. */
interface Zone {
  owner: string;
  directory: string;
}

/** The directory a `tree("<literal>")` call names, or undefined for any other node. */
function treeLiteral(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.getText() !== "tree") return undefined;
  const [argument] = node.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

/** Every zone directory the config derives, with its owning constant where it has one. */
function zones(): Zone[] {
  const source = ts.createSourceFile(CONFIG, readFileSync(CONFIG, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Zone[] = [];
  const visit = (node: ts.Node, owner: string): void => {
    const named = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : owner;
    const directory = treeLiteral(node);
    if (directory !== undefined) found.push({ owner: named, directory });
    ts.forEachChild(node, (child) => visit(child, named));
  };
  visit(source, "");
  return found;
}

/** The house message a zone naming a missing directory fails with. */
function describeZone(zone: Zone): string {
  return zone.owner === ""
    ? `tree("${zone.directory}") names a directory the tree does not have`
    : `zone ${zone.owner} = tree("${zone.directory}") names a directory the tree does not have`;
}

/** Is this a directory that exists in the tree? */
function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

describe("eslint gate zones", () => {
  it("reads all three zone constants out of the config", () => {
    const owners = zones().map((zone) => zone.owner);
    expect(owners).toEqual(expect.arrayContaining(["WIKI_ZONE", "KG_ZONE", "API_ZONE"]));
  });

  it("names only directories the tree actually has", () => {
    const missing = zones().filter((zone) => !isDirectory(zone.directory));
    expect(missing.map(describeZone)).toEqual([]);
  });
});
