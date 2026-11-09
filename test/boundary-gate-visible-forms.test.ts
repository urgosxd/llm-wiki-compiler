/**
 * @file test/boundary-gate-visible-forms.test.ts
 * @description The dimension boundary gate must see EVERY form that reaches
 * across the `wiki ↔ kg` boundary, not only static import declarations.
 *
 * `no-restricted-imports` visits `ImportDeclaration`/`ExportDeclaration` and
 * nothing else, so a dynamic `import()`, a type-level `typeof import()` and a
 * `vi.mock("llmwiki-kg")` factory were all invisible: the boundary leaked in
 * forms the gate could not report, which made any claim of a clean boundary
 * unprovable. The local `local/dimension-boundary` rule closes that gap.
 *
 * These cases run the REAL repository configuration through the ESLint Node
 * API, so what they assert is what `pnpm run lint` enforces — not a copy of the
 * patterns that could drift from it. Each case asserts the rule id, the exact
 * message and the number of messages, because a rule that fires with the wrong
 * text or fires twice corrupts the ratchet's baseline.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** The local flat-config plugin's namespace plus the rule name under test. */
const RULE_ID = "local/dimension-boundary";

/** The exact text `WIKI_TO_KG` carries, quoted so the gate cannot silently reword it. */
const WIKI_KG_MESSAGE =
  "wiki must not import kg: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";

/** The exact text `KG_TO_WIKI` carries, for the opposite direction. */
const KG_WIKI_MESSAGE =
  "kg must not import wiki: the target topology has api joining them (api → wiki, api → kg), with no wiki ↔ kg import.";

/** The phrase that marks the second category: a specifier the gate cannot read. */
const NON_LITERAL_FRAGMENT = "not a string literal";

/** Repository root, so a probe is linted as if it lived at its real path. */
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One instance is enough: the config is loaded once and reused by every case. */
const eslint = new ESLint({ cwd: repoRoot });

/** Lint a snippet at `file` through the real config and reduce it to what a reader checks. */
async function lintAs(file: string, code: string): Promise<{ ruleId: string | null; message: string }[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  return result.messages.map((message) => ({ ruleId: message.ruleId, message: message.message }));
}

/** The messages this rule produced, which is the only set these cases assert on. */
async function boundaryMessages(file: string, code: string): Promise<{ ruleId: string | null; message: string }[]> {
  return (await lintAs(file, code)).filter((message) => message.ruleId === RULE_ID);
}

describe("a literal specifier that crosses the boundary is reported", () => {
  it("reports a dynamic import of the kg package from a wiki-side source file", async () => {
    const messages = await boundaryMessages("src/boundary-probe.ts", 'void import("llmwiki-kg");');
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });

  it("reports a dynamic import by relative path, not only the bare package name", async () => {
    const code = 'void import("../../packages/llmwiki-kg/ts/src/db.js");';
    const messages = await boundaryMessages("test/boundary-probe.test.ts", code);
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });

  it("reports a vi.mock factory whose first argument names the kg package", async () => {
    const code = 'vi.mock("llmwiki-kg", () => ({}));';
    const messages = await boundaryMessages("test/boundary-probe.test.ts", code);
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });

  it("reports a type-level typeof import of the kg package", async () => {
    const code = 'type Probe = typeof import("llmwiki-kg");';
    const messages = await boundaryMessages("src/boundary-probe.ts", code);
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });
});

describe("a specifier the gate cannot read is its own category, never a silent pass", () => {
  it("reports an identifier specifier without attempting to resolve it", async () => {
    const code = 'const CONFIG_MODULE = "../../packages/llmwiki-kg/ts/src/config.js";\nvoid import(CONFIG_MODULE);';
    const messages = await boundaryMessages("test/boundary-probe.test.ts", code);
    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe(RULE_ID);
    expect(messages[0].message).toContain(NON_LITERAL_FRAGMENT);
  });

  it("reports a template literal with an expression in the same category", async () => {
    const code = "void import(`../packages/llmwiki-kg/ts/src/${name}.js`);";
    const messages = await boundaryMessages("test/boundary-probe.test.ts", code);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(NON_LITERAL_FRAGMENT);
  });
});

describe("what the rule must leave alone", () => {
  it("stays clean on a same-dimension dynamic import inside the wiki zone", async () => {
    const messages = await boundaryMessages("src/boundary-probe.ts", 'void import("./db.js");');
    expect(messages).toEqual([]);
  });

  it("stays clean on a kg-zone file dynamically importing its own neighbour", async () => {
    const code = 'void import("./db.js");';
    const messages = await boundaryMessages("packages/llmwiki-kg/ts/src/boundary-probe.ts", code);
    expect(messages).toEqual([]);
  });

  it("leaves static declarations to no-restricted-imports, so nothing is counted twice", async () => {
    const messages = await boundaryMessages("src/boundary-probe.ts", 'import "llmwiki-kg";');
    expect(messages).toEqual([]);
  });
});

describe("the kg zone is scanned in its own direction", () => {
  it("reports a dynamic import walking back into the wiki zone", async () => {
    const code = 'void import("../../../../src/dimensions/wiki/index.js");';
    const messages = await boundaryMessages("packages/llmwiki-kg/ts/src/boundary-probe.ts", code);
    expect(messages).toEqual([{ ruleId: RULE_ID, message: KG_WIKI_MESSAGE }]);
  });

  it("reports a vi.doMock of a wiki alias from the kg zone", async () => {
    const code = 'vi.doMock("llm-wiki-compiler", () => ({}));';
    const messages = await boundaryMessages("packages/llmwiki-kg/ts/src/boundary-probe.test.ts", code);
    expect(messages).toEqual([{ ruleId: RULE_ID, message: KG_WIKI_MESSAGE }]);
  });
});

describe("the forms the widened gate must not regress", () => {
  it("keeps the api zone exempt from both directions", async () => {
    const code = 'void import("llmwiki-kg");\nvoid import("llm-wiki-compiler");';
    const messages = await lintAs("api/boundary-probe.ts", code);
    expect(messages).toEqual([]);
  });

  it("reports a kg package subpath, not only the bare package name", async () => {
    const messages = await boundaryMessages("src/boundary-probe.ts", 'void import("llmwiki-kg/server");');
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });

  it("reports a type-level import type without the typeof operator", async () => {
    const messages = await boundaryMessages("src/boundary-probe.ts", 'type C = import("llmwiki-kg").Config;');
    expect(messages).toEqual([{ ruleId: RULE_ID, message: WIKI_KG_MESSAGE }]);
  });
});
