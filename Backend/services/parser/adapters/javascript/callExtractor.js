const ts = require("typescript");
const { createCallSite } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts syntactic call sites and constructor invocations from a TypeScript SourceFile AST.
 *
 * Supported forms:
 * - Direct function calls: `foo()`
 * - Member method calls: `console.log()`, `object.method()`
 * - Constructor calls: `new UserService()`
 * - Optional chaining calls: `callback?.()`
 * - Super calls: `super()`
 *
 * Excludes ESM dynamic imports (`import()`) and CommonJS `require()` as those are handled as imports.
 * Does NOT guess semantic targets. Leaves resolution as `status: "not_attempted"`.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {Array<object>} [symbols] - Optional pre-extracted symbols to identify enclosingSymbolId
 * @returns {Array<object>} Normalized callSite objects conforming to IR_SCHEMA.json
 */
function extractCallSites(sourceFile, fileId, symbols = []) {
  const callSites = [];
  let callCounter = 0;

  function isPositionInside(pos, symbol) {
    if (!symbol || !symbol.location) return false;
    const { start, end } = symbol.location;
    const { line, column } = pos;
    if (line < start.line || line > end.line) return false;
    if (line === start.line && column < start.column) return false;
    if (line === end.line && column >= end.column) return false;
    return true;
  }

  const CALLABLE_CONTAINER_KINDS = new Set([
    "function",
    "method",
    "constructor",
    "class",
    "module",
    "namespace",
  ]);

  function findEnclosingSymbolId(pos) {
    // Search innermost enclosing callable or container symbol
    let enclosing = null;
    for (const sym of symbols) {
      if (CALLABLE_CONTAINER_KINDS.has(sym.kind) && isPositionInside(pos, sym)) {
        if (!enclosing || sym.parentSymbolId === enclosing.id) {
          enclosing = sym;
        }
      }
    }
    return enclosing ? enclosing.id : null;
  }

  function traverse(node) {
    if (!node) return;

    // 1. Regular Function / Method / Member Call
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // Skip dynamic import() and require()
      const isDynamicImport = expr && expr.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(expr) && expr.text === "require";

      if (!isDynamicImport && !isRequire) {
        const location = mapNodeLocation(sourceFile, node);
        const enclosingSymbolId = findEnclosingSymbolId(location.start);

        let calleeKind = "other";
        let calleeText = "anonymous";

        if (expr) {
          calleeText = expr.getText(sourceFile);
          if (ts.isIdentifier(expr) || expr.kind === ts.SyntaxKind.SuperKeyword) {
            calleeKind = "identifier";
          } else if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
            calleeKind = "member_expression";
          }
        }

        callSites.push(
          createCallSite({
            fileId,
            index: callCounter++,
            calleeText,
            calleeKind,
            enclosingSymbolId,
            argumentCount: node.arguments ? node.arguments.length : 0,
            location,
            resolution: { status: "not_attempted", targetSymbolId: null },
          })
        );
      }
    }

    // 2. Constructor New Invocations: new ClassName(...)
    if (ts.isNewExpression(node)) {
      const expr = node.expression;
      const location = mapNodeLocation(sourceFile, node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start);

      const calleeText = expr ? expr.getText(sourceFile) : "anonymous";
      const argumentCount = node.arguments ? node.arguments.length : 0;

      callSites.push(
        createCallSite({
          fileId,
          index: callCounter++,
          calleeText,
          calleeKind: "constructor",
          enclosingSymbolId,
          argumentCount,
          location,
          resolution: { status: "not_attempted", targetSymbolId: null },
        })
      );
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return callSites;
}

module.exports = {
  extractCallSites,
};
