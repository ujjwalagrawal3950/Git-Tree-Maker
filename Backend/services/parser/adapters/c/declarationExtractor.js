const { createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts all C symbols (functions, prototypes, structs, unions, enums,
 * enum members, typedefs, struct fields, file-scoped variables) from an AST root node.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} content - Raw source code content
 * @param {string} fileId - Normalized file identifier
 * @returns {Array<object>} Array of schema-compliant Symbol objects
 */
function extractCDeclarations(rootNode, content, fileId) {
  const symbols = [];
  let symbolCounter = 0;

  if (!rootNode) return symbols;

  /**
   * Helper to unwrap declarators to find the innermost name identifier.
   */
  function getDeclaratorNameNode(node) {
    let curr = node;
    while (curr) {
      if (curr.type === "identifier") return curr;
      if (curr.type === "field_identifier") return curr;
      if (curr.type === "type_identifier") return curr;
      if (curr.type === "init_declarator") {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else if (curr.type === "pointer_declarator" || curr.type === "array_declarator") {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else if (curr.type === "parenthesized_declarator") {
        curr = curr.namedChildren[0];
      } else if (curr.type === "function_declarator") {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else {
        break;
      }
    }
    return curr && (curr.type === "identifier" || curr.type === "field_identifier" || curr.type === "type_identifier") ? curr : null;
  }

  /**
   * Checks if a function_declarator represents a function pointer variable (e.g. `int (*fn)(int)`)
   * rather than a function prototype/definition.
   */
  function isFunctionPointerDeclarator(fnDeclaratorNode) {
    const inner = (fnDeclaratorNode.childForFieldName && fnDeclaratorNode.childForFieldName("declarator")) || fnDeclaratorNode.namedChildren[0];
    return inner && inner.type === "parenthesized_declarator";
  }

  /**
   * Parses parameter declarations from a parameter_list node.
   */
  function parseParameters(paramListNode) {
    const params = [];
    if (!paramListNode) return params;

    for (const child of paramListNode.namedChildren) {
      if (child.type === "parameter_declaration") {
        const declaratorNode = child.childForFieldName ? child.childForFieldName("declarator") : null;
        const nameNode = declaratorNode ? getDeclaratorNameNode(declaratorNode) : null;
        const name = nameNode ? nameNode.text : "";
        // Extract type text by removing name from parameter text
        let typeText = child.text.trim();
        if (name) {
          typeText = typeText.replace(new RegExp(`\\b${name}\\b`), "").replace(/\\s+/g, " ").trim();
        }
        params.push({
          name: name || null,
          type: typeText || "void",
          location: mapNodeLocation(child),
        });
      }
    }
    return params;
  }

  /**
   * Extracts modifiers (static, extern, inline, const, volatile) from declaration nodes.
   */
  function extractModifiers(node) {
    const modifiers = [];
    for (const child of node.children) {
      if (child.type === "storage_class_specifier" || child.type === "type_qualifier") {
        modifiers.push(child.text);
      }
    }
    return modifiers;
  }

  /**
   * Extracts return type from declaration or function_definition node.
   */
  function extractReturnType(node, fnDeclaratorNode) {
    const parts = [];
    for (const child of node.children) {
      if (child === fnDeclaratorNode) break;
      if (
        child.type === "primitive_type" ||
        child.type === "type_identifier" ||
        child.type === "sized_type_specifier" ||
        child.type === "struct_specifier" ||
        child.type === "union_specifier" ||
        child.type === "enum_specifier" ||
        child.type === "type_qualifier"
      ) {
        parts.push(child.text);
      }
    }
    return parts.length > 0 ? parts.join(" ") : "void";
  }

  /**
   * Extracts fields of a struct or union.
   */
  function extractFields(fieldListNode, parentSymbolId) {
    if (!fieldListNode) return;

    for (const fieldDecl of fieldListNode.namedChildren) {
      if (fieldDecl.type === "field_declaration") {
        for (const child of fieldDecl.namedChildren) {
          if (
            child.type === "field_identifier" ||
            child.type === "pointer_declarator" ||
            child.type === "array_declarator"
          ) {
            const nameNode = getDeclaratorNameNode(child);
            if (nameNode) {
              const fieldName = nameNode.text;
              const location = mapNodeLocation(child);
              const nameLocation = mapNodeLocation(nameNode);

              symbols.push(
                createSymbol({
                  fileId,
                  index: symbolCounter++,
                  name: fieldName,
                  qualifiedName: fieldName,
                  kind: "field",
                  languageKind: "field",
                  parentSymbolId,
                  location,
                  nameLocation,
                  signature: fieldDecl.text.trim(),
                  parameters: [],
                  returnType: null,
                  typeParameters: [],
                  modifiers: [],
                  visibility: "public",
                  isExported: false,
                  languageMetadata: {},
                })
              );
            }
          }
        }
      }
    }
  }

  /**
   * Extracts members of an enum.
   */
  function extractEnumMembers(enumListNode, parentSymbolId) {
    if (!enumListNode) return;

    for (const enumerator of enumListNode.namedChildren) {
      if (enumerator.type === "enumerator") {
        const nameNode = enumerator.namedChildren.find((c) => c.type === "identifier");
        if (nameNode) {
          const memberName = nameNode.text;
          const location = mapNodeLocation(enumerator);
          const nameLocation = mapNodeLocation(nameNode);

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: memberName,
              qualifiedName: memberName,
              kind: "enum_member",
              languageKind: "enum_member",
              parentSymbolId,
              location,
              nameLocation,
              signature: enumerator.text.trim(),
              parameters: [],
              returnType: null,
              typeParameters: [],
              modifiers: [],
              visibility: "public",
              isExported: true,
              languageMetadata: {},
            })
          );
        }
      }
    }
  }

  /**
   * Traverses nodes looking for declarations.
   */
  function traverse(node, parentSymbolId = null) {
    if (!node) return;

    // 1. Function definition (int add(...) { ... })
    if (node.type === "function_definition") {
      const fnDeclarator = node.namedChildren.find((c) => c.type === "function_declarator");
      if (fnDeclarator && !isFunctionPointerDeclarator(fnDeclarator)) {
        const nameNode = getDeclaratorNameNode(fnDeclarator);
        if (nameNode) {
          const fnName = nameNode.text;
          const modifiers = extractModifiers(node);
          const isStatic = modifiers.includes("static");
          const returnType = extractReturnType(node, fnDeclarator);
          const paramListNode = fnDeclarator.namedChildren.find((c) => c.type === "parameter_list");
          const parameters = parseParameters(paramListNode);
          const location = mapNodeLocation(node);
          const nameLocation = mapNodeLocation(nameNode);

          const paramSig = parameters.map((p) => (p.name ? `${p.type} ${p.name}` : p.type)).join(", ");
          const signature = `${returnType} ${fnName}(${paramSig})`;

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: fnName,
              qualifiedName: fnName,
              kind: "function",
              languageKind: "function_definition",
              parentSymbolId,
              location,
              nameLocation,
              signature,
              parameters,
              returnType,
              typeParameters: [],
              modifiers,
              visibility: isStatic ? "internal" : "public",
              isExported: !isStatic,
              languageMetadata: {
                isDefinition: true,
              },
            })
          );
        }
      }
      return;
    }

    // 2. Struct specifier (struct Point { ... };)
    if (node.type === "struct_specifier") {
      const fieldList = node.namedChildren.find((c) => c.type === "field_declaration_list");
      if (fieldList) {
        const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
        const structName = nameNode ? nameNode.text : "(anonymous_struct)";
        const location = mapNodeLocation(node);
        const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;

        const structSymbol = createSymbol({
          fileId,
          index: symbolCounter++,
          name: structName,
          qualifiedName: structName,
          kind: "struct",
          languageKind: "struct",
          parentSymbolId,
          location,
          nameLocation,
          signature: `struct ${structName}`,
          parameters: [],
          returnType: null,
          typeParameters: [],
          modifiers: [],
          visibility: "public",
          isExported: true,
          languageMetadata: {},
        });
        symbols.push(structSymbol);

        extractFields(fieldList, structSymbol.id);
        return;
      }
    }

    // 3. Union specifier (union Data { ... };)
    if (node.type === "union_specifier") {
      const fieldList = node.namedChildren.find((c) => c.type === "field_declaration_list");
      if (fieldList) {
        const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
        const unionName = nameNode ? nameNode.text : "(anonymous_union)";
        const location = mapNodeLocation(node);
        const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;

        const unionSymbol = createSymbol({
          fileId,
          index: symbolCounter++,
          name: unionName,
          qualifiedName: unionName,
          kind: "struct",
          languageKind: "union",
          parentSymbolId,
          location,
          nameLocation,
          signature: `union ${unionName}`,
          parameters: [],
          returnType: null,
          typeParameters: [],
          modifiers: [],
          visibility: "public",
          isExported: true,
          languageMetadata: {},
        });
        symbols.push(unionSymbol);

        extractFields(fieldList, unionSymbol.id);
        return;
      }
    }

    // 4. Enum specifier (enum Color { ... };)
    if (node.type === "enum_specifier") {
      const enumList = node.namedChildren.find((c) => c.type === "enumerator_list");
      if (enumList) {
        const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
        const enumName = nameNode ? nameNode.text : "(anonymous_enum)";
        const location = mapNodeLocation(node);
        const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;

        const enumSymbol = createSymbol({
          fileId,
          index: symbolCounter++,
          name: enumName,
          qualifiedName: enumName,
          kind: "enum",
          languageKind: "enum",
          parentSymbolId,
          location,
          nameLocation,
          signature: `enum ${enumName}`,
          parameters: [],
          returnType: null,
          typeParameters: [],
          modifiers: [],
          visibility: "public",
          isExported: true,
          languageMetadata: {},
        });
        symbols.push(enumSymbol);

        extractEnumMembers(enumList, enumSymbol.id);
        return;
      }
    }

    // 5. Type definition (typedef ...)
    if (node.type === "type_definition") {
      const typeIdNode = node.namedChildren.find((c) => c.type === "type_identifier");
      if (typeIdNode) {
        const aliasName = typeIdNode.text;
        const location = mapNodeLocation(node);
        const nameLocation = mapNodeLocation(typeIdNode);

        const typeDefSymbol = createSymbol({
          fileId,
          index: symbolCounter++,
          name: aliasName,
          qualifiedName: aliasName,
          kind: "type_alias",
          languageKind: "typedef",
          parentSymbolId,
          location,
          nameLocation,
          signature: node.text.trim(),
          parameters: [],
          returnType: null,
          typeParameters: [],
          modifiers: [],
          visibility: "public",
          isExported: true,
          languageMetadata: {},
        });
        symbols.push(typeDefSymbol);

        // If typedef defines an inner anonymous struct/union/enum, extract its fields under the typedef symbol
        const innerStruct = node.namedChildren.find((c) => c.type === "struct_specifier" || c.type === "union_specifier");
        if (innerStruct) {
          const fieldList = innerStruct.namedChildren.find((c) => c.type === "field_declaration_list");
          if (fieldList) {
            extractFields(fieldList, typeDefSymbol.id);
          }
        }
        const innerEnum = node.namedChildren.find((c) => c.type === "enum_specifier");
        if (innerEnum) {
          const enumList = innerEnum.namedChildren.find((c) => c.type === "enumerator_list");
          if (enumList) {
            extractEnumMembers(enumList, typeDefSymbol.id);
          }
        }
        return;
      }
    }

    // 6. Generic declaration (function prototypes, global variables)
    if (node.type === "declaration") {
      const modifiers = extractModifiers(node);
      const isStatic = modifiers.includes("static");
      const isExtern = modifiers.includes("extern");
      const isConst = modifiers.includes("const");

      for (const child of node.namedChildren) {
        // Skip type specifiers
        if (
          [
            "primitive_type",
            "type_identifier",
            "sized_type_specifier",
            "struct_specifier",
            "union_specifier",
            "enum_specifier",
            "type_qualifier",
            "storage_class_specifier",
          ].includes(child.type)
        ) {
          continue;
        }

        // Check if function declarator (prototype)
        let isFuncProto = false;
        let fnDeclarator = null;
        if (child.type === "function_declarator") {
          fnDeclarator = child;
          isFuncProto = !isFunctionPointerDeclarator(fnDeclarator);
        } else if (child.type === "pointer_declarator") {
          const innerFn = child.namedChildren.find((c) => c.type === "function_declarator");
          if (innerFn && !isFunctionPointerDeclarator(innerFn)) {
            fnDeclarator = innerFn;
            isFuncProto = true;
          }
        }

        if (isFuncProto && fnDeclarator) {
          const nameNode = getDeclaratorNameNode(fnDeclarator);
          if (nameNode) {
            const fnName = nameNode.text;
            const returnType = extractReturnType(node, fnDeclarator);
            const paramListNode = fnDeclarator.namedChildren.find((c) => c.type === "parameter_list");
            const parameters = parseParameters(paramListNode);
            const location = mapNodeLocation(node);
            const nameLocation = mapNodeLocation(nameNode);

            const paramSig = parameters.map((p) => (p.name ? `${p.type} ${p.name}` : p.type)).join(", ");
            const signature = `${returnType} ${fnName}(${paramSig});`;

            symbols.push(
              createSymbol({
                fileId,
                index: symbolCounter++,
                name: fnName,
                qualifiedName: fnName,
                kind: "function",
                languageKind: "function_declaration",
                parentSymbolId,
                location,
                nameLocation,
                signature,
                parameters,
                returnType,
                typeParameters: [],
                modifiers,
                visibility: isStatic ? "internal" : "public",
                isExported: !isStatic,
                languageMetadata: {
                  isDefinition: false,
                },
              })
            );
            continue;
          }
        }

        // Otherwise top-level variable or constant
        const nameNode = getDeclaratorNameNode(child);
        if (nameNode) {
          const varName = nameNode.text;
          const location = mapNodeLocation(child);
          const nameLocation = mapNodeLocation(nameNode);

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: varName,
              qualifiedName: varName,
              kind: isConst ? "constant" : "variable",
              languageKind: isExtern ? "extern_variable" : "variable",
              parentSymbolId,
              location,
              nameLocation,
              signature: child.text.trim(),
              parameters: [],
              returnType: null,
              typeParameters: [],
              modifiers,
              visibility: isStatic ? "internal" : "public",
              isExported: !isStatic,
              languageMetadata: {},
            })
          );
        }
      }
      return;
    }

    // Recurse into children (top-level or conditional blocks)
    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i), parentSymbolId);
    }
  }

  traverse(rootNode, null);

  return symbols;
}

module.exports = {
  extractCDeclarations,
};
