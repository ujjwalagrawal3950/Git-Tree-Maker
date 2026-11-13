const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");
const { mapNodeLocation } = require("./locationMapper");
const { createDiagnostic } = require("../../irBuilder");

// Singleton parser instance for Java
const javaParser = new Parser();
javaParser.setLanguage(Java);

/**
 * Traverses a Tree-sitter tree to collect syntax error nodes.
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @returns {Array<object>} Schema-compliant diagnostic objects
 */
function collectSyntaxErrors(rootNode) {
  const diagnostics = [];
  if (!rootNode || !rootNode.hasError) return diagnostics;

  function walk(node) {
    if (!node) return;

    if (node.type === "ERROR" || node.isMissing) {
      const snippet = node.text ? node.text.slice(0, 40) : "unexpected token";
      diagnostics.push(
        createDiagnostic({
          code: "JAVA_SYNTAX_ERROR",
          severity: "error",
          message: `Java syntax error near: ${snippet.trim() || "unknown"}`,
          location: mapNodeLocation(node),
        })
      );
    }

    if (node.hasError) {
      for (let i = 0; i < node.namedChildCount; i++) {
        walk(node.namedChild(i));
      }
    }
  }

  walk(rootNode);
  return diagnostics;
}

/**
 * Parses Java source code text into a Tree-sitter syntax tree.
 * Pure in-memory syntax parsing with robust error recovery.
 * Never compiles Java code or requires a Java runtime.
 *
 * @param {string} content - Raw Java source code
 * @param {string} [filePath] - Optional path for context
 * @returns {{
 *   tree: import("tree-sitter").Tree,
 *   rootNode: import("tree-sitter").SyntaxNode,
 *   diagnostics: Array<object>,
 *   hasErrors: boolean
 * }}
 */
function parseJavaSource(content, filePath = "Source.java") {
  const safeContent = typeof content === "string" ? content : "";
  const tree = javaParser.parse(safeContent);
  const rootNode = tree.rootNode;
  const diagnostics = collectSyntaxErrors(rootNode);

  return {
    tree,
    rootNode,
    diagnostics,
    hasErrors: diagnostics.length > 0,
  };
}

module.exports = {
  javaParser,
  collectSyntaxErrors,
  parseJavaSource,
};

