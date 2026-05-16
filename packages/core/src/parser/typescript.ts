import ts from "typescript";
import type {
  ExportedSymbol,
  ParsedFile,
  RawImport,
  SymbolKind,
} from "../types.js";

/**
 * Parse a TypeScript or JavaScript source file. Extracts exported
 * functions/classes/variables and all import edges (static, dynamic,
 * require, re-export).
 *
 * Path should already be normalised (forward slashes, repo-relative).
 */
export function parseTypeScript(
  path: string,
  source: string,
  language: "typescript" | "javascript" = "typescript",
): ParsedFile {
  const scriptKind = pickScriptKind(path, language);
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const exports: ExportedSymbol[] = [];
  const imports: RawImport[] = [];

  visit(sourceFile);

  return { path, language, exports, imports };

  function visit(node: ts.Node): void {
    collectImports(node, sourceFile, imports);
    collectExports(node, sourceFile, exports, language);
    ts.forEachChild(node, visit);
  }
}

function pickScriptKind(
  path: string,
  language: "typescript" | "javascript",
): ts.ScriptKind {
  if (language === "javascript") {
    if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
    return ts.ScriptKind.JS;
  }
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function collectImports(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: RawImport[],
): void {
  // import x from "..."  /  import { } from "..."  /  import "..."
  if (ts.isImportDeclaration(node)) {
    const spec = stringLiteralValue(node.moduleSpecifier);
    if (spec !== null) {
      out.push({ kind: "static", specifier: spec, line: lineOf(node, sourceFile) });
    }
    return;
  }

  // export { } from "..."  /  export * from "..."
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
    const spec = stringLiteralValue(node.moduleSpecifier);
    if (spec !== null) {
      out.push({ kind: "reexport", specifier: spec, line: lineOf(node, sourceFile) });
    }
    return;
  }

  // import("...")
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const arg = node.arguments[0];
    const spec = arg ? stringLiteralValue(arg) : null;
    if (spec !== null) {
      out.push({ kind: "dynamic", specifier: spec, line: lineOf(node, sourceFile) });
    }
    return;
  }

  // require("...")
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  ) {
    const arg = node.arguments[0];
    const spec = arg ? stringLiteralValue(arg) : null;
    if (spec !== null) {
      out.push({ kind: "require", specifier: spec, line: lineOf(node, sourceFile) });
    }
  }
}

function collectExports(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: ExportedSymbol[],
  language: "typescript" | "javascript",
): void {
  // export function/class/const at the top level
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableStatement(node)) &&
    hasExportModifier(node)
  ) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.push({
        kind: "function",
        name: node.name.text,
        line: lineOf(node, sourceFile),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      out.push({
        kind: "class",
        name: node.name.text,
        line: lineOf(node, sourceFile),
        methods: collectMethods(node),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = bindingName(decl.name);
        if (name !== null) {
          out.push({
            kind: "variable",
            name,
            line: lineOf(decl, sourceFile),
          });
        }
      }
    }
    return;
  }

  // export default function/class
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    hasExportDefaultModifier(node)
  ) {
    const kind: SymbolKind = ts.isClassDeclaration(node) ? "class" : "function";
    out.push({
      kind,
      name: node.name?.text ?? "default",
      line: lineOf(node, sourceFile),
      ...(ts.isClassDeclaration(node) ? { methods: collectMethods(node) } : {}),
    });
    return;
  }

  // export { foo, bar }  (re-exports of locals)
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier === undefined &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    for (const spec of node.exportClause.elements) {
      out.push({
        kind: "variable",
        name: spec.name.text,
        line: lineOf(spec, sourceFile),
      });
    }
    return;
  }

  // CommonJS: `module.exports = ...` / `module.exports.foo = ...` / `exports.foo = ...`
  if (language === "javascript" && ts.isBinaryExpression(node)) {
    collectCommonJsExport(node, sourceFile, out);
  }
}

function collectCommonJsExport(
  expr: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
  out: ExportedSymbol[],
): void {
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;

  // exports.foo = ... | module.exports.foo = ... | module.exports = ...
  if (ts.isPropertyAccessExpression(expr.left)) {
    const root = leftmostName(expr.left);
    const tail = expr.left.name.text;
    if (root === "exports") {
      out.push({ kind: "variable", name: tail, line: lineOf(expr, sourceFile) });
      return;
    }
    if (root === "module" && isModuleExportsAccess(expr.left)) {
      out.push({ kind: "variable", name: tail, line: lineOf(expr, sourceFile) });
      return;
    }
  }

  if (
    ts.isPropertyAccessExpression(expr.left) &&
    ts.isIdentifier(expr.left.expression) &&
    expr.left.expression.text === "module" &&
    expr.left.name.text === "exports"
  ) {
    // module.exports = { a, b, c } — extract each property name
    if (ts.isObjectLiteralExpression(expr.right)) {
      for (const prop of expr.right.properties) {
        const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
        if (name !== null) {
          out.push({
            kind: "variable",
            name,
            line: lineOf(prop, sourceFile),
          });
        }
      }
    } else {
      out.push({
        kind: "variable",
        name: "default",
        line: lineOf(expr, sourceFile),
      });
    }
  }
}

function isModuleExportsAccess(node: ts.PropertyAccessExpression): boolean {
  // matches module.exports.X — node is module.exports.X, node.expression is module.exports
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "module" &&
    node.expression.name.text === "exports"
  );
}

function leftmostName(node: ts.Expression): string | null {
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

function collectMethods(klass: ts.ClassDeclaration): readonly string[] {
  const methods: string[] = [];
  for (const member of klass.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const name = member.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        methods.push(name.text);
      }
    }
  }
  return methods;
}

function stringLiteralValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function bindingName(name: ts.BindingName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  return null;
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some(
    (m) =>
      m.kind === ts.SyntaxKind.ExportKeyword &&
      !mods.some((mm) => mm.kind === ts.SyntaxKind.DefaultKeyword),
  );
}

function hasExportDefaultModifier(node: ts.HasModifiers): boolean {
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  const hasExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  return hasExport && hasDefault;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return line + 1;
}
