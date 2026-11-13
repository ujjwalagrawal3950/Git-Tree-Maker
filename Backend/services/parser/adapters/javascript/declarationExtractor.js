const ts = require("typescript");
const { createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Primitive TypeScript/JavaScript type keywords.
 */
const PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "undefined",
  "null",
  "symbol",
  "bigint",
  "any",
  "unknown",
  "never",
  "object",
]);

/**
 * Builds a schema-compliant TypeDescriptor object from a TypeScript TypeNode.
 *
 * @param {import("typescript").TypeNode|null} typeNode
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {object|null}
 */
function buildTypeDescriptor(typeNode, sourceFile) {
  if (!typeNode) {
    return {
      text: null,
      kind: "unknown",
      isInferred: true,
    };
  }

  const text = typeNode.getText(sourceFile).trim();

  let kind = "named";
  if (PRIMITIVE_TYPES.has(text.toLowerCase())) {
    kind = "primitive";
  } else if (ts.isUnionTypeNode(typeNode)) {
    kind = "union";
  } else if (ts.isIntersectionTypeNode(typeNode)) {
    kind = "intersection";
  } else if (ts.isArrayTypeNode(typeNode)) {
    kind = "array";
  } else if (ts.isTupleTypeNode(typeNode)) {
    kind = "tuple";
  } else if (ts.isFunctionTypeNode(typeNode)) {
    kind = "function";
  } else if (ts.isTypeReferenceNode(typeNode)) {
    kind = typeNode.typeArguments && typeNode.typeArguments.length > 0 ? "generic" : "named";
  }

  return {
    text,
    kind,
    isInferred: false,
  };
}

/**
 * Extracts modifier strings from an AST node.
 *
 * @param {import("typescript").Node} node
 * @returns {string[]}
 */
function extractModifiers(node) {
  const result = [];
  if (!ts.canHaveModifiers(node)) return result;

  const modifiers = ts.getModifiers(node);
  if (!modifiers) return result;

  for (const m of modifiers) {
    switch (m.kind) {
      case ts.SyntaxKind.ExportKeyword:
        result.push("export");
        break;
      case ts.SyntaxKind.DefaultKeyword:
        result.push("default");
        break;
      case ts.SyntaxKind.AsyncKeyword:
        result.push("async");
        break;
      case ts.SyntaxKind.StaticKeyword:
        result.push("static");
        break;
      case ts.SyntaxKind.ReadonlyKeyword:
        result.push("readonly");
        break;
      case ts.SyntaxKind.AbstractKeyword:
        result.push("abstract");
        break;
      case ts.SyntaxKind.DeclareKeyword:
        result.push("declare");
        break;
      case ts.SyntaxKind.PrivateKeyword:
        result.push("private");
        break;
      case ts.SyntaxKind.ProtectedKeyword:
        result.push("protected");
        break;
      case ts.SyntaxKind.PublicKeyword:
        result.push("public");
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * Resolves visibility from modifiers or node syntax.
 *
 * @param {string[]} modifiers
 * @param {import("typescript").Node} node
 * @returns {"public"|"protected"|"private"|"internal"|"package"|"unknown"|null}
 */
function resolveVisibility(modifiers, node) {
  if (modifiers.includes("private")) return "private";
  if (modifiers.includes("protected")) return "protected";
  if (modifiers.includes("public")) return "public";
  if (node.name && ts.isPrivateIdentifier && ts.isPrivateIdentifier(node.name)) {
    return "private";
  }
  return "public";
}

/**
 * Extracts parameter descriptors for functions, methods, and constructors.
 *
 * @param {ts.NodeArray<import("typescript").ParameterDeclaration>} parameters
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Array<object>}
 */
function extractParameters(parameters, sourceFile) {
  if (!parameters || parameters.length === 0) return [];

  return parameters.map((param, index) => {
    const name = param.name ? param.name.getText(sourceFile) : `arg_${index}`;
    const typeDesc = buildTypeDescriptor(param.type, sourceFile);
    const optional = Boolean(param.questionToken || param.initializer);
    const variadic = Boolean(param.dotDotDotToken);
    const defaultValueText = param.initializer ? param.initializer.getText(sourceFile) : null;
    const location = mapNodeLocation(sourceFile, param);

    return {
      name,
      position: index,
      type: typeDesc,
      optional,
      variadic,
      defaultValueText,
      location,
    };
  });
}

/**
 * Extracts JSDoc documentation if present on the node.
 *
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {string|null}
 */
function extractDocumentation(node, sourceFile) {
  if (node.jsDoc && node.jsDoc.length > 0) {
    const docComments = node.jsDoc
      .map((d) => (typeof d.comment === "string" ? d.comment : ""))
      .filter(Boolean);
    if (docComments.length > 0) return docComments.join("\n");
  }
  return null;
}

/**
 * Extracts all symbol declarations from a TypeScript/JavaScript SourceFile AST.
 *
 * Supported forms:
 * - Function declarations and named function expressions
 * - Named arrow functions assigned to variables
 * - Classes, constructors, methods, and properties/fields
 * - Variables (`const`, `let`, `var`)
 * - Interfaces, type aliases, enums, enum members, and namespaces
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @returns {Array<object>} Normalized symbol objects conforming to IR_SCHEMA.json
 */
function extractDeclarations(sourceFile, fileId) {
  const symbols = [];
  let symbolCounter = 0;

  function traverse(node, parentSymbol = null) {
    if (!node) return;

    const parentSymbolId = parentSymbol ? parentSymbol.id : null;
    const modifiers = extractModifiers(node);
    const isExported = modifiers.includes("export");
    const visibility = resolveVisibility(modifiers, node);
    const documentation = extractDocumentation(node, sourceFile);

    // 1. Function Declaration
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name ? node.name.text : (modifiers.includes("default") ? "default" : "anonymous");
      const nameLocation = node.name ? mapNodeLocation(sourceFile, node.name) : null;
      const location = mapNodeLocation(sourceFile, node);
      const parameters = extractParameters(node.parameters, sourceFile);
      const returnType = node.type ? buildTypeDescriptor(node.type, sourceFile) : null;
      const typeParameters = node.typeParameters ? node.typeParameters.map((tp) => tp.name.text) : [];
      const signature = node.getText(sourceFile).split("{")[0].trim();

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "function",
        languageKind: "FunctionDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature,
        parameters,
        returnType,
        typeParameters,
        modifiers,
        visibility,
        isExported,
        documentation,
        languageMetadata: { isGenerator: Boolean(node.asteriskToken) },
      });

      symbols.push(sym);
      if (node.body) {
        ts.forEachChild(node.body, (child) => traverse(child, sym));
      }
      return;
    }

    // 2. Class Declaration
    if (ts.isClassDeclaration(node)) {
      const name = node.name ? node.name.text : (modifiers.includes("default") ? "default" : "anonymous");
      const nameLocation = node.name ? mapNodeLocation(sourceFile, node.name) : null;
      const location = mapNodeLocation(sourceFile, node);
      const typeParameters = node.typeParameters ? node.typeParameters.map((tp) => tp.name.text) : [];
      const signature = `class ${name}`;

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "class",
        languageKind: "ClassDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature,
        parameters: [],
        returnType: null,
        typeParameters,
        modifiers,
        visibility,
        isExported,
        documentation,
        languageMetadata: {},
      });

      symbols.push(sym);
      // Traverse class members with class as parent
      if (node.members) {
        for (const member of node.members) {
          traverse(member, sym);
        }
      }
      return;
    }

    // 3. Class Method Declaration
    if (ts.isMethodDeclaration(node)) {
      const name = node.name ? node.name.getText(sourceFile) : "anonymous";
      const nameLocation = node.name ? mapNodeLocation(sourceFile, node.name) : null;
      const location = mapNodeLocation(sourceFile, node);
      const parameters = extractParameters(node.parameters, sourceFile);
      const returnType = node.type ? buildTypeDescriptor(node.type, sourceFile) : null;
      const typeParameters = node.typeParameters ? node.typeParameters.map((tp) => tp.name.text) : [];
      const signature = `${name}(...)`;

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "method",
        languageKind: "MethodDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature,
        parameters,
        returnType,
        typeParameters,
        modifiers,
        visibility,
        isExported: false,
        documentation,
        languageMetadata: { isStatic: modifiers.includes("static") },
      });

      symbols.push(sym);
      if (node.body) {
        ts.forEachChild(node.body, (child) => traverse(child, sym));
      }
      return;
    }

    // 4. Constructor Declaration
    if (ts.isConstructorDeclaration(node)) {
      const location = mapNodeLocation(sourceFile, node);
      const parameters = extractParameters(node.parameters, sourceFile);

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name: "constructor",
        qualifiedName: parentSymbol ? `${parentSymbol.name}.constructor` : "constructor",
        kind: "constructor",
        languageKind: "ConstructorDeclaration",
        parentSymbolId,
        location,
        nameLocation: null,
        signature: "constructor(...)",
        parameters,
        returnType: null,
        typeParameters: [],
        modifiers,
        visibility,
        isExported: false,
        documentation,
        languageMetadata: {},
      });

      symbols.push(sym);
      if (node.body) {
        ts.forEachChild(node.body, (child) => traverse(child, sym));
      }
      return;
    }

    // 5. Property / Field Declaration / Accessor
    if (ts.isPropertyDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      const name = node.name ? node.name.getText(sourceFile) : "anonymous";
      const nameLocation = node.name ? mapNodeLocation(sourceFile, node.name) : null;
      const location = mapNodeLocation(sourceFile, node);
      const returnType = node.type ? buildTypeDescriptor(node.type, sourceFile) : null;

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "field",
        languageKind: ts.isGetAccessor(node) ? "GetAccessor" : ts.isSetAccessor(node) ? "SetAccessor" : "PropertyDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature: `${name}: ${returnType ? returnType.text : "any"}`,
        parameters: [],
        returnType,
        typeParameters: [],
        modifiers,
        visibility,
        isExported: false,
        documentation,
        languageMetadata: { isStatic: modifiers.includes("static"), isReadonly: modifiers.includes("readonly") },
      });

      symbols.push(sym);
      return;
    }

    // 6. Interface Declaration
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const nameLocation = mapNodeLocation(sourceFile, node.name);
      const location = mapNodeLocation(sourceFile, node);
      const typeParameters = node.typeParameters ? node.typeParameters.map((tp) => tp.name.text) : [];

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "interface",
        languageKind: "InterfaceDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature: `interface ${name}`,
        parameters: [],
        returnType: null,
        typeParameters,
        modifiers,
        visibility: "public",
        isExported,
        documentation,
        languageMetadata: {},
      });

      symbols.push(sym);
      return;
    }

    // 7. Type Alias Declaration
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const nameLocation = mapNodeLocation(sourceFile, node.name);
      const location = mapNodeLocation(sourceFile, node);
      const typeParameters = node.typeParameters ? node.typeParameters.map((tp) => tp.name.text) : [];

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "type_alias",
        languageKind: "TypeAliasDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature: `type ${name}`,
        parameters: [],
        returnType: null,
        typeParameters,
        modifiers,
        visibility: "public",
        isExported,
        documentation,
        languageMetadata: {},
      });

      symbols.push(sym);
      return;
    }

    // 8. Enum Declaration
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const nameLocation = mapNodeLocation(sourceFile, node.name);
      const location = mapNodeLocation(sourceFile, node);

      const enumSym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "enum",
        languageKind: "EnumDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature: `enum ${name}`,
        parameters: [],
        returnType: null,
        typeParameters: [],
        modifiers,
        visibility: "public",
        isExported,
        documentation,
        languageMetadata: {},
      });

      symbols.push(enumSym);

      // Extract enum members
      if (node.members) {
        for (const member of node.members) {
          const mName = member.name.getText(sourceFile);
          const mLoc = mapNodeLocation(sourceFile, member);
          const mNameLoc = mapNodeLocation(sourceFile, member.name);

          const memberSym = createSymbol({
            fileId,
            index: symbolCounter++,
            name: mName,
            qualifiedName: `${name}.${mName}`,
            kind: "enum_member",
            languageKind: "EnumMember",
            parentSymbolId: enumSym.id,
            location: mLoc,
            nameLocation: mNameLoc,
            signature: mName,
            parameters: [],
            returnType: null,
            typeParameters: [],
            modifiers: [],
            visibility: "public",
            isExported: false,
            documentation: null,
            languageMetadata: {},
          });
          symbols.push(memberSym);
        }
      }
      return;
    }

    // 9. Module / Namespace Declaration
    if (ts.isModuleDeclaration(node)) {
      const name = node.name.text;
      const nameLocation = mapNodeLocation(sourceFile, node.name);
      const location = mapNodeLocation(sourceFile, node);
      const isNamespace = (node.flags & ts.NodeFlags.Namespace) !== 0;

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: isNamespace ? "namespace" : "module",
        languageKind: "ModuleDeclaration",
        parentSymbolId,
        location,
        nameLocation,
        signature: `namespace ${name}`,
        parameters: [],
        returnType: null,
        typeParameters: [],
        modifiers,
        visibility: "public",
        isExported,
        documentation,
        languageMetadata: {},
      });

      symbols.push(sym);
      if (node.body) {
        ts.forEachChild(node.body, (child) => traverse(child, sym));
      }
      return;
    }

    // 10. Variable Statements (const, let, var, and named arrow functions)
    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;

      for (const decl of node.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name)) continue;

        const name = decl.name.text;
        const nameLocation = mapNodeLocation(sourceFile, decl.name);
        const location = mapNodeLocation(sourceFile, decl);
        const returnType = decl.type ? buildTypeDescriptor(decl.type, sourceFile) : null;

        // Check if variable is initialized with an arrow function or function expression
        const isFunctionLike =
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));

        if (isFunctionLike) {
          const fnInit = decl.initializer;
          const parameters = extractParameters(fnInit.parameters, sourceFile);
          const fnReturnType = fnInit.type ? buildTypeDescriptor(fnInit.type, sourceFile) : returnType;
          const typeParameters = fnInit.typeParameters ? fnInit.typeParameters.map((tp) => tp.name.text) : [];

          const sym = createSymbol({
            fileId,
            index: symbolCounter++,
            name,
            qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
            kind: "function",
            languageKind: ts.isArrowFunction(fnInit) ? "ArrowFunction" : "FunctionExpression",
            parentSymbolId,
            location,
            nameLocation,
            signature: `const ${name} = (...) => ...`,
            parameters,
            returnType: fnReturnType,
            typeParameters,
            modifiers: isConst ? [...modifiers, "const"] : modifiers,
            visibility,
            isExported,
            documentation,
            languageMetadata: { isArrow: ts.isArrowFunction(fnInit) },
          });

          symbols.push(sym);
          if (fnInit.body) {
            ts.forEachChild(fnInit.body, (child) => traverse(child, sym));
          }
        } else {
          const sym = createSymbol({
            fileId,
            index: symbolCounter++,
            name,
            qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
            kind: isConst ? "constant" : "variable",
            languageKind: "VariableDeclaration",
            parentSymbolId,
            location,
            nameLocation,
            signature: `${isConst ? "const" : "let"} ${name}`,
            parameters: [],
            returnType,
            typeParameters: [],
            modifiers: isConst ? [...modifiers, "const"] : modifiers,
            visibility,
            isExported,
            documentation,
            languageMetadata: {},
          });

          symbols.push(sym);
        }
      }
      return;
    }

    // Default: recurse into children
    ts.forEachChild(node, (child) => traverse(child, parentSymbol));
  }

  ts.forEachChild(sourceFile, (child) => traverse(child, null));
  return symbols;
}

module.exports = {
  extractDeclarations,
  buildTypeDescriptor,
  extractModifiers,
  extractParameters,
};

