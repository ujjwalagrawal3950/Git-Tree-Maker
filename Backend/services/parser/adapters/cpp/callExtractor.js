const { createCallSite } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts call sites from a C++ Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} symbols - Extracted symbols for enclosing symbol correlation
 * @returns {Array<object>} Array of schema-compliant CallSite objects
 */
function extractCppCallSites(rootNode, fileId, symbols = []) {
  const callSites = [];
  let callCounter = 0;

  if (!rootNode) return callSites;

  // Callable symbols lookup (functions, methods, constructors)
  const callableSymbols = symbols.filter(
    (s) =>
      ["function", "method", "constructor"].includes(s.kind) &&
      s.languageMetadata &&
      s.languageMetadata.isDefinition
  );

  /**
   * Finds the enclosing symbol ID for a call site.
   */
  function findEnclosingSymbolId(callNode) {
    const startLine = callNode.startPosition.row + 1;
    const startCol = callNode.startPosition.column;

    for (const sym of callableSymbols) {
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

  function traverse(node) {
    if (!node) return;

    if (node.type === "call_expression") {
      const fnNode =
        (node.childForFieldName && node.childForFieldName("function")) || node.namedChildren[0];
      const argsNode =
        (node.childForFieldName && node.childForFieldName("arguments")) || node.namedChildren[1];

      if (fnNode) {
        const calleeText = fnNode.text.trim();

        // Skip C++ casts like static_cast<int>(x), which are semantic casts rather than function calls
        const isCast = [
          "static_cast",
          "dynamic_cast",
          "reinterpret_cast",
          "const_cast",
        ].some((castPrefix) => calleeText.startsWith(castPrefix));

        if (!isCast) {
          let calleeKind = "other";
          if (fnNode.type === "identifier") {
            calleeKind = "identifier";
          } else if (
            fnNode.type === "field_expression" ||
            fnNode.type === "qualified_identifier" ||
            fnNode.type === "template_method"
          ) {
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
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);

  return callSites;
}

module.exports = {
  extractCppCallSites,
};

