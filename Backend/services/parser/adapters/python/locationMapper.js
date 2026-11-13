const { createLocation } = require("../../irBuilder");

/**
 * Maps a Tree-sitter AST node or position into a normalized Cartograph source location.
 *
 * Tree-sitter coordinates:
 * - row: 0-based
 * - column: 0-based
 *
 * Cartograph coordinates:
 * - line: 1-based (start.line >= 1)
 * - column: 0-based (start.column >= 0)
 * - end positions are exclusive
 *
 * @param {import("tree-sitter").SyntaxNode} node
 * @returns {object} Normalized Cartograph location object matching IR_SCHEMA.json
 */
function mapNodeLocation(node) {
  if (!node) {
    return createLocation(1, 0, 1, 0);
  }

  const start = node.startPosition || { row: 0, column: 0 };
  const end = node.endPosition || { row: 0, column: 0 };

  return createLocation(
    start.row + 1,
    start.column,
    end.row + 1,
    end.column
  );
}

module.exports = {
  mapNodeLocation,
};

