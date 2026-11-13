const { createLocation } = require("../../irBuilder");

/**
 * Maps TypeScript AST node or start/end character offsets into a normalized Cartograph source location.
 *
 * Cartograph coordinate conventions:
 * - Line is 1-based (start.line >= 1).
 * - Column is 0-based (start.column >= 0).
 * - End positions are exclusive.
 *
 * @param {import("typescript").SourceFile} sourceFile - The parsed TS SourceFile
 * @param {number|import("typescript").Node} nodeOrStart - An AST node with getStart()/getEnd(), or a start offset
 * @param {number} [endOffset] - End offset (if nodeOrStart is a numeric start offset)
 * @returns {object} Normalized Cartograph location object matching IR_SCHEMA.json
 */
function mapNodeLocation(sourceFile, nodeOrStart, endOffset) {
  if (!sourceFile) {
    return createLocation(1, 0, 1, 0);
  }

  let startPos = 0;
  let endPos = 0;

  if (typeof nodeOrStart === "number") {
    startPos = Math.max(0, nodeOrStart);
    endPos = typeof endOffset === "number" ? Math.max(startPos, endOffset) : startPos;
  } else if (nodeOrStart && typeof nodeOrStart.getStart === "function") {
    // getStart(sourceFile) returns start position excluding leading comments/trivia
    startPos = nodeOrStart.getStart(sourceFile);
    endPos = nodeOrStart.getEnd();
  } else if (nodeOrStart && typeof nodeOrStart.pos === "number" && typeof nodeOrStart.end === "number") {
    startPos = nodeOrStart.pos;
    endPos = nodeOrStart.end;
  }

  // TypeScript getLineAndCharacterOfPosition returns 0-based line and 0-based character
  const startLoc = sourceFile.getLineAndCharacterOfPosition(startPos);
  const endLoc = sourceFile.getLineAndCharacterOfPosition(endPos);

  // Cartograph standard: 1-based line, 0-based column
  return createLocation(
    startLoc.line + 1,
    startLoc.character,
    endLoc.line + 1,
    endLoc.character
  );
}

module.exports = {
  mapNodeLocation,
};

