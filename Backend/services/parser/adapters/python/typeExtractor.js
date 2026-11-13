const { createTypeReference, createInheritance } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts Python type references and class inheritance hierarchies from a Tree-sitter AST.
 *
 * Supported forms:
 * - Base classes: `class Dog(Animal, Mammal):` -> inheritance (kind: "extends")
 * - Metaclasses: `class Model(metaclass=ModelMeta):` -> inheritance (kind: "extends")
 * - Parameter annotations: `def foo(x: int, y: List[str] = None):` -> typeReference (context: "parameter")
 * - Return type annotations: `def foo() -> bool:` -> typeReference (context: "return")
 * - Variable annotations: `x: int = 5`, `cache: Dict[str, Any]` -> typeReference (context: "variable")
 * - Generic argument types: `List[User]`, `Dict[str, int]` -> typeReference (context: "generic_argument")
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @param {string} sourceText
 * @param {string} fileId
 * @param {Array<object>} [symbols] - Pre-extracted symbols to identify sourceSymbolId and enclosingSymbolId
 * @returns {{
 *   typeReferences: Array<object>,
 *   inheritance: Array<object>
 * }}
 */
function extractTypeFacts(rootNode, sourceText, fileId, symbols = []) {
  if (!rootNode) return { typeReferences: [], inheritance: [] };

  const typeReferences = [];
  const inheritance = [];
  let typeRefCounter = 0;
  let inhCounter = 0;

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

  function findClassSymbolId(node) {
    const loc = mapNodeLocation(node, sourceText);
    const sym = symbols.find(
      (s) => s.kind === "class" && isPositionInside(loc.start, s)
    );
    return sym ? sym.id : null;
  }

  // Iterative traversal
  const stack = [rootNode];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    // 1. Class inheritance
    if (node.type === "class_definition") {
      const superclasses = node.childForFieldName("superclasses");
      if (superclasses) {
        const sourceSymbolId = findClassSymbolId(node);

        for (const child of superclasses.namedChildren) {
          let targetText = "";
          let kind = "extends";

          if (child.type === "keyword_argument") {
            const nameNode = child.childForFieldName("name");
            const valNode = child.childForFieldName("value");
            if (nameNode && nameNode.text === "metaclass" && valNode) {
              targetText = valNode.text;
            } else if (valNode) {
              targetText = child.text;
            }
          } else {
            targetText = child.text;
          }

          if (targetText) {
            const location = mapNodeLocation(child, sourceText);
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

    // 2. Return type annotations on function / async function
    if (node.type === "function_definition" || node.type === "async_function_definition") {
      const returnTypeNode = node.childForFieldName("return_type");
      if (returnTypeNode) {
        const loc = mapNodeLocation(returnTypeNode, sourceText);
        const enclosingSymbolId = findEnclosingSymbolId(loc.start);

        typeReferences.push(
          createTypeReference({
            fileId,
            index: typeRefCounter++,
            text: returnTypeNode.text.replace(/^->\s*/, "").trim(),
            context: "return",
            enclosingSymbolId,
            location: loc,
            resolution: { status: "not_attempted", targetSymbolId: null },
          })
        );
      }
    }

    // 3. Parameter type annotations
    if (node.type === "typed_parameter" || node.type === "typed_default_parameter") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        const loc = mapNodeLocation(typeNode, sourceText);
        const enclosingSymbolId = findEnclosingSymbolId(loc.start);

        typeReferences.push(
          createTypeReference({
            fileId,
            index: typeRefCounter++,
            text: typeNode.text.trim(),
            context: "parameter",
            enclosingSymbolId,
            location: loc,
            resolution: { status: "not_attempted", targetSymbolId: null },
          })
        );
      }
    }

    // 4. Variable assignment type annotations (e.g. x: int = 5)
    if (node.type === "assignment") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        const loc = mapNodeLocation(typeNode, sourceText);
        const enclosingSymbolId = findEnclosingSymbolId(loc.start);

        typeReferences.push(
          createTypeReference({
            fileId,
            index: typeRefCounter++,
            text: typeNode.text.trim(),
            context: "variable",
            enclosingSymbolId,
            location: loc,
            resolution: { status: "not_attempted", targetSymbolId: null },
          })
        );
      }
    }

    // Push children in reverse order
    for (let i = node.childCount - 1; i >= 0; i--) {
      stack.push(node.child(i));
    }
  }

  return {
    typeReferences,
    inheritance,
  };
}

module.exports = {
  extractTypeFacts,
};

