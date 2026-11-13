const { createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Primitive Java type names.
 */
const JAVA_PRIMITIVE_TYPES = new Set([
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "boolean",
  "char",
  "void",
]);

/**
 * Builds a schema-compliant TypeDescriptor from a Java type node.
 *
 * @param {import("tree-sitter").SyntaxNode|null} typeNode
 * @returns {object|null}
 */
function buildTypeDescriptor(typeNode) {
  if (!typeNode) {
    return {
      text: null,
      kind: "unknown",
      isInferred: true,
    };
  }

  const text = typeNode.text ? typeNode.text.trim() : "unknown";
  const clean = text.toLowerCase();

  let kind = "named";
  if (JAVA_PRIMITIVE_TYPES.has(clean)) {
    kind = "primitive";
  } else if (text.endsWith("[]") || typeNode.type === "array_type") {
    kind = "array";
  } else if (text.includes("<") || typeNode.type === "generic_type") {
    kind = "generic";
  }

  return {
    text,
    kind,
    isInferred: false,
  };
}

/**
 * Extracts modifiers, visibility, and annotations from a Java modifiers node.
 *
 * @param {import("tree-sitter").SyntaxNode|null} modifiersNode
 * @returns {{
 *   visibility: "public"|"protected"|"private"|"internal",
 *   packagePrivate: boolean,
 *   modifiers: string[],
 *   annotations: Array<{ name: string, text: string }>
 * }}
 */
function extractModifiersAndAnnotations(modifiersNode) {
  const result = {
    visibility: "internal", // Package-private by default in Java
    packagePrivate: true,
    modifiers: [],
    annotations: [],
  };

  if (!modifiersNode || modifiersNode.type !== "modifiers") {
    return result;
  }

  for (let i = 0; i < modifiersNode.childCount; i++) {
    const child = modifiersNode.child(i);
    const type = child.type;
    const text = child.text.trim();

    if (type === "public") {
      result.visibility = "public";
      result.packagePrivate = false;
      result.modifiers.push("public");
    } else if (type === "protected") {
      result.visibility = "protected";
      result.packagePrivate = false;
      result.modifiers.push("protected");
    } else if (type === "private") {
      result.visibility = "private";
      result.packagePrivate = false;
      result.modifiers.push("private");
    } else if (
      [
        "static",
        "final",
        "abstract",
        "synchronized",
        "native",
        "default",
        "transient",
        "volatile",
        "sealed",
        "non-sealed",
        "strictfp",
      ].includes(type)
    ) {
      result.modifiers.push(type);
    } else if (type === "marker_annotation" || type === "annotation") {
      const nameNode = child.childForFieldName("name") || child.namedChild(0);
      const name = nameNode ? nameNode.text.replace(/^@/, "") : text.replace(/^@/, "");
      result.annotations.push({
        name,
        text,
      });
    }
  }

  return result;
}

/**
 * Extracts parameters from a Java formal_parameters node.
 *
 * @param {import("tree-sitter").SyntaxNode|null} paramsNode
 * @returns {Array<object>} Schema-compliant parameter objects
 */
function extractJavaParameters(paramsNode) {
  const parameters = [];
  if (!paramsNode || paramsNode.type !== "formal_parameters") {
    return parameters;
  }

  let pos = 0;
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const child = paramsNode.namedChild(i);
    let name = "arg";
    let typeNode = null;
    let variadic = false;

    if (child.type === "formal_parameter") {
      const nameNode = child.childForFieldName("name");
      const tNode = child.childForFieldName("type");
      name = nameNode ? nameNode.text : `arg${pos}`;
      typeNode = tNode;
    } else if (child.type === "spread_parameter") {
      // varargs e.g. Object... rest
      variadic = true;
      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j);
        if (c.type === "variable_declarator") {
          name = c.text;
        } else if (c.type.endsWith("_type") || c.type === "type_identifier") {
          typeNode = c;
        }
      }
    }

    const typeDesc = buildTypeDescriptor(typeNode);
    const location = mapNodeLocation(child);

    parameters.push({
      name,
      position: pos++,
      type: typeDesc,
      optional: false,
      variadic,
      defaultValueText: null,
      location,
    });
  }

  return parameters;
}

/**
 * Extracts declared package name from a Java program AST root.
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @returns {string|null}
 */
function extractPackageName(rootNode) {
  if (!rootNode) return null;
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i);
    if (child.type === "package_declaration") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j);
        if (c.type === "scoped_identifier" || c.type === "identifier") {
          return c.text;
        }
      }
    }
  }
  return null;
}

/**
 * Extracts all schema-compliant symbols from a Java syntax tree.
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @param {string} sourceText
 * @param {string} fileId
 * @returns {{
 *   packageName: string|null,
 *   symbols: Array<object>
 * }}
 */
function extractJavaDeclarations(rootNode, sourceText, fileId) {
  const symbols = [];
  if (!rootNode) return { packageName: null, symbols };

  const packageName = extractPackageName(rootNode);
  let symCounter = 0;

  function getEnclosingTypeQualifiedName(parent) {
    let curr = parent;
    while (curr) {
      if (["class", "interface", "enum"].includes(curr.kind)) {
        return curr.qualifiedName;
      }
      curr = curr.parentSymbolId ? symbols.find((s) => s.id === curr.parentSymbolId) : null;
    }
    return null;
  }

  function traverse(node, parentSymbol = null) {
    if (!node) return;
    const type = node.type;

    // 1. Class Declaration
    if (type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);
      const enclosingTypeQname = getEnclosingTypeQualifiedName(parentSymbol);
      const qualifiedName = enclosingTypeQname
        ? `${enclosingTypeQname}.${name}`
        : (packageName ? `${packageName}.${name}` : name);

      const sym = createSymbol({
        fileId,
        index: symCounter++,
        name,
        qualifiedName,
        kind: "class",
        parentSymbolId: parentSymbol ? parentSymbol.id : null,
        location,
        nameLocation,
        visibility: modInfo.visibility,
        modifiers: modInfo.modifiers,
        isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
        languageMetadata: {
          packagePrivate: modInfo.packagePrivate,
          annotations: modInfo.annotations,
        },
      });

      symbols.push(sym);

      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym);
        }
      }
      return;
    }

    // 2. Record Declaration (Java 14+)
    if (type === "record_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      // Extract record components as parameters
      const paramsNode = node.childForFieldName("parameters") || node.namedChildren.find((c) => c.type === "formal_parameters");
      const parameters = extractJavaParameters(paramsNode);

      const enclosingTypeQname = getEnclosingTypeQualifiedName(parentSymbol);
      const qualifiedName = enclosingTypeQname
        ? `${enclosingTypeQname}.${name}`
        : (packageName ? `${packageName}.${name}` : name);

      const sym = createSymbol({
        fileId,
        index: symCounter++,
        name,
        qualifiedName,
        kind: "class",
        parentSymbolId: parentSymbol ? parentSymbol.id : null,
        location,
        nameLocation,
        parameters,
        visibility: modInfo.visibility,
        modifiers: modInfo.modifiers,
        isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
        languageMetadata: {
          isRecord: true,
          languageKind: "record",
          packagePrivate: modInfo.packagePrivate,
          annotations: modInfo.annotations,
        },
      });

      symbols.push(sym);

      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym);
        }
      }
      return;
    }

    // 3. Interface Declaration
    if (type === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      const enclosingTypeQname = getEnclosingTypeQualifiedName(parentSymbol);
      const qualifiedName = enclosingTypeQname
        ? `${enclosingTypeQname}.${name}`
        : (packageName ? `${packageName}.${name}` : name);

      const sym = createSymbol({
        fileId,
        index: symCounter++,
        name,
        qualifiedName,
        kind: "interface",
        parentSymbolId: parentSymbol ? parentSymbol.id : null,
        location,
        nameLocation,
        visibility: modInfo.visibility,
        modifiers: modInfo.modifiers,
        isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
        languageMetadata: {
          packagePrivate: modInfo.packagePrivate,
          annotations: modInfo.annotations,
        },
      });

      symbols.push(sym);

      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym);
        }
      }
      return;
    }

    // 4. Annotation Type Declaration (@interface)
    if (type === "annotation_type_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      const enclosingTypeQname = getEnclosingTypeQualifiedName(parentSymbol);
      const qualifiedName = enclosingTypeQname
        ? `${enclosingTypeQname}.${name}`
        : (packageName ? `${packageName}.${name}` : name);

      const sym = createSymbol({
        fileId,
        index: symCounter++,
        name,
        qualifiedName,
        kind: "interface",
        parentSymbolId: parentSymbol ? parentSymbol.id : null,
        location,
        nameLocation,
        visibility: modInfo.visibility,
        modifiers: modInfo.modifiers,
        isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
        languageMetadata: {
          isAnnotationType: true,
          languageKind: "annotation_type",
          packagePrivate: modInfo.packagePrivate,
          annotations: modInfo.annotations,
        },
      });

      symbols.push(sym);

      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym);
        }
      }
      return;
    }

    // 5. Enum Declaration
    if (type === "enum_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      const enclosingTypeQname = getEnclosingTypeQualifiedName(parentSymbol);
      const qualifiedName = enclosingTypeQname
        ? `${enclosingTypeQname}.${name}`
        : (packageName ? `${packageName}.${name}` : name);

      const sym = createSymbol({
        fileId,
        index: symCounter++,
        name,
        qualifiedName,
        kind: "enum",
        parentSymbolId: parentSymbol ? parentSymbol.id : null,
        location,
        nameLocation,
        visibility: modInfo.visibility,
        modifiers: modInfo.modifiers,
        isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
        languageMetadata: {
          packagePrivate: modInfo.packagePrivate,
          annotations: modInfo.annotations,
        },
      });

      symbols.push(sym);

      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child.type === "enum_constant") {
            const constNameNode = child.childForFieldName("name");
            const constName = constNameNode ? constNameNode.text : child.text;
            symbols.push(
              createSymbol({
                fileId,
                index: symCounter++,
                name: constName,
                qualifiedName: `${sym.qualifiedName}.${constName}`,
                kind: "enum_member",
                parentSymbolId: sym.id,
                location: mapNodeLocation(child),
                nameLocation: constNameNode ? mapNodeLocation(constNameNode) : null,
                visibility: "public",
                isExported: sym.isExported,
              })
            );
          } else {
            traverse(child, sym);
          }
        }
      }
      return;
    }

    // 6. Constructor Declaration
    if (type === "constructor_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const paramsNode = node.childForFieldName("parameters") || node.namedChildren.find((c) => c.type === "formal_parameters");
      const parameters = extractJavaParameters(paramsNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      symbols.push(
        createSymbol({
          fileId,
          index: symCounter++,
          name,
          qualifiedName: parentSymbol ? `${parentSymbol.qualifiedName}.${name}` : name,
          kind: "constructor",
          parentSymbolId: parentSymbol ? parentSymbol.id : null,
          location,
          nameLocation,
          parameters,
          visibility: modInfo.visibility,
          modifiers: modInfo.modifiers,
          isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
          languageMetadata: {
            packagePrivate: modInfo.packagePrivate,
            annotations: modInfo.annotations,
          },
        })
      );
      return;
    }

    // 7. Method Declaration
    if (type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const name = nameNode.text;
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const typeNode = node.childForFieldName("type");
      const returnType = buildTypeDescriptor(typeNode);
      const paramsNode = node.childForFieldName("parameters") || node.namedChildren.find((c) => c.type === "formal_parameters");
      const parameters = extractJavaParameters(paramsNode);
      const location = mapNodeLocation(node);
      const nameLocation = mapNodeLocation(nameNode);

      // Check throws clause
      const throwsNode = node.childForFieldName("throws") || node.namedChildren.find((c) => c.type === "throws");
      const throwsList = [];
      if (throwsNode) {
        for (let i = 0; i < throwsNode.namedChildCount; i++) {
          throwsList.push(throwsNode.namedChild(i).text);
        }
      }

      symbols.push(
        createSymbol({
          fileId,
          index: symCounter++,
          name,
          qualifiedName: parentSymbol ? `${parentSymbol.qualifiedName}.${name}` : name,
          kind: "method",
          parentSymbolId: parentSymbol ? parentSymbol.id : null,
          location,
          nameLocation,
          parameters,
          returnType,
          visibility: modInfo.visibility,
          modifiers: modInfo.modifiers,
          isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
          languageMetadata: {
            packagePrivate: modInfo.packagePrivate,
            annotations: modInfo.annotations,
            throws: throwsList,
          },
        })
      );
      return;
    }

    // 8. Field Declaration
    if (type === "field_declaration") {
      const modNode = node.childForFieldName("modifiers") || node.namedChildren.find((c) => c.type === "modifiers");
      const modInfo = extractModifiersAndAnnotations(modNode);
      const typeNode = node.childForFieldName("type");
      const fieldType = buildTypeDescriptor(typeNode);
      const isConstant = modInfo.modifiers.includes("static") && modInfo.modifiers.includes("final");

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type === "variable_declarator") {
          const nameNode = child.childForFieldName("name");
          if (nameNode) {
            const name = nameNode.text;
            symbols.push(
              createSymbol({
                fileId,
                index: symCounter++,
                name,
                qualifiedName: parentSymbol ? `${parentSymbol.qualifiedName}.${name}` : name,
                kind: isConstant ? "constant" : "field",
                parentSymbolId: parentSymbol ? parentSymbol.id : null,
                location: mapNodeLocation(child),
                nameLocation: mapNodeLocation(nameNode),
                visibility: modInfo.visibility,
                modifiers: modInfo.modifiers,
                returnType: fieldType,
                isExported: modInfo.visibility === "public" || modInfo.visibility === "protected",
                languageMetadata: {
                  packagePrivate: modInfo.packagePrivate,
                  annotations: modInfo.annotations,
                },
              })
            );
          }
        }
      }
      return;
    }

    // Recurse into generic child nodes
    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i), parentSymbol);
    }
  }

  traverse(rootNode, null);
  return {
    packageName,
    symbols,
  };
}

module.exports = {
  buildTypeDescriptor,
  extractModifiersAndAnnotations,
  extractJavaParameters,
  extractPackageName,
  extractJavaDeclarations,
  extractDeclarations: extractJavaDeclarations,
};

