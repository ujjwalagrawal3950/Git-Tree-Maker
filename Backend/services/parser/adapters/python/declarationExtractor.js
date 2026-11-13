const { createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Primitive Python type names.
 */
const PYTHON_PRIMITIVE_TYPES = new Set([
  "int",
  "float",
  "str",
  "bool",
  "bytes",
  "none",
  "any",
  "object",
]);

/**
 * Builds a schema-compliant TypeDescriptor from a Python type annotation node.
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
  if (PYTHON_PRIMITIVE_TYPES.has(clean)) {
    kind = "primitive";
  } else if (text.includes("|") || text.startsWith("Union[")) {
    kind = "union";
  } else if (text.startsWith("List[") || text.startsWith("Sequence[")) {
    kind = "array";
  } else if (text.startsWith("Tuple[")) {
    kind = "tuple";
  } else if (text.startsWith("Callable[")) {
    kind = "function";
  } else if (text.includes("[")) {
    kind = "generic";
  }

  return {
    text,
    kind,
    isInferred: false,
  };
}

/**
 * Extracts decorator strings preceding a definition.
 *
 * @param {import("tree-sitter").SyntaxNode} decoratedNode
 * @returns {string[]}
 */
function extractDecorators(decoratedNode) {
  const decorators = [];
  if (!decoratedNode || decoratedNode.type !== "decorated_definition") return decorators;

  for (let i = 0; i < decoratedNode.namedChildCount; i++) {
    const child = decoratedNode.namedChild(i);
    if (child.type === "decorator") {
      decorators.push(child.text.trim().replace(/^@/, ""));
    }
  }
  return decorators;
}

/**
 * Extracts parameters and parameter kinds from a Python parameters node.
 *
 * Parameter kinds in Python (PEP 570):
 * - positional-only (before `/`)
 * - positional-or-keyword (normal)
 * - var-positional (`*args`)
 * - keyword-only (after `*` or `*args`)
 * - var-keyword (`**kwargs`)
 *
 * @param {import("tree-sitter").SyntaxNode|null} paramsNode
 * @returns {{
 *   parameters: Array<object>,
 *   parameterDetails: Array<object>
 * }}
 */
function extractPythonParameters(paramsNode) {
  const parameters = [];
  const parameterDetails = [];
  if (!paramsNode) return { parameters, parameterDetails };

  let isPositionalOnly = false;
  let isKeywordOnly = false;
  let paramPos = 0;

  // Pre-scan to check if a positional_separator ('/') exists
  let hasSlash = false;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const cType = paramsNode.child(i).type;
    if (cType === "positional_separator" || cType === "/") {
      hasSlash = true;
      break;
    }
  }
  isPositionalOnly = hasSlash;

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const child = paramsNode.namedChild(i);
    const childType = child.type;

    if (childType === "positional_separator") {
      isPositionalOnly = false;
      continue;
    }
    if (childType === "keyword_separator") {
      isKeywordOnly = true;
      continue;
    }

    let name = "arg";
    let typeNode = null;
    let defaultValueText = null;
    let variadic = false;
    let kind = isKeywordOnly
      ? "keyword_only"
      : isPositionalOnly
      ? "positional_only"
      : "positional_or_keyword";

    if (childType === "identifier") {
      name = child.text;
    } else if (childType === "typed_parameter") {
      // (typed_parameter (identifier) (type))
      const idNode = child.namedChild(0);
      name = idNode ? idNode.text : "arg";
      typeNode = child.namedChild(1);
    } else if (childType === "default_parameter") {
      // (default_parameter name: (identifier) value: (...))
      const idNode = child.childForFieldName("name") || child.namedChild(0);
      const valNode = child.childForFieldName("value") || child.namedChild(1);
      name = idNode ? idNode.text : "arg";
      defaultValueText = valNode ? valNode.text : null;
    } else if (childType === "typed_default_parameter") {
      // (typed_default_parameter name: (identifier) type: (...) value: (...))
      const idNode = child.childForFieldName("name") || child.namedChild(0);
      const tNode = child.childForFieldName("type") || child.namedChild(1);
      const valNode = child.childForFieldName("value") || child.namedChild(2);
      name = idNode ? idNode.text : "arg";
      typeNode = tNode;
      defaultValueText = valNode ? valNode.text : null;
    } else if (childType === "list_splat_pattern") {
      // *args
      const idNode = child.namedChild(0);
      name = idNode ? idNode.text : "args";
      variadic = true;
      kind = "var_positional";
      isKeywordOnly = true; // following parameters are keyword-only
    } else if (childType === "dictionary_splat_pattern") {
      // **kwargs
      const idNode = child.namedChild(0);
      name = idNode ? idNode.text : "kwargs";
      variadic = true;
      kind = "var_keyword";
    }

    const location = mapNodeLocation(child);
    const optional = defaultValueText !== null;

    parameters.push({
      name,
      position: paramPos++,
      type: buildTypeDescriptor(typeNode),
      optional,
      variadic,
      defaultValueText,
      location,
    });

    parameterDetails.push({
      name,
      kind,
    });
  }

  return { parameters, parameterDetails };
}

/**
 * Extracts symbols and declarations from a Python Tree-sitter AST.
 *
 * Supported forms:
 * - Module functions and async functions
 * - Classes and constructors (__init__)
 * - Methods and properties (@property)
 * - Parameters and parameter kinds
 * - Assignments (constants by UPPER_CASE convention vs variables)
 * - Nested functions and classes
 * - Parent-child symbol hierarchy
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @param {string} fileId
 * @returns {Array<object>} Normalized symbol objects matching IR_SCHEMA.json
 */
function extractPythonDeclarations(rootNode, fileId) {
  const symbols = [];
  let symbolCounter = 0;

  function traverse(node, parentSymbol = null, decorators = []) {
    if (!node) return;

    const parentSymbolId = parentSymbol ? parentSymbol.id : null;

    // 0. Handle decorated definitions
    if (node.type === "decorated_definition") {
      const decs = extractDecorators(node);
      const defNode = node.childForFieldName("definition");
      if (defNode) {
        traverse(defNode, parentSymbol, decs);
      }
      return;
    }

    // 1. Function / Async Function / Method / Constructor
    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "anonymous";
      const isAsync = node.children && node.children.some((c) => c.text === "async");
      const isConstructor = name === "__init__";
      const isProperty = decorators.some((d) => d === "@property");

      let kind = parentSymbol && parentSymbol.kind === "class" ? (isConstructor ? "constructor" : "method") : "function";
      if (isProperty) kind = "property";

      const paramsNode = node.childForFieldName("parameters");
      const { parameters, parameterDetails } = extractPythonParameters(paramsNode);

      const returnTypeNode = node.childForFieldName("return_type");
      const returnType = returnTypeNode ? buildTypeDescriptor(returnTypeNode) : null;

      const location = mapNodeLocation(node);
      const nameLocation = nameNode ? mapNodeLocation(nameNode) : null;
      const signature = `def ${name}(...)`;

      // Determine visibility by naming convention (_private, __dunder__)
      let visibility = "public";
      if (name.startsWith("__") && !name.endsWith("__")) {
        visibility = "private";
      } else if (name.startsWith("_")) {
        visibility = "protected";
      }

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind,
        languageKind: isAsync ? "AsyncFunctionDefinition" : "FunctionDefinition",
        parentSymbolId,
        location,
        nameLocation,
        signature,
        parameters,
        returnType,
        typeParameters: [],
        modifiers: isAsync ? ["async", ...decorators] : decorators,
        visibility,
        isExported: !name.startsWith("_"),
        documentation: null,
        languageMetadata: {
          isAsync,
          isConstructor,
          isProperty,
          decorators,
          parameterKinds: parameterDetails,
        },
      });

      symbols.push(sym);

      // Recurse into function body
      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym, []);
        }
      }
      return;
    }

    // 2. Class Definition
    if (node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "anonymous";
      const location = mapNodeLocation(node);
      const nameLocation = nameNode ? mapNodeLocation(nameNode) : null;
      const signature = `class ${name}`;

      let visibility = "public";
      if (name.startsWith("__") && !name.endsWith("__")) {
        visibility = "private";
      } else if (name.startsWith("_")) {
        visibility = "protected";
      }

      const sym = createSymbol({
        fileId,
        index: symbolCounter++,
        name,
        qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
        kind: "class",
        languageKind: "ClassDefinition",
        parentSymbolId,
        location,
        nameLocation,
        signature,
        parameters: [],
        returnType: null,
        typeParameters: [],
        modifiers: decorators,
        visibility,
        isExported: !name.startsWith("_"),
        documentation: null,
        languageMetadata: {
          decorators,
        },
      });

      symbols.push(sym);

      // Recurse into class body
      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          traverse(body.namedChild(i), sym, []);
        }
      }
      return;
    }

    // 3. Variable and Constant Assignments (e.g. x: int = 1 or MAX_SIZE = 100)
    if (node.type === "expression_statement") {
      const expr = node.namedChild(0);
      if (expr && (expr.type === "assignment" || expr.type === "augmented_assignment")) {
        const left = expr.childForFieldName("left") || expr.namedChild(0);
        const typeNode = expr.childForFieldName("type");

        if (left && left.type === "identifier") {
          const name = left.text;
          const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
          const location = mapNodeLocation(node);
          const nameLocation = mapNodeLocation(left);
          const returnType = typeNode ? buildTypeDescriptor(typeNode) : null;

          const sym = createSymbol({
            fileId,
            index: symbolCounter++,
            name,
            qualifiedName: parentSymbol ? `${parentSymbol.name}.${name}` : name,
            kind: isConst ? "constant" : "variable",
            languageKind: "Assignment",
            parentSymbolId,
            location,
            nameLocation,
            signature: `${name}: ${returnType ? returnType.text : "any"}`,
            parameters: [],
            returnType,
            typeParameters: [],
            modifiers: isConst ? ["const"] : [],
            visibility: name.startsWith("_") ? "protected" : "public",
            isExported: !name.startsWith("_"),
            documentation: null,
            languageMetadata: {
              isAllUppercase: isConst,
            },
          });

          symbols.push(sym);
          return;
        }
      }
    }

    // Recurse into generic child nodes
    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i), parentSymbol, []);
    }
  }

  traverse(rootNode, null, []);
  return symbols;
}

module.exports = {
  buildTypeDescriptor,
  extractDecorators,
  extractPythonParameters,
  extractPythonDeclarations,
  extractDeclarations: extractPythonDeclarations,
};
