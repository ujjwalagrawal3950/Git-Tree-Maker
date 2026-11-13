const { createTypeReference } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts type references (parameter types, return types, variable types, cast types, field types)
 * from a C Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} symbols - Extracted symbols for enclosing symbol correlation
 * @returns {{ typeReferences: Array<object>, inheritance: Array<object> }}
 */
function extractCTypeFacts(rootNode, fileId, symbols = []) {
  const typeReferences = [];
  const inheritance = []; // C does not have inheritance
  let typeRefCounter = 0;

  if (!rootNode) {
    return { typeReferences, inheritance };
  }

  // Symbol lookup map for enclosingSymbolId
  function findEnclosingSymbolId(node) {
    const startLine = node.startPosition.row + 1;
    const startCol = node.startPosition.column;

    for (const sym of symbols) {
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

  function addTypeRef(text, context, node) {
    if (!text || typeof text !== "string") return;
    const cleanText = text.trim();
    if (!cleanText || cleanText === "void") return;

    const enclosingSymbolId = findEnclosingSymbolId(node);
    const location = mapNodeLocation(node);

    typeReferences.push(
      createTypeReference({
        fileId,
        index: typeRefCounter++,
        text: cleanText,
        context,
        enclosingSymbolId,
        location,
      })
    );
  }

  /**
   * Traverses AST to extract type references from various syntax contexts.
   */
  function traverse(node) {
    if (!node) return;

    // 1. Cast expression: (int)x or (char *)ptr
    if (node.type === "cast_expression") {
      const typeDesc = node.namedChildren.find((c) => c.type === "type_descriptor");
      if (typeDesc) {
        addTypeRef(typeDesc.text, "cast", typeDesc);
      }
    }

    // 2. Parameter declaration: int a, const char *msg
    else if (node.type === "parameter_declaration") {
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "sized_type_specifier" ||
          c.type === "struct_specifier" ||
          c.type === "union_specifier" ||
          c.type === "enum_specifier"
      );
      if (typeNode) {
        addTypeRef(typeNode.text, "parameter", typeNode);
      }
    }

    // 3. Function definition return type
    else if (node.type === "function_definition") {
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "sized_type_specifier" ||
          c.type === "struct_specifier" ||
          c.type === "union_specifier" ||
          c.type === "enum_specifier"
      );
      if (typeNode) {
        addTypeRef(typeNode.text, "return", typeNode);
      }
    }

    // 4. Struct / union field declaration type
    else if (node.type === "field_declaration") {
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "sized_type_specifier" ||
          c.type === "struct_specifier" ||
          c.type === "union_specifier" ||
          c.type === "enum_specifier"
      );
      if (typeNode) {
        addTypeRef(typeNode.text, "other", typeNode);
      }
    }

    // 5. Type definition (typedef source type)
    else if (node.type === "type_definition") {
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "sized_type_specifier" ||
          c.type === "struct_specifier" ||
          c.type === "union_specifier" ||
          c.type === "enum_specifier"
      );
      if (typeNode) {
        addTypeRef(typeNode.text, "other", typeNode);
      }
    }

    // 6. Variable declaration type
    else if (node.type === "declaration") {
      const typeNode = node.namedChildren.find(
        (c) =>
          c.type === "primitive_type" ||
          c.type === "type_identifier" ||
          c.type === "sized_type_specifier" ||
          c.type === "struct_specifier" ||
          c.type === "union_specifier" ||
          c.type === "enum_specifier"
      );
      // Check if this declaration is a function prototype
      const isFunctionProto = node.namedChildren.some(
        (c) =>
          c.type === "function_declarator" ||
          (c.type === "pointer_declarator" &&
            c.namedChildren.some((inner) => inner.type === "function_declarator"))
      );
      if (typeNode) {
        const context = isFunctionProto ? "return" : "variable";
        addTypeRef(typeNode.text, context, typeNode);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);

  return { typeReferences, inheritance };
}

module.exports = {
  extractCTypeFacts,
};

