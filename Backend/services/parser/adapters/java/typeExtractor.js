const { createTypeReference, createInheritance } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");
const { findEnclosingSymbolId } = require("./callExtractor");

/**
 * Extracts type references, generic arguments, and class/interface inheritance relationships
 * from a Java Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {Array<object>} [symbols]
 * @returns {{
 *   typeReferences: Array<object>,
 *   inheritance: Array<object>
 * }}
 */
function extractJavaTypeFacts(rootNode, fileId, symbols = []) {
  if (!rootNode) {
    return { typeReferences: [], inheritance: [] };
  }

  const typeReferences = [];
  const inheritance = [];
  let typeRefCounter = 0;
  let inhCounter = 0;

  function findSymbolForNode(node) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const name = nameNode.text;
    const loc = mapNodeLocation(node);
    return symbols.find(
      (s) => s.name === name && s.location && s.location.start.line === loc.start.line
    ) || null;
  }

  function addTypeRef(node, context) {
    if (!node) return;
    const text = node.text;
    if (!text) return;
    const location = mapNodeLocation(node);
    const enclosingSymbolId = findEnclosingSymbolId(location.start, symbols);

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

  function traverse(node) {
    if (!node) return;

    // 1. Inheritance and Class / Interface / Record Declarations
    if (node.type === "class_declaration") {
      const classSym = findSymbolForNode(node);
      const superclassNode = node.namedChildren.find((c) => c.type === "superclass");
      if (superclassNode) {
        // superclass named child is the type identifier or generic type
        for (const child of superclassNode.namedChildren) {
          inheritance.push(
            createInheritance({
              fileId,
              index: inhCounter++,
              kind: "extends",
              targetText: child.text,
              sourceSymbolId: classSym ? classSym.id : null,
              location: mapNodeLocation(child),
            })
          );
          addTypeRef(child, "inheritance");
        }
      }

      const interfacesNode = node.namedChildren.find((c) => c.type === "super_interfaces");
      if (interfacesNode) {
        const typeListNode = interfacesNode.namedChildren.find((c) => c.type === "type_list") || interfacesNode;
        for (const typeChild of typeListNode.namedChildren) {
          inheritance.push(
            createInheritance({
              fileId,
              index: inhCounter++,
              kind: "implements",
              targetText: typeChild.text,
              sourceSymbolId: classSym ? classSym.id : null,
              location: mapNodeLocation(typeChild),
            })
          );
          addTypeRef(typeChild, "inheritance");
        }
      }
    } else if (node.type === "interface_declaration") {
      const ifaceSym = findSymbolForNode(node);
      const extendsInterfacesNode = node.namedChildren.find((c) => c.type === "extends_interfaces");
      if (extendsInterfacesNode) {
        const typeListNode = extendsInterfacesNode.namedChildren.find((c) => c.type === "type_list") || extendsInterfacesNode;
        for (const typeChild of typeListNode.namedChildren) {
          inheritance.push(
            createInheritance({
              fileId,
              index: inhCounter++,
              kind: "extends",
              targetText: typeChild.text,
              sourceSymbolId: ifaceSym ? ifaceSym.id : null,
              location: mapNodeLocation(typeChild),
            })
          );
          addTypeRef(typeChild, "inheritance");
        }
      }
    } else if (node.type === "record_declaration") {
      const recordSym = findSymbolForNode(node);
      const interfacesNode = node.namedChildren.find((c) => c.type === "super_interfaces");
      if (interfacesNode) {
        const typeListNode = interfacesNode.namedChildren.find((c) => c.type === "type_list") || interfacesNode;
        for (const typeChild of typeListNode.namedChildren) {
          inheritance.push(
            createInheritance({
              fileId,
              index: inhCounter++,
              kind: "implements",
              targetText: typeChild.text,
              sourceSymbolId: recordSym ? recordSym.id : null,
              location: mapNodeLocation(typeChild),
            })
          );
          addTypeRef(typeChild, "inheritance");
        }
      }
    }

    // 2. Type References across parameters, return types, fields, local variables, casts
    if (node.type === "formal_parameter" || node.type === "spread_parameter") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        addTypeRef(typeNode, "parameter");
      }
    } else if (node.type === "method_declaration") {
      const typeNode = node.childForFieldName("type");
      if (typeNode && typeNode.text !== "void") {
        addTypeRef(typeNode, "return");
      }

      // Throws clause
      const throwsNode = node.namedChildren.find((c) => c.type === "throws");
      if (throwsNode) {
        for (const exc of throwsNode.namedChildren) {
          addTypeRef(exc, "other");
        }
      }
    } else if (node.type === "field_declaration" || node.type === "local_variable_declaration") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        addTypeRef(typeNode, "variable");
      }
    } else if (node.type === "cast_expression") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        addTypeRef(typeNode, "cast");
      }
    } else if (node.type === "type_arguments") {
      for (const arg of node.namedChildren) {
        addTypeRef(arg, "generic_argument");
      }
    } else if (node.type === "marker_annotation" || node.type === "annotation") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        addTypeRef(nameNode, "annotation");
      }
    }

    // Recurse children
    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);

  return {
    typeReferences,
    inheritance,
  };
}

module.exports = {
  extractJavaTypeFacts,
};

