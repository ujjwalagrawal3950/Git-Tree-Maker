const { createImport } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Counts leading relative dots in a module specifier string.
 * e.g. ".utils" -> 1, "..common" -> 2, "." -> 1, "math" -> 0
 *
 * @param {string} moduleText
 * @returns {number}
 */
function countRelativeDots(moduleText) {
  if (!moduleText) return 0;
  let count = 0;
  while (count < moduleText.length && moduleText[count] === ".") {
    count++;
  }
  return count;
}

/**
 * Extracts all import declarations, relative imports, and dynamic imports from a Python Tree-sitter AST.
 *
 * Supported forms:
 * - `import os, sys as system`
 * - `from math import sin, cos as cosine`
 * - `from . import local_mod`
 * - `from .utils import parse`
 * - `from ..common.types import User`
 * - `from pkg import *`
 * - `importlib.import_module("pkg")` and `__import__("pkg")`
 *
 * @param {import("tree-sitter").SyntaxNode} rootNode
 * @param {string} fileId
 * @returns {Array<object>} Normalized import objects conforming to IR_SCHEMA.json
 */
function extractPythonImports(rootNode, fileId) {
  const imports = [];
  let importCounter = 0;

  function traverse(node) {
    if (!node) return;

    // 1. Standard import statement: import x, y as z
    if (node.type === "import_statement") {
      const location = mapNodeLocation(node);

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        let rawSource = null;
        let importedName = null;
        let localName = null;

        if (child.type === "dotted_name") {
          rawSource = child.text;
          importedName = child.text;
          localName = child.text;
        } else if (child.type === "aliased_import") {
          // (aliased_import name: (dotted_name) alias: (identifier))
          const nameNode = child.childForFieldName("name") || child.namedChild(0);
          const aliasNode = child.childForFieldName("alias") || child.namedChild(1);
          rawSource = nameNode ? nameNode.text : child.text;
          importedName = rawSource;
          localName = aliasNode ? aliasNode.text : rawSource;
        }

        if (rawSource) {
          imports.push(
            createImport({
              fileId,
              index: importCounter++,
              kind: "module_import",
              rawSource,
              sourceKind: "package",
              specifiers: [
                {
                  kind: "named",
                  importedName,
                  localName,
                  isTypeOnly: false,
                },
              ],
              location,
              languageMetadata: {
                isFromImport: false,
                relativeLevel: 0,
              },
            })
          );
        }
      }
      return;
    }

    // 2. From import statement: from ... import ...
    if (node.type === "import_from_statement") {
      const location = mapNodeLocation(node);
      const moduleNode = node.childForFieldName("module_name");

      // Extract module source text or relative dots
      let rawSource = moduleNode ? moduleNode.text : ".";
      let relativeLevel = countRelativeDots(rawSource);
      const isRelative = relativeLevel > 0;

      const specifiers = [];

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child === moduleNode || child.type === "relative_import") continue;

        if (child.type === "dotted_name" || child.type === "identifier") {
          specifiers.push({
            kind: "named",
            importedName: child.text,
            localName: child.text,
            isTypeOnly: false,
          });
        } else if (child.type === "aliased_import") {
          const nameNode = child.childForFieldName("name") || child.namedChild(0);
          const aliasNode = child.childForFieldName("alias") || child.namedChild(1);
          specifiers.push({
            kind: "named",
            importedName: nameNode ? nameNode.text : child.text,
            localName: aliasNode ? aliasNode.text : child.text,
            isTypeOnly: false,
          });
        } else if (child.type === "wildcard_import") {
          specifiers.push({
            kind: "wildcard",
            importedName: "*",
            localName: "*",
            isTypeOnly: false,
          });
        }
      }

      const isWildcard = specifiers.some((s) => s.kind === "wildcard");
      imports.push(
        createImport({
          fileId,
          index: importCounter++,
          kind: "module_import",
          rawSource,
          sourceKind: isRelative ? "relative" : "package",
          specifiers,
          location,
          languageMetadata: {
            isFromImport: true,
            isRelative,
            relativeLevel,
            isWildcard,
          },
        })
      );
      return;
    }

    // 3. Dynamic importlib / __import__ calls
    if (node.type === "call") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        const fnText = fnNode.text;
        const isImportCall =
          fnText === "__import__" ||
          fnText === "importlib.import_module" ||
          fnText.endsWith(".import_module");

        if (isImportCall) {
          const location = mapNodeLocation(node);
          const argsNode = node.childForFieldName("arguments");
          let rawSource = null;
          let isDynamic = true;

          if (argsNode && argsNode.namedChildCount > 0) {
            const firstArg = argsNode.namedChild(0);
            if (firstArg && firstArg.type === "string") {
              // Strip quotes e.g. "pkg" or 'pkg'
              rawSource = firstArg.text.replace(/^['"]|['"]$/g, "");
              isDynamic = false;
            }
          }

          imports.push(
            createImport({
              fileId,
              index: importCounter++,
              kind: "dynamic_import",
              rawSource,
              sourceKind: rawSource && rawSource.startsWith(".") ? "relative" : "package",
              specifiers: [],
              location,
              languageMetadata: {
                isDynamic: true,
                isDynamicExpression: isDynamic,
                dynamicCallee: fnText,
              },
            })
          );
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(rootNode);
  return imports;
}

module.exports = {
  countRelativeDots,
  extractPythonImports,
  extractImports: extractPythonImports,
};
