const Parser = require("tree-sitter");
const Cpp = require("tree-sitter-cpp");
const { createDiagnostic } = require("../../irBuilder");
const { mapNodeLocation } = require("../c_cpp_shared/locationMapper");

/**
 * Creates and initializes a Tree-sitter C++ parser instance.
 *
 * @returns {Parser}
 */
function createCppParser() {
  const parser = new Parser();
  parser.setLanguage(Cpp);
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
function collectCppSyntaxDiagnostics(node, diagnostics, filePath) {
  if (!node || !node.hasError) return;

  if (node.type === "ERROR" || node.isMissing) {
    const loc = mapNodeLocation(node);
    const message = node.isMissing
      ? `Missing C++ syntax element at line ${loc.start.line}, column ${loc.start.column}`
      : `C++ syntax error: unexpected token '${node.text ? node.text.slice(0, 40) : ""}'`;

    diagnostics.push(
      createDiagnostic({
        code: "CPP_SYNTAX_ERROR",
        severity: "error",
        message,
        location: loc,
      })
    );
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    collectCppSyntaxDiagnostics(node.child(i), diagnostics, filePath);
  }
}

/**
 * In-memory parses C++ source text and returns the CST along with syntax diagnostics.
 * Never writes files to disk or executes the compiler.
 *
 * @param {string} content - Raw C++ source code
 * @param {string} [filePath="unknown.cpp"] - Source file path for diagnostic reporting
 * @returns {{
 *   tree: import('tree-sitter').Tree,
 *   diagnostics: Array<object>,
 *   hasErrors: boolean
 * }}
 */
function parseCppSource(content, filePath = "unknown.cpp") {
  const parser = createCppParser();
  const source = typeof content === "string" ? content : "";
  const tree = parser.parse(source);

  const diagnostics = [];
  collectCppSyntaxDiagnostics(tree.rootNode, diagnostics, filePath);

  if (tree.rootNode.hasError && diagnostics.length === 0) {
    diagnostics.push(
      createDiagnostic({
        code: "CPP_SYNTAX_ERROR",
        severity: "error",
        message: "C++ syntax error detected during parsing",
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
  createCppParser,
  parseCppSource,
  collectCppSyntaxDiagnostics,
};
