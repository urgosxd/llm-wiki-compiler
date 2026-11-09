/**
 * @file scripts/eslint-rules/dimension-boundary.mjs
 * @description The dimension boundary rule: report every specifier that reaches
 * across the `wiki ↔ kg` boundary, including the forms `no-restricted-imports`
 * cannot see.
 *
 * ## Why this rule exists
 *
 * `no-restricted-imports` visits `ImportDeclaration` and `ExportDeclaration` and
 * nothing else. Three real reach forms were therefore invisible to the gate: a
 * dynamic `import()` of `llmwiki-kg`, a type-level `typeof import()` of a
 * `packages/llmwiki-kg` module, and a `vi.mock`/`vi.doMock` factory whose first
 * argument names one. The boundary had been leaking in exactly those forms while
 * the gate reported a clean boundary, which would have made any later package
 * carve unprovable.
 *
 * ## It widens the gate, never the boundary
 *
 * The forbidden patterns and their messages are NOT defined here. The caller
 * passes the same `{ regex, message }` arrays `no-restricted-imports` already
 * receives from `eslint.config.mjs` (`WIKI_TO_KG.patterns`, `KG_TO_WIKI.patterns`),
 * so the rule can see more reach without permitting any: a pattern is a pattern
 * whichever visitor found the specifier, and a second re-encoded copy would be
 * free to drift from the first.
 *
 * ## Two categories, and never a silent pass
 *
 * - a specifier that is a plain string literal and matches a pattern is reported
 *   with that pattern's own message — the existing boundary text, unchanged;
 * - a specifier that is NOT a string literal (an identifier, a template literal
 *   with expressions, a concatenation) is reported as its own category instead of
 *   being ignored, and it is deliberately NOT resolved or evaluated: a module-scope
 *   `const X = "…/llmwiki-kg/…"` stays in this category, because a gate that
 *   guesses at constants reports a boundary it did not verify.
 *
 * Static declarations are deliberately not visited: `no-restricted-imports` owns
 * them, and reporting one site twice would inflate the frozen baseline count
 * without telling a reader anything new.
 */

/** The second category's message: stable text a test can match and a reader can tell apart. */
const NON_LITERAL_MESSAGE =
  "dimension boundary: the import specifier is not a string literal, so the gate cannot verify " +
  "which dimension it reaches; replace it with a string literal specifier that the boundary check can read.";

/** Every Vitest factory whose FIRST argument names a module. */
const MODULE_FACTORIES = new Set(["mock", "doMock", "importActual", "importMock"]);

/**
 * The value of a plain string literal node, or null for anything else.
 *
 * @param node - Any AST node.
 * @returns The literal string, or null when the node states no string literal.
 */
function stringLiteralValue(node) {
  const isStringLiteral = node.type === "Literal" && typeof node.value === "string";
  return isStringLiteral ? node.value : null;
}

/**
 * The string a specifier node states, or null when it is not a string literal.
 *
 * A type-level specifier reaches its string through a `TSLiteralType` wrapper, so
 * that node is unwrapped rather than counted as unreadable. Everything else — a
 * template literal even without substitutions, an identifier, a call — is the
 * non-literal category: a template is not a string literal, and pretending it is
 * would be static evaluation by another name.
 *
 * @param node - The specifier node, or the `undefined` of a call with no arguments.
 * @returns The literal string, or null when the node carries no string literal.
 */
function literalValue(node) {
  if (!node) return null;
  if (node.type === "TSLiteralType") return literalValue(node.literal);
  return stringLiteralValue(node);
}

/**
 * The property name of a plain, non-computed member access on an identifier.
 *
 * A computed or aliased access (`vi["mock"]`, `const m = vi.mock`) is out of scope
 * on purpose: guessing which calls are factories is the same mistake as guessing
 * constants, and every form that actually exists in this tree is the plain access.
 *
 * @param member - The callee node of a call expression.
 * @returns The method name, or null when this is not `identifier.method`.
 */
function memberName(member) {
  if (member.type !== "MemberExpression" || member.computed) return null;
  return member.property.type === "Identifier" ? member.property.name : null;
}

/**
 * Whether a callee is one of the four Vitest factories this rule inspects.
 *
 * @param member - The callee node of a call expression.
 * @returns True when the call is `vi.mock`, `vi.doMock`, `vi.importActual` or `vi.importMock`.
 */
function isViFactoryCallee(member) {
  const name = memberName(member);
  if (name === null) return false;
  return member.object.name === "vi" && MODULE_FACTORIES.has(name);
}

/**
 * How each visited node type yields the specifier node to inspect.
 *
 * A table rather than a chain of type tests, so adding a form is one line and the
 * dispatch cannot outgrow the house complexity rule. A call carries a specifier
 * only when it is a Vitest factory; anything else yields none.
 */
const SPECIFIER_OF = {
  ImportExpression: (node) => node.source,
  TSImportType: (node) => node.source ?? node.argument,
  CallExpression: (node) => specifierOfFactoryCall(node),
};

/**
 * The first argument of a Vitest factory call, which is the module it names.
 *
 * @param node - A call expression node.
 * @returns The specifier node, or null when this call is not a factory or has no arguments.
 */
function specifierOfFactoryCall(node) {
  if (!isViFactoryCallee(node.callee)) return null;
  return node.arguments[0] ?? null;
}

/**
 * The specifier node one visited node carries, or null when it carries none.
 *
 * @param node - A node from one of the visitors this rule registers.
 * @returns The node holding the specifier, or null to skip this node.
 */
function specifierOf(node) {
  const read = SPECIFIER_OF[node.type];
  return read === undefined ? null : read(node);
}

/**
 * The first configured pattern whose regex matches `specifier`.
 *
 * @param patterns - The caller's `{ regex, message }` array, used verbatim.
 * @param specifier - The literal specifier as written, never normalised.
 * @returns The matching pattern, or null when the specifier stays inside its dimension.
 */
function matchingPattern(patterns, specifier) {
  return patterns.find((pattern) => new RegExp(pattern.regex).test(specifier)) ?? null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Report every dynamic, type-level or mocked specifier that crosses the dimension boundary.",
    },
    schema: [
      {
        type: "object",
        properties: {
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: { regex: { type: "string" }, message: { type: "string" } },
              required: ["regex", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["patterns"],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { patterns = [] } = context.options[0] ?? {};

    /** Report one visited node: a forbidden reach, an unreadable specifier, or nothing. */
    function report(node) {
      const specifier = specifierOf(node);
      if (specifier === null) return;
      const value = literalValue(specifier);
      if (value === null) {
        context.report({ node: specifier, message: NON_LITERAL_MESSAGE });
        return;
      }
      const pattern = matchingPattern(patterns, value);
      if (pattern !== null) context.report({ node: specifier, message: pattern.message });
    }

    return {
      ImportExpression: report,
      TSImportType: report,
      CallExpression: report,
    };
  },
};
