/**
 * Maps a Tree-sitter AST node's start and end coordinates into Cartograph standard location:
 * - Line: 1-based (Tree-sitter row + 1)
 * - Column: 0-based (Tree-sitter column)
 * - End coordinates: exclusive
 *
 * @param {import('tree-sitter').SyntaxNode} node
 * @returns {{
 *   start: { line: number, column: number },
 *   end: { line: number, column: number }
 * }}
 */
function mapNodeLocation(node) {
  if (!node) {
    return {
      start: { line: 1, column: 0 },
      end: { line: 1, column: 0 },
    };
  }

  const startPosition = node.startPosition || { row: 0, column: 0 };
  const endPosition = node.endPosition || { row: 0, column: 0 };

  return {
    start: {
      line: startPosition.row + 1,
      column: startPosition.column,
    },
    end: {
      line: endPosition.row + 1,
      column: endPosition.column,
    },
  };
}

module.exports = {
  mapNodeLocation,
};

