/** Parse literal module edges for package and passive-history boundary checks. */
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Recognize syntax that names a module, including dynamic and type imports. */
function moduleSpecifier(node: ts.Node, source: ts.SourceFile): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  const typeArgument = importTypeArgument(node);
  if (typeArgument !== undefined) return typeArgument;
  return callSpecifier(node, source);
}

/**
 * The literal of an `import()` TYPE annotation, when the node is one.
 *
 * Kept separate because it is the one form that is neither a declaration nor a call,
 * and mixing it into the branch chain is what pushed the parent past the threshold.
 *
 * @param node - Node being visited.
 * @returns The literal, or undefined.
 */
function importTypeArgument(node: ts.Node): ts.Node | undefined {
  if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) return undefined;
  return node.argument.literal;
}

/**
 * The first argument of a dynamic `import()` or a `require()` call.
 *
 * @param node - Node being visited.
 * @param source - Source file, needed to read the callee's text.
 * @returns The argument, or undefined when this is not a module-loading call.
 */
function callSpecifier(node: ts.Node, source: ts.SourceFile): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = node.expression.getText(source) === "require";
  return isDynamicImport || isRequire ? node.arguments[0] : undefined;
}

/** Return literal import paths without resolving package or source identities. */
export function literalModuleImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node, source);
    if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
