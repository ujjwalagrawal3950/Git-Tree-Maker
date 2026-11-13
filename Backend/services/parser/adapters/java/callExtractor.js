const { createCallSite } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Checks if a position falls within a symbol's location boundary.
 *
 * @param {object} pos
 * @param {object} symbol
 * @returns {boolean}
 */
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
  "interface",
  "enum",
  "module",
  "namespace",
]);

/**
 * Finds the innermost enclosing callable or container symbol for a position.
 *
 * @param {object} pos
 * @param {Array<object>} symbols
 * @returns {string|null}
 */
function findEnclosingSymbolId(pos, symbols = []) {
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

/**
 * Extracts syntactic call sites and invocations from a Java Tree-sitter AST.
 *
 * Supported forms:
 * - Direct method calls: `helper()`
 * - Member method invocations: `obj.method()`, `System.out.println()`
 * - Constructor invocations: `new UserService("db")`
 * - Explicit constructor invocations: `super(name);`, `this();`
 * - Method references: `MyService::print`
 *
 * Resolution is strictly unattempted (`status: "not_attempted"`).
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} [symbols]
 * @returns {Array<object>} Array of schema-compliant CallSite objects
 */
function extractJavaCallSites(rootNode, fileId, symbols = []) {
  if (!rootNode) return [];

  const callSites = [];
  let callCounter = 0;

  function traverse(node) {
    if (!node) return;

    if (node.type === "method_invocation") {
      const objectNode = node.childForFieldName("object");
      const nameNode = node.childForFieldName("name");
      const argsNode = node.childForFieldName("arguments");

      const calleeText = objectNode
        ? `${objectNode.text}.${nameNode ? nameNode.text : ""}`
        : nameNode
        ? nameNode.text
        : node.text;

      const calleeKind = objectNode ? "member_expression" : "identifier";
      const location = mapNodeLocation(node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);

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
    } else if (node.type === "object_creation_expression") {
      const typeNode = node.childForFieldName("type");
      const argsNode = node.childForFieldName("arguments");

      const calleeText = typeNode ? typeNode.text : "anonymous";
      const calleeKind = "constructor";
      const location = mapNodeLocation(node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);

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
    } else if (node.type === "explicit_constructor_invocation") {
      const constructorNode = node.childForFieldName("constructor");
      const argsNode = node.childForFieldName("arguments");

      const calleeText = constructorNode
        ? constructorNode.text
        : node.text.startsWith("super")
        ? "super"
        : "this";

      const calleeKind = "constructor";
      const location = mapNodeLocation(node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);

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
    } else if (node.type === "method_reference") {
      const location = mapNodeLocation(node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);

      callSites.push(
        createCallSite({
          fileId,
          index: callCounter++,
          calleeText: node.text,
          calleeKind: "function_pointer",
          enclosingSymbolId,
          argumentCount: 0,
          location,
          resolution: { status: "not_attempted", targetSymbolId: null },
        })
      );
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);
  return callSites;
}

module.exports = {
  extractJavaCallSites,
  findEnclosingSymbolId,
};

