const { createTypeReference, createInheritance } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts type references and inheritance relationships from a C++ Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} symbols - Extracted symbols for source linkage
 * @returns {{ typeReferences: Array<object>, inheritance: Array<object> }}
 */
function extractCppTypeFacts(rootNode, fileId, symbols = []) {
  const typeReferences = [];
  const inheritance = [];
  let typeRefCounter = 0;
  let inhCounter = 0;

  if (!rootNode) return { typeReferences, inheritance };

  // Lookup map of class/struct symbols
  const classSymbols = symbols.filter((s) => s.kind === "class" || s.kind === "struct");

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

  function traverse(node) {
    if (!node) return;

    const nodeType = node.type;

    // 1. Base class clause in class/struct definition
    if (nodeType === "base_class_clause") {
      const parentClassNode = node.parent;
      const nameNode =
        parentClassNode && parentClassNode.namedChildren.find((c) => c.type === "type_identifier");
      const classSymbol = nameNode
        ? classSymbols.find((s) => s.name === nameNode.text)
        : null;

      for (const child of node.namedChildren) {
        if (child.type === "access_specifier") continue;

        const targetText = child.text.trim();
        const location = mapNodeLocation(child);

        // Inheritance fact
        inheritance.push(
          createInheritance({
            fileId,
            index: inhCounter++,
            sourceSymbolId: classSymbol ? classSymbol.id : null,
            targetText,
            kind: "extends",
            location,
          })
        );

        // Type reference with inheritance context
        addTypeRef(targetText, "inheritance", child);
      }
    }

    // 2. C++ Template / Generic arguments
    else if (nodeType === "template_argument_list") {
      for (const child of node.namedChildren) {
        if (child.type === "type_descriptor" || child.type === "type_identifier") {
          // Check if parent is a C++ cast (static_cast<int>, dynamic_cast<T*>, etc.)
          const grandParent = node.parent;
          const isCast =
            grandParent &&
            grandParent.text &&
            [
              "static_cast",
              "dynamic_cast",
              "reinterpret_cast",
              "const_cast",
            ].some((p) => grandParent.text.startsWith(p));

          const context = isCast ? "cast" : "generic_argument";
          addTypeRef(child.text, context, child);
        }
      }
    }

    // 3. C-style cast expression
    else if (nodeType === "cast_expression") {
      const typeDesc = node.namedChildren.find((c) => c.type === "type_descriptor");
      if (typeDesc) {
        addTypeRef(typeDesc.text, "cast", typeDesc);
      }
    }

    // 4. Parameter declaration
    else if (nodeType === "parameter_declaration" || nodeType === "optional_parameter_declaration") {
      const typeNode = (node.childForFieldName && node.childForFieldName("type")) ||
        node.namedChildren.find(
          (c) =>
            [
              "primitive_type",
              "type_identifier",
              "sized_type_specifier",
              "template_type",
              "qualified_identifier",
            ].includes(c.type)
        );
      if (typeNode) {
        addTypeRef(typeNode.text, "parameter", typeNode);
      }
    }

    // 5. Function/Method return type
    else if (nodeType === "function_definition") {
      const typeNode = (node.childForFieldName && node.childForFieldName("type")) ||
        node.namedChildren.find(
          (c) =>
            [
              "primitive_type",
              "type_identifier",
              "sized_type_specifier",
              "template_type",
              "qualified_identifier",
              "auto",
            ].includes(c.type)
        );
      if (typeNode && typeNode.type !== "auto") {
        addTypeRef(typeNode.text, "return", typeNode);
      }
    }

    // 6. Variable or Field declaration
    else if (nodeType === "field_declaration" || nodeType === "declaration") {
      const typeNode = (node.childForFieldName && node.childForFieldName("type")) ||
        node.namedChildren.find(
          (c) =>
            [
              "primitive_type",
              "type_identifier",
              "sized_type_specifier",
              "template_type",
              "qualified_identifier",
            ].includes(c.type)
        );
      if (typeNode) {
        const isFnProto = node.namedChildren.some((c) => c.type === "function_declarator");
        addTypeRef(typeNode.text, isFnProto ? "return" : "variable", typeNode);
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
  extractCppTypeFacts,
};

