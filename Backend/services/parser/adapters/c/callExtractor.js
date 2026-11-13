const { createCallSite } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts function call sites from a C Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} symbols - Extracted symbols for enclosing symbol correlation
 * @returns {Array<object>} Array of schema-compliant CallSite objects
 */
function extractCCallSites(rootNode, fileId, symbols = []) {
  const callSites = [];
  let callCounter = 0;

  if (!rootNode) return callSites;

  // Build a lookup map of function symbols with their location ranges
  const functionSymbols = symbols.filter(
    (s) => s.kind === "function" && s.languageKind === "function_definition"
  );

  /**
   * Finds the enclosing symbol ID for a given call node location.
   */
  function findEnclosingSymbolId(callNode) {
    const startLine = callNode.startPosition.row + 1;
    const startCol = callNode.startPosition.column;

    for (const sym of functionSymbols) {
      if (!sym.location) continue;
      const { start, end } = sym.location;
      const isAfterStart =
        startLine > start.line || (startLine === start.line && startCol >= start.column);
      const isBeforeEnd =
        startLine < end.line || (startLine === end.line && startCol < end.column);

      if (isAfterStart && isBeforeEnd) {
        return sym.id;
      }
    }
    return null;
  }

  /**
   * Traverses AST to find all call_expression nodes.
   */
  function traverse(node) {
    if (!node) return;

    if (node.type === "call_expression") {
      const fnNode = (node.childForFieldName && node.childForFieldName("function")) || node.namedChildren[0];
      const argsNode = (node.childForFieldName && node.childForFieldName("arguments")) || node.namedChildren[1];

      if (fnNode) {
        const calleeText = fnNode.text.trim();
        let calleeKind = "other";

        if (fnNode.type === "identifier") {
          calleeKind = "identifier";
        } else if (fnNode.type === "field_expression") {
          calleeKind = "member_expression";
        } else if (
          fnNode.type === "parenthesized_expression" ||
          fnNode.type === "pointer_expression"
        ) {
          calleeKind = "function_pointer";
        }

        let argumentCount = 0;
        if (argsNode && argsNode.type === "argument_list") {
          argumentCount = argsNode.namedChildren.length;
        }

        const enclosingSymbolId = findEnclosingSymbolId(node);
        const location = mapNodeLocation(node);

        callSites.push(
          createCallSite({
            fileId,
            index: callCounter++,
            calleeText,
            calleeKind,
            enclosingSymbolId,
            argumentCount,
            location,
          })
        );
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);

  return callSites;
}

module.exports = {
  extractCCallSites,
};

