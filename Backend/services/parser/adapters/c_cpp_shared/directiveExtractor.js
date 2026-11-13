const { createImport, createSymbol } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts preprocessor include directives, macro definitions, and conditional blocks
 * from a C/C++ Tree-sitter AST.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {object} [options]
 * @returns {{ imports: Array<object>, macroSymbols: Array<object> }}
 */
function extractDirectives(rootNode, fileId, options = {}) {
  const imports = [];
  const macroSymbols = [];
  let importCounter = 0;
  let macroCounter = 0;

  if (!rootNode) {
    return { imports, macroSymbols };
  }

  /**
   * Recursively traverses preprocessor directives and conditional blocks.
   *
   * @param {import('tree-sitter').SyntaxNode} node
   * @param {object|null} conditionalContext
   */
  function traverse(node, conditionalContext = null) {
    if (!node) return;

    const nodeType = node.type;

    // 1. #include directive
    if (nodeType === "preproc_include") {
      let rawSource = "";
      let includeType = "unknown";
      let delimiter = "";
      let sourceKind = "unknown";

      const systemLib = node.namedChildren.find((c) => c.type === "system_lib_string");
      const stringLit = node.namedChildren.find((c) => c.type === "string_literal");

      if (systemLib) {
        includeType = "system";
        delimiter = "<>";
        sourceKind = "system";
        rawSource = systemLib.text.replace(/^<|>$/g, "").trim();
      } else if (stringLit) {
        includeType = "quoted";
        delimiter = '""';
        sourceKind = "relative";
        rawSource = stringLit.text.replace(/^["']|["']$/g, "").trim();
      } else {
        // Macro or computed include (e.g. #include HEADER_MACRO)
        const childId = node.namedChildren[0];
        rawSource = childId ? childId.text.trim() : node.text.replace(/^#include\s+/, "").trim();
        includeType = "computed_macro";
        delimiter = "";
        sourceKind = "unknown";
      }

      const location = mapNodeLocation(node);

      imports.push(
        createImport({
          fileId,
          index: importCounter++,
          kind: "include",
          rawSource,
          sourceKind,
          specifiers: [],
          location,
          languageMetadata: {
            includeType,
            delimiter,
            isConditional: conditionalContext !== null,
            condition: conditionalContext ? conditionalContext.condition : null,
          },
        })
      );
      return;
    }

    // 2. #define object-like macro
    if (nodeType === "preproc_def") {
      const nameNode = node.namedChildren.find((c) => c.type === "identifier");
      if (nameNode) {
        const macroName = nameNode.text;
        const argNode = node.namedChildren.find((c) => c.type === "preproc_arg");
        const replacement = argNode ? argNode.text.trim() : "";
        const location = mapNodeLocation(node);
        const nameLocation = mapNodeLocation(nameNode);

        macroSymbols.push(
          createSymbol({
            fileId,
            index: macroCounter++,
            id: `${fileId}#macro_${macroCounter - 1}`,
            name: macroName,
            qualifiedName: macroName,
            kind: "macro",
            languageKind: "macro_definition",
            parentSymbolId: null,
            location,
            nameLocation,
            signature: `#define ${macroName}${replacement ? " " + replacement : ""}`,
            parameters: [],
            returnType: null,
            typeParameters: [],
            modifiers: [],
            visibility: "public",
            isExported: true,
            languageMetadata: {
              isFunctionLike: false,
              replacement,
              isConditional: conditionalContext !== null,
              condition: conditionalContext ? conditionalContext.condition : null,
            },
          })
        );
      }
      return;
    }

    // 3. #define function-like macro
    if (nodeType === "preproc_function_def") {
      const nameNode = node.namedChildren.find((c) => c.type === "identifier");
      if (nameNode) {
        const macroName = nameNode.text;
        const paramsNode = node.namedChildren.find((c) => c.type === "preproc_params");
        const argNode = node.namedChildren.find((c) => c.type === "preproc_arg");
        const paramNames = paramsNode
          ? paramsNode.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text)
          : [];
        const replacement = argNode ? argNode.text.trim() : "";
        const location = mapNodeLocation(node);
        const nameLocation = mapNodeLocation(nameNode);

        macroSymbols.push(
          createSymbol({
            fileId,
            index: macroCounter++,
            id: `${fileId}#macro_${macroCounter - 1}`,
            name: macroName,
            qualifiedName: macroName,
            kind: "macro",
            languageKind: "macro_definition",
            parentSymbolId: null,
            location,
            nameLocation,
            signature: `#define ${macroName}(${paramNames.join(", ")})${replacement ? " " + replacement : ""}`,
            parameters: paramNames.map((p) => ({ name: p, type: null, location: null })),
            returnType: null,
            typeParameters: [],
            modifiers: [],
            visibility: "public",
            isExported: true,
            languageMetadata: {
              isFunctionLike: true,
              parameters: paramNames,
              replacement,
              isConditional: conditionalContext !== null,
              condition: conditionalContext ? conditionalContext.condition : null,
            },
          })
        );
      }
      return;
    }

    // 4. Conditional preprocessor blocks (#ifdef, #ifndef, #if, #elif, #else)
    if (["preproc_ifdef", "preproc_ifndef", "preproc_if", "preproc_elif", "preproc_else"].includes(nodeType)) {
      const conditionDirective = node.children[0] ? node.children[0].text : nodeType;
      const conditionParam = node.namedChildren[0] && node.namedChildren[0].type !== "preproc_include"
        ? node.namedChildren[0].text
        : "";
      const conditionText = `${conditionDirective} ${conditionParam}`.trim();

      const newContext = {
        directive: conditionDirective,
        condition: conditionText,
      };

      for (let i = 0; i < node.namedChildCount; i++) {
        traverse(node.namedChild(i), newContext);
      }
      return;
    }

    // Descend into top-level children
    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i), conditionalContext);
    }
  }

  traverse(rootNode, null);

  return { imports, macroSymbols };
}

module.exports = {
  extractDirectives,
};

