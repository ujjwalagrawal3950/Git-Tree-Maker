const Parser = require("tree-sitter");
const C = require("tree-sitter-c");
const { createDiagnostic } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Creates and initializes a Tree-sitter C parser instance.
 *
 * @returns {Parser}
 */
function createCParser() {
  const parser = new Parser();
  parser.setLanguage(C);
  return parser;
}

/**
 * Recursively inspects a Tree-sitter AST node for ERROR or MISSING nodes,
 * collecting syntax diagnostics.
 *
 * @param {import('tree-sitter').SyntaxNode} node
 * @param {Array<object>} diagnostics
 * @param {string} filePath
 */
function collectCSyntaxDiagnostics(node, diagnostics, filePath) {
  if (!node || !node.hasError) return;

  if (node.type === "ERROR" || node.isMissing) {
    const loc = mapNodeLocation(node);
    const message = node.isMissing
      ? `Missing C syntax element at line ${loc.start.line}, column ${loc.start.column}`
      : `C syntax error: unexpected token '${node.text ? node.text.slice(0, 40) : ""}'`;

    diagnostics.push(
      createDiagnostic({
        code: "C_SYNTAX_ERROR",
        severity: "error",
        message,
        location: loc,
      })
    );
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    collectCSyntaxDiagnostics(node.child(i), diagnostics, filePath);
  }
}

/**
 * In-memory parses C source text and returns the CST along with syntax diagnostics.
 * Never writes files to disk or executes the compiler.
 *
 * @param {string} content - Raw C source code
 * @param {string} [filePath="unknown.c"] - Source file path for diagnostic reporting
 * @returns {{
 *   tree: import('tree-sitter').Tree,
 *   diagnostics: Array<object>,
 *   hasErrors: boolean
 * }}
 */
function parseCSource(content, filePath = "unknown.c") {
  const parser = createCParser();
  const source = typeof content === "string" ? content : "";
  const tree = parser.parse(source);

  const diagnostics = [];
  collectCSyntaxDiagnostics(tree.rootNode, diagnostics, filePath);

  if (tree.rootNode.hasError && diagnostics.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "C_SYNTAX_ERROR",
        severity: "error",
        message: "C syntax error detected during parsing",
        location: mapNodeLocation(tree.rootNode),
      })
    );
  }

  return {
    tree,
    diagnostics,
    hasErrors: diagnostics.length > 0,
  };
}

module.exports = {
  createCParser,
  parseCSource,
  collectCSyntaxDiagnostics,
};
