const ts = require("typescript");
const { createTypeReference, createInheritance } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Determines the syntactic context of a TypeScript type reference node.
 *
 * @param {import("typescript").Node} node
 * @returns {"parameter"|"return"|"variable"|"generic_argument"|"inheritance"|"cast"|"annotation"|"other"}
 */
function determineTypeContext(node) {
  let curr = node.parent;
  while (curr) {
    if (ts.isParameter(curr)) return "parameter";
    if (ts.isVariableDeclaration(curr) || ts.isPropertyDeclaration(curr) || ts.isPropertySignature(curr)) return "variable";
    if (ts.isFunctionDeclaration(curr) || ts.isMethodDeclaration(curr) || ts.isMethodSignature(curr) || ts.isArrowFunction(curr)) {
      if (curr.type && (curr.type === node || curr.type.pos <= node.pos && curr.type.end >= node.end)) {
        return "return";
      }
    }
    if (ts.isHeritageClause(curr)) return "inheritance";
    if (ts.isTypeReferenceNode(curr) && curr.typeArguments && curr.typeArguments.includes(node)) return "generic_argument";
    if (ts.isAsExpression(curr) || ts.isTypeAssertionExpression(curr)) return "cast";
    curr = curr.parent;
  }
  return "other";
}

/**
 * Extracts TypeScript type references and class/interface inheritance clauses.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {Array<object>} [symbols] - Pre-extracted symbols to link sourceSymbolId and enclosingSymbolId
 * @returns {{
 *   typeReferences: Array<object>,
 *   inheritance: Array<object>
 * }}
 */
function extractTypeFacts(sourceFile, fileId, symbols = []) {
  const typeReferences = [];
  const inheritance = [];
  let typeRefCounter = 0;
  let inhCounter = 0;

  // Build name-to-symbolId lookup for classes and interfaces
  const symbolMap = new Map();
  for (const sym of symbols) {
    if (sym.name && !symbolMap.has(sym.name)) {
      symbolMap.set(sym.name, sym.id);
    }
  }

  function isPositionInside(pos, symbol) {
    if (!symbol || !symbol.location) return false;
    const { start, end } = symbol.location;
    const { line, column } = pos;
    if (line < start.line || line > end.line) return false;
    if (line === start.line && column < start.column) return false;
    if (line === end.line && column >= end.column) return false;
    return true;
  }

  const CONTAINER_KINDS = new Set([
    "function",
    "method",
    "constructor",
    "class",
    "interface",
    "type_alias",
    "module",
    "namespace",
  ]);

  function findEnclosingSymbolId(pos) {
    let enclosing = null;
    for (const sym of symbols) {
      if (CONTAINER_KINDS.has(sym.kind) && isPositionInside(pos, sym)) {
        if (!enclosing || sym.parentSymbolId === enclosing.id) {
          enclosing = sym;
        }
      }
    }
    return enclosing ? enclosing.id : null;
  }

  function traverse(node) {
    if (!node) return;

    // 1. Heritage Clauses: extends and implements (Classes & Interfaces)
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = node.name ? node.name.text : null;
      const sourceSymbolId = name ? (symbolMap.get(name) || null) : null;

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";

          for (const type of clause.types) {
            const targetText = type.expression.getText(sourceFile);
            const location = mapNodeLocation(sourceFile, type);

            inheritance.push(
              createInheritance({
                fileId,
                index: inhCounter++,
                kind,
                targetText,
                sourceSymbolId,
                location,
              })
            );
          }
        }
      }
    }

    // 2. Type References (e.g. User, Promise<T>, React.FC)
    if (ts.isTypeReferenceNode(node)) {
      const text = node.typeName.getText(sourceFile);
      const location = mapNodeLocation(sourceFile, node);
      const context = determineTypeContext(node);
      const enclosingSymbolId = findEnclosingSymbolId(location.start);

      typeReferences.push(
        createTypeReference({
          fileId,
          index: typeRefCounter++,
          text,
          context,
          enclosingSymbolId,
          location,
          resolution: { status: "not_attempted", targetSymbolId: null },
        })
      );
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);

  return {
    typeReferences,
    inheritance,
  };
}

module.exports = {
  determineTypeContext,
  extractTypeFacts,
};
