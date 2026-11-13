const { createCallSite } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts syntactic call sites and constructor-like invocations from a Tree-sitter Python AST.
 *
 * Supported forms:
 * - Direct function calls: `foo()`
 * - Member/attribute calls: `obj.method()`, `module.func()`
 * - Constructor-like calls: `User()`, `ClassName()` (syntactic heuristic: PascalCase identifier)
 * - Super calls: `super().__init__()`
 *
 * Excludes dynamic import machinery calls (`__import__()`, `importlib.import_module()`) as those
 * are captured as imports by importExtractor.
 * Does NOT guess semantic targets. Leaves resolution as `status: "not_attempted"`.
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode - Root node of Tree-sitter parse tree
 * @param {string} sourceText - Complete Python source code
 * @param {string} fileId - Unique identifier of the file
 * @param {Array<object>} [symbols] - Pre-extracted symbols to identify enclosingSymbolId
 * @returns {Array<object>} Normalized callSite objects conforming to IR_SCHEMA.json
 */
function extractCallSites(rootNode, sourceText, fileId, symbols = []) {
  if (!rootNode) return [];

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

  // Iterative traversal to safely handle deeply nested syntax trees
  const stack = [rootNode];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.type === "call") {
      const funcNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");

      if (funcNode) {
        const calleeText = funcNode.text || "anonymous";

        // Exclude dynamic imports handled by importExtractor
        const isDynamicImport =
          calleeText === "__import__" ||
          calleeText === "importlib.import_module" ||
          calleeText.endsWith(".import_module");

        if (!isDynamicImport) {
          const location = mapNodeLocation(node, sourceText);
          const enclosingSymbolId = findEnclosingSymbolId(location.start);

          let calleeKind = "other";
          if (funcNode.type === "attribute") {
            calleeKind = "member_expression";
          } else if (funcNode.type === "identifier") {
            // PascalCase heuristic for Python constructors (e.g. MyClass(), UserService())
            if (/^[A-Z][a-zA-Z0-9]*$/.test(calleeText) && !/^[A-Z0-9_]+$/.test(calleeText)) {
              calleeKind = "constructor";
            } else {
              calleeKind = "identifier";
            }
          }

          let argumentCount = 0;
          if (argsNode) {
            argumentCount = argsNode.namedChildren.length;
          }

          callSites.push(
            createCallSite({
              fileId,
              index: callCounter++,
              calleeText,
              calleeKind,
              enclosingSymbolId,
              argumentCount,
              location,
              resolution: { status: "not_attempted", targetSymbolId: null },
            })
          );
        }
      }
    }

    // Push children in reverse order so left-to-right order is maintained during traversal
    for (let i = node.childCount - 1; i >= 0; i--) {
      stack.push(node.child(i));
    }
  }

  return callSites;
}

module.exports = {
  extractCallSites,
};

