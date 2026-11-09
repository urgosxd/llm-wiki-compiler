/**
 * @file test/artifact/mcp-import-surface.test.ts
 * @description Pins the ABSENCE of the `compiler-cli` barrel from the MCP server
 * surface: zero `compiler-cli` module specifiers anywhere under
 * `packages/wiki/src/mcp/`, recursively.
 *
 * ## Why this pin exists
 *
 * `packages/wiki/src/compiler-cli.ts` is 102 lines holding 77 `export … from`
 * clauses over 64 distinct modules, so an MCP module that imports through the
 * barrel pulls every module the CLI barrel reaches into the MCP server process —
 * one of them being the host module that mounts the MCP tools, which is the cycle
 * `host/mcp-http.ts` documents and avoids by injecting its server factory. The
 * import rewrite that removed the barrel edge is the fix; this file is what keeps
 * it removed. `fallow` only reports the cycle after someone reintroduces the static
 * edge; a test reports it in the same run that introduced it.
 *
 * ## Why the matcher is not line-anchored
 *
 * The barrel imports in this codebase were MULTI-LINE: the `import` keyword and its
 * brace opened one line, the symbol list sat on the next, and the `from` clause with
 * the barrel specifier sat on a third. The specifier was therefore on a CONTINUATION
 * line, so a matcher that tested each line for `/^\s*(import|export)\b/` never saw it
 * and a reintroduced multi-line import would sail past the pin. This file therefore
 * parses each file and collects the literal of every import/export `from` clause,
 * every dynamic `import(…)` call, every `require(…)` call and every `import(…)` type
 * node, reusing `test/fixtures/module-imports.ts` instead of re-implementing that
 * walk. Parsing also makes prose structurally invisible, which is what lets the three
 * explanatory mentions of `compiler-cli` in `job-tools.ts:33,37` and
 * `stack-tools.ts:27` keep passing: a comment is not a specifier, and a text scan
 * cannot always tell.
 *
 * ## Fail closed
 *
 * The collected file set is asserted non-empty BEFORE any specifier is checked, so a
 * walk that read nothing cannot pass vacuously. The walk itself throws on any read
 * failure rather than returning a shorter list, for the same reason.
 */

import { expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { literalModuleImports } from "../fixtures/module-imports.js";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The surface this file pins: every module the MCP server process can reach from here. */
const MCP_SOURCE_ROOT = "packages/wiki/src/mcp";

/** Extension of the source files the pin walks. */
const SOURCE_EXTENSION = ".ts";

/** The barrel's basename, which is what makes a specifier re-enter it. */
const BARREL_MODULE_NAME = "compiler-cli";

/** Extensions a specifier may carry while still naming that same module. */
const SPECIFIER_EXTENSIONS: readonly string[] = [`${BARREL_MODULE_NAME}.ts`, `${BARREL_MODULE_NAME}.js`];

/** Scratch-directory prefix, distinctive so a leaked one is traceable to this file. */
const SCRATCH_PREFIX = "llmwiki-mcp-surface-";

/**
 * A barrel import split over lines exactly as the pre-rewrite source wrote it: the
 * specifier is on a continuation line, nowhere near the `import` keyword.
 */
const MULTI_LINE_BARREL_IMPORT = `import {
  withPageScan,
} from "@atomicstrata/llmwiki-core/compiler-cli";
`;

/** The same edge on one line, the shape a line-anchored matcher would catch. */
const SINGLE_LINE_BARREL_IMPORT = 'import { withPageScan } from "@atomicstrata/llmwiki-core/compiler-cli";\n';

/** Re-export and dynamic-import forms, both of which are edges to the barrel too. */
const OTHER_BARREL_FORMS = `export { withPageScan } from "@atomicstrata/llmwiki-core/compiler-cli";
const tools = await import("@atomicstrata/llmwiki-core/compiler-cli");
import "@atomicstrata/llmwiki-core/compiler-cli";
`;

/**
 * The three explanatory comments that name the barrel in PROSE. They are the reason
 * this matcher works on parsed specifiers and not on raw text: a text scan over
 * these lines reports two of its own comments as violations.
 */
const BARREL_PROSE_COMMENTS = `// Imported by relative path, NOT through \`compiler-cli\`.
// re-exporting them from \`compiler-cli.ts\` broke \`npm run build\` with
// Relative, not through \`compiler-cli\`, for the reason recorded in \`job-tools.ts\`.
import { relativeSymbol } from "../defining-module.js";
`;

/**
 * Every module specifier in one file, whatever its line layout.
 *
 * `literalModuleImports` parses the file and collects the literal of every
 * import/export `from` clause, dynamic `import(…)` call, `require(…)` call and
 * `import(…)` type node — so a clause split over lines is exactly as visible as a
 * single-line one, and a comment that names the barrel is invisible because it is not
 * a node. Shared with the boundary fixtures rather than re-implemented here.
 */
async function specifiersOf(file: string): Promise<string[]> {
  return literalModuleImports(file);
}

/** True when a specifier names the barrel, by package path or by relative path. */
function namesBarrel(specifier: string): boolean {
  const segment = specifier.split("/").pop() ?? specifier;
  return segment === BARREL_MODULE_NAME || SPECIFIER_EXTENSIONS.includes(segment);
}

/** One collected source file and every module specifier its own syntax names. */
interface SourceSpecifiers {
  /** Repository-relative path, which is how a violation reports the file. */
  readonly file: string;
  /** Every module specifier the file names, in source order. */
  readonly specifiers: readonly string[];
}

/**
 * Every `.ts` file under one directory, walked recursively, with its parsed
 * specifiers.
 *
 * A read failure PROPAGATES with the directory named: an under-collected walk must
 * fail here rather than pass the pin below with a shorter list.
 *
 * @param directory - Absolute directory to walk.
 * @returns One entry per collected file.
 */
async function specifiersUnder(directory: string): Promise<SourceSpecifiers[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected: SourceSpecifiers[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...(await specifiersUnder(absolutePath)));
    else if (entry.isFile() && entry.name.endsWith(SOURCE_EXTENSION)) {
      collected.push({ file: relativeToRoot(absolutePath), specifiers: await specifiersOf(absolutePath) });
    }
  }
  return collected;
}

/** Repository-relative spelling of an absolute path, in forward-slash form. */
function relativeToRoot(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

/**
 * Every barrel specifier one SOURCE TEXT yields, by writing it to a scratch file and
 * running the same matcher the real walk uses. Sharing the matcher is the point: a
 * synthetic probe that exercised a different one would prove nothing about the pin.
 */
async function barrelSpecifiersInSource(source: string): Promise<string[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), SCRATCH_PREFIX));
  try {
    const file = path.join(scratch, "synthetic.ts");
    await writeFile(file, source, "utf8");
    return (await specifiersOf(file)).filter(namesBarrel);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

it("pins the MCP surface free of the compiler-cli barrel", async () => {
  const collected = await specifiersUnder(path.join(REPO_ROOT, MCP_SOURCE_ROOT));
  expect(
    collected.length,
    `the MCP source root ${MCP_SOURCE_ROOT} must exist and hold .ts files, or this pin proves nothing`,
  ).toBeGreaterThan(0);
  const violations = collected.flatMap((entry) =>
    entry.specifiers.filter(namesBarrel).map((specifier) => `${entry.file}: ${specifier}`),
  );
  expect(
    violations,
    "an MCP module imported the compiler-cli barrel again, which drags the CLI module graph into the server process and re-closes the host cycle",
  ).toEqual([]);
});

it("detects a barrel specifier whose import clause is split over several lines", async () => {
  expect(
    await barrelSpecifiersInSource(MULTI_LINE_BARREL_IMPORT),
    "a multi-line import clause must be detected: the specifier sits on a continuation line",
  ).toEqual(["@atomicstrata/llmwiki-core/compiler-cli"]);
});

it("detects a barrel specifier on one line, and through re-export, dynamic and side-effect imports", async () => {
  expect(await barrelSpecifiersInSource(SINGLE_LINE_BARREL_IMPORT)).toEqual([
    "@atomicstrata/llmwiki-core/compiler-cli",
  ]);
  expect(await barrelSpecifiersInSource(OTHER_BARREL_FORMS), "every module-edge form counts").toEqual([
    "@atomicstrata/llmwiki-core/compiler-cli",
    "@atomicstrata/llmwiki-core/compiler-cli",
    "@atomicstrata/llmwiki-core/compiler-cli",
  ]);
});

it("never flags the prose comments that name the barrel, only real specifiers", async () => {
  expect(
    await barrelSpecifiersInSource(BARREL_PROSE_COMMENTS),
    "comments must keep passing: the three explanatory mentions in job-tools.ts and stack-tools.ts are prose, not edges",
  ).toEqual([]);
});
