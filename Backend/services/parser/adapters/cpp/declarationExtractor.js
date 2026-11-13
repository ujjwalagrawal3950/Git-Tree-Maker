const { createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Extracts C++ symbols (namespaces, classes, structs, constructors, destructors,
 * member functions, free functions, fields, enums, scoped enums, typedefs, aliases,
 * templates, and operator overloads) from a Tree-sitter C++ AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} content
 * @param {string} fileId
 * @returns {Array<object>} Array of schema-compliant Symbol objects
 */
function extractCppDeclarations(rootNode, content, fileId) {
  const symbols = [];
  let symbolCounter = 0;

  if (!rootNode) return symbols;

  /**
   * Helper to unwrap declarators to find the innermost name node.
   */
  function getDeclaratorNameNode(node) {
    let curr = node;
    while (curr) {
      if (curr.type === "identifier") return curr;
      if (curr.type === "field_identifier") return curr;
      if (curr.type === "type_identifier") return curr;
      if (curr.type === "destructor_name") return curr;
      if (curr.type === "operator_name") return curr;
      if (curr.type === "qualified_identifier") {
        const idChild = curr.namedChildren.find(
          (c) =>
            c.type === "identifier" ||
            c.type === "destructor_name" ||
            c.type === "operator_name" ||
            c.type === "field_identifier"
        );
        return idChild || curr;
      }
      if (curr.type === "init_declarator") {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else if (
        curr.type === "pointer_declarator" ||
        curr.type === "reference_declarator" ||
        curr.type === "array_declarator"
      ) {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else if (curr.type === "parenthesized_declarator") {
        curr = curr.namedChildren[0];
      } else if (curr.type === "function_declarator") {
        curr = (curr.childForFieldName && curr.childForFieldName("declarator")) || curr.namedChildren[0];
      } else {
        break;
      }
    }
    return curr;
  }

  /**
   * Checks if a function_declarator represents a function pointer variable.
   */
  function isFunctionPointerDeclarator(fnDeclaratorNode) {
    const inner =
      (fnDeclaratorNode.childForFieldName && fnDeclaratorNode.childForFieldName("declarator")) ||
      fnDeclaratorNode.namedChildren[0];
    return inner && inner.type === "parenthesized_declarator";
  }

  /**
   * Extracts modifiers (static, virtual, inline, const, explicit, constexpr, friend).
   */
  function extractModifiers(node) {
    const modifiers = [];
    for (const child of node.children) {
      if (
        child.type === "storage_class_specifier" ||
        child.type === "type_qualifier" ||
        child.type === "virtual" ||
        child.type === "explicit" ||
        child.type === "constexpr" ||
        child.type === "inline" ||
        child.type === "friend"
      ) {
        modifiers.push(child.text);
      }
    }
    return modifiers;
  }

  /**
   * Parses parameter declarations from a parameter_list node.
   */
  function parseParameters(paramListNode) {
    const params = [];
    if (!paramListNode) return params;

    for (const child of paramListNode.namedChildren) {
      if (child.type === "parameter_declaration" || child.type === "optional_parameter_declaration") {
        const declaratorNode =
          (child.childForFieldName && child.childForFieldName("declarator")) || null;
        const nameNode = declaratorNode ? getDeclaratorNameNode(declaratorNode) : null;
        const name = nameNode ? nameNode.text : "";
        let typeText = child.text.trim();
        if (name) {
          typeText = typeText.replace(new RegExp(`\\b${name}\\b`), "").replace(/\s+/g, " ").trim();
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
   * Extracts return type from declaration or function_definition node.
   */
  function extractReturnType(node, fnDeclaratorNode) {
    const parts = [];
    for (const child of node.children) {
      if (child === fnDeclaratorNode) break;
      if (
        [
          "primitive_type",
          "type_identifier",
          "sized_type_specifier",
          "struct_specifier",
          "union_specifier",
          "enum_specifier",
          "type_qualifier",
          "qualified_identifier",
          "template_type",
          "auto",
          "placeholder_type_specifier",
        ].includes(child.type)
      ) {
        parts.push(child.text);
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  /**
   * Builds qualified name from namespace/class prefix stack.
   */
  function buildQualifiedName(name, prefixStack) {
    if (prefixStack.length === 0) return name;
    return `${prefixStack.join("::")}::${name}`;
  }

  /**
   * Recursive declaration visitor.
   */
  function visit(node, parentSymbolId = null, prefixStack = [], activeVisibility = "public", templateInfo = null) {
    if (!node) return;

    const nodeType = node.type;

    // 1. Template declaration wrapper: template <typename T> ...
    if (nodeType === "template_declaration") {
      const paramListNode = node.namedChildren.find((c) => c.type === "template_parameter_list");
      const templateParams = paramListNode
        ? paramListNode.namedChildren.map((p) => p.text.trim())
        : [];
      const info = {
        isTemplate: true,
        templateParameters: templateParams,
      };

      for (const child of node.namedChildren) {
        if (child.type !== "template_parameter_list") {
          visit(child, parentSymbolId, prefixStack, activeVisibility, info);
        }
      }
      return;
    }

    // 2. Namespace definition: namespace ns { ... } or namespace a::b { ... }
    if (nodeType === "namespace_definition") {
      const nameNode =
        node.namedChildren.find((c) => c.type === "namespace_identifier" || c.type === "nested_namespace_specifier");
      const nsName = nameNode ? nameNode.text : "(anonymous_namespace)";
      const location = mapNodeLocation(node);
      const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;
      const qualifiedName = buildQualifiedName(nsName, prefixStack);

      const nsSymbol = createSymbol({
        fileId,
        index: symbolCounter++,
        name: nsName,
        qualifiedName,
        kind: "namespace",
        languageKind: "namespace",
        parentSymbolId,
        location,
        nameLocation,
        signature: `namespace ${nsName}`,
        parameters: [],
        returnType: null,
        typeParameters: [],
        modifiers: [],
        visibility: "public",
        isExported: true,
        languageMetadata: {},
      });
      symbols.push(nsSymbol);

      const nextPrefix = [...prefixStack, nsName];
      const declList = node.namedChildren.find((c) => c.type === "declaration_list");
      if (declList) {
        for (let i = 0; i < declList.namedChildCount; i++) {
          visit(declList.namedChild(i), nsSymbol.id, nextPrefix, "public", null);
        }
      }
      return;
    }

    // 3. Class or Struct specifier: class Foo { ... } or struct Bar { ... }
    if (nodeType === "class_specifier" || nodeType === "struct_specifier") {
      const isClass = nodeType === "class_specifier";
      const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
      const typeName = nameNode ? nameNode.text : `(anonymous_${isClass ? "class" : "struct"})`;
      const location = mapNodeLocation(node);
      const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;
      const qualifiedName = buildQualifiedName(typeName, prefixStack);

      const fieldList = node.namedChildren.find((c) => c.type === "field_declaration_list");

      const classSymbol = createSymbol({
        fileId,
        index: symbolCounter++,
        name: typeName,
        qualifiedName,
        kind: isClass ? "class" : "struct",
        languageKind: isClass ? "class" : "struct",
        parentSymbolId,
        location,
        nameLocation,
        signature: `${isClass ? "class" : "struct"} ${typeName}`,
        parameters: [],
        returnType: null,
        typeParameters: templateInfo ? templateInfo.templateParameters : [],
        modifiers: [],
        visibility: activeVisibility,
        isExported: true,
        languageMetadata: {
          isTemplate: Boolean(templateInfo && templateInfo.isTemplate),
        },
      });
      symbols.push(classSymbol);

      if (fieldList) {
        let currentClassVis = isClass ? "private" : "public";
        const nextPrefix = [...prefixStack, typeName];

        for (const child of fieldList.children) {
          if (child.type === "access_specifier") {
            currentClassVis = child.text.trim();
            continue;
          }
          if (child.namedChildren) {
            visit(child, classSymbol.id, nextPrefix, currentClassVis, null);
          }
        }
      }
      return;
    }

    // 4. Function definition (method or free function)
    if (nodeType === "function_definition") {
      const fnDeclarator = node.namedChildren.find((c) => c.type === "function_declarator");
      if (fnDeclarator && !isFunctionPointerDeclarator(fnDeclarator)) {
        const nameNode = getDeclaratorNameNode(fnDeclarator);
        if (nameNode) {
          const rawName = nameNode.text;
          const modifiers = extractModifiers(node);
          const isStatic = modifiers.includes("static");
          const returnType = extractReturnType(node, fnDeclarator);
          const paramListNode = fnDeclarator.namedChildren.find((c) => c.type === "parameter_list");
          const parameters = parseParameters(paramListNode);
          const location = mapNodeLocation(node);
          const nameLocation = mapNodeLocation(nameNode);

          // Classify kind
          let kind = parentSymbolId ? "method" : "function";
          let languageKind = parentSymbolId ? "method_definition" : "function_definition";

          const enclosingName = prefixStack.length > 0 ? prefixStack[prefixStack.length - 1] : "";
          if (rawName.startsWith("~")) {
            kind = "method";
            languageKind = "destructor";
          } else if (rawName === enclosingName) {
            kind = "constructor";
            languageKind = "constructor";
          } else if (rawName.startsWith("operator")) {
            kind = "method";
            languageKind = "operator_overload";
          }

          const qualifiedName = buildQualifiedName(rawName, prefixStack);
          const paramSig = parameters.map((p) => (p.name ? `${p.type} ${p.name}` : p.type)).join(", ");
          const signature = `${returnType ? returnType + " " : ""}${rawName}(${paramSig})`;

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: rawName,
              qualifiedName,
              kind,
              languageKind,
              parentSymbolId,
              location,
              nameLocation,
              signature,
              parameters,
              returnType,
              typeParameters: templateInfo ? templateInfo.templateParameters : [],
              modifiers,
              visibility: activeVisibility,
              isExported: activeVisibility === "public" && !isStatic,
              languageMetadata: {
                isDefinition: true,
                isTemplate: Boolean(templateInfo && templateInfo.isTemplate),
              },
            })
          );
        }
      }
      return;
    }

    // 5. Member declarations / Prototypes in class or file
    if (nodeType === "field_declaration" || nodeType === "declaration") {
      const modifiers = extractModifiers(node);
      const isStatic = modifiers.includes("static");

      // Check if function declarator (method prototype or free function prototype)
      let fnDeclarator = node.namedChildren.find((c) => c.type === "function_declarator");
      if (!fnDeclarator) {
        const ptr = node.namedChildren.find((c) => c.type === "pointer_declarator" || c.type === "reference_declarator");
        if (ptr) fnDeclarator = ptr.namedChildren.find((c) => c.type === "function_declarator");
      }

      if (fnDeclarator && !isFunctionPointerDeclarator(fnDeclarator)) {
        const nameNode = getDeclaratorNameNode(fnDeclarator);
        if (nameNode) {
          const rawName = nameNode.text;
          const returnType = extractReturnType(node, fnDeclarator);
          const paramListNode = fnDeclarator.namedChildren.find((c) => c.type === "parameter_list");
          const parameters = parseParameters(paramListNode);
          const location = mapNodeLocation(node);
          const nameLocation = mapNodeLocation(nameNode);

          let kind = parentSymbolId ? "method" : "function";
          let languageKind = parentSymbolId ? "method_declaration" : "function_declaration";

          const enclosingName = prefixStack.length > 0 ? prefixStack[prefixStack.length - 1] : "";
          if (rawName.startsWith("~")) {
            kind = "method";
            languageKind = "destructor";
          } else if (rawName === enclosingName) {
            kind = "constructor";
            languageKind = "constructor";
          } else if (rawName.startsWith("operator")) {
            kind = "method";
            languageKind = "operator_overload";
          }

          const qualifiedName = buildQualifiedName(rawName, prefixStack);
          const paramSig = parameters.map((p) => (p.name ? `${p.type} ${p.name}` : p.type)).join(", ");
          const signature = `${returnType ? returnType + " " : ""}${rawName}(${paramSig});`;

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: rawName,
              qualifiedName,
              kind,
              languageKind,
              parentSymbolId,
              location,
              nameLocation,
              signature,
              parameters,
              returnType,
              typeParameters: templateInfo ? templateInfo.templateParameters : [],
              modifiers,
              visibility: activeVisibility,
              isExported: activeVisibility === "public" && !isStatic,
              languageMetadata: {
                isDefinition: false,
                isTemplate: Boolean(templateInfo && templateInfo.isTemplate),
              },
            })
          );
          return;
        }
      }

      // Otherwise, field declaration or variable declaration
      for (const child of node.namedChildren) {
        if (
          [
            "primitive_type",
            "type_identifier",
            "sized_type_specifier",
            "type_qualifier",
            "storage_class_specifier",
            "qualified_identifier",
            "template_type",
            "access_specifier",
          ].includes(child.type)
        ) {
          continue;
        }

        const nameNode = getDeclaratorNameNode(child);
        if (nameNode) {
          const varName = nameNode.text;
          const location = mapNodeLocation(child);
          const nameLocation = mapNodeLocation(nameNode);
          const qualifiedName = buildQualifiedName(varName, prefixStack);
          const isField = parentSymbolId !== null;

          symbols.push(
            createSymbol({
              fileId,
              index: symbolCounter++,
              name: varName,
              qualifiedName,
              kind: isField ? "field" : modifiers.includes("const") ? "constant" : "variable",
              languageKind: isField ? "field" : "variable",
              parentSymbolId,
              location,
              nameLocation,
              signature: child.text.trim(),
              parameters: [],
              returnType: null,
              typeParameters: [],
              modifiers,
              visibility: activeVisibility,
              isExported: activeVisibility === "public" && !isStatic,
              languageMetadata: {},
            })
          );
        }
      }
      return;
    }

    // 6. Type Alias: using StringList = std::vector<std::string>;
    if (nodeType === "alias_declaration") {
      const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
      if (nameNode) {
        const aliasName = nameNode.text;
        const location = mapNodeLocation(node);
        const nameLocation = mapNodeLocation(nameNode);
        const qualifiedName = buildQualifiedName(aliasName, prefixStack);

        symbols.push(
          createSymbol({
            fileId,
            index: symbolCounter++,
            name: aliasName,
            qualifiedName,
            kind: "type_alias",
            languageKind: "type_alias",
            parentSymbolId,
            location,
            nameLocation,
            signature: node.text.trim(),
            parameters: [],
            returnType: null,
            typeParameters: templateInfo ? templateInfo.templateParameters : [],
            modifiers: [],
            visibility: activeVisibility,
            isExported: activeVisibility === "public",
            languageMetadata: {
              isTemplate: Boolean(templateInfo && templateInfo.isTemplate),
            },
          })
        );
      }
      return;
    }

    // 7. Typedef: typedef int Int_t;
    if (nodeType === "type_definition") {
      const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
      if (nameNode) {
        const aliasName = nameNode.text;
        const location = mapNodeLocation(node);
        const nameLocation = mapNodeLocation(nameNode);
        const qualifiedName = buildQualifiedName(aliasName, prefixStack);

        symbols.push(
          createSymbol({
            fileId,
            index: symbolCounter++,
            name: aliasName,
            qualifiedName,
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
            visibility: activeVisibility,
            isExported: activeVisibility === "public",
            languageMetadata: {},
          })
        );
      }
      return;
    }

    // 8. Enum specifier: enum class Color : int { ... } or enum Status { ... }
    if (nodeType === "enum_specifier") {
      const enumList = node.namedChildren.find((c) => c.type === "enumerator_list");
      if (enumList) {
        const nameNode = node.namedChildren.find((c) => c.type === "type_identifier");
        const enumName = nameNode ? nameNode.text : "(anonymous_enum)";
        const location = mapNodeLocation(node);
        const nameLocation = nameNode ? mapNodeLocation(nameNode) : location;
        const qualifiedName = buildQualifiedName(enumName, prefixStack);
        const isScoped = node.text.startsWith("enum class") || node.text.startsWith("enum struct");

        const enumSymbol = createSymbol({
          fileId,
          index: symbolCounter++,
          name: enumName,
          qualifiedName,
          kind: "enum",
          languageKind: isScoped ? "scoped_enum" : "enum",
          parentSymbolId,
          location,
          nameLocation,
          signature: `enum ${isScoped ? "class " : ""}${enumName}`,
          parameters: [],
          returnType: null,
          typeParameters: [],
          modifiers: [],
          visibility: activeVisibility,
          isExported: activeVisibility === "public",
          languageMetadata: {
            isScoped,
          },
        });
        symbols.push(enumSymbol);

        // Enum members
        for (const enumerator of enumList.namedChildren) {
          if (enumerator.type === "enumerator") {
            const memNameNode = enumerator.namedChildren.find((c) => c.type === "identifier");
            if (memNameNode) {
              const memName = memNameNode.text;
              const memLoc = mapNodeLocation(enumerator);
              const memNameLoc = mapNodeLocation(memNameNode);
              const memQualName = `${qualifiedName}::${memName}`;

              symbols.push(
                createSymbol({
                  fileId,
                  index: symbolCounter++,
                  name: memName,
                  qualifiedName: memQualName,
                  kind: "enum_member",
                  languageKind: "enum_member",
                  parentSymbolId: enumSymbol.id,
                  location: memLoc,
                  nameLocation: memNameLoc,
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
        return;
      }
    }

    // Default: recurse
    for (let i = 0; i < node.namedChildCount; i++) {
      visit(node.namedChild(i), parentSymbolId, prefixStack, activeVisibility, templateInfo);
    }
  }

  visit(rootNode, null, [], "public", null);

  return symbols;
}

module.exports = {
  extractCppDeclarations,
};

