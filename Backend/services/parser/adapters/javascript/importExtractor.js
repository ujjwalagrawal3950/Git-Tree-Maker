const ts = require("typescript");
const { createImport } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Classifies the source kind based on the specifier string.
 *
 * @param {string|null} rawSource
 * @returns {"relative"|"package"|"absolute"|"system"|"module"|"unknown"|null}
 */
function classifySourceKind(rawSource) {
  if (!rawSource || typeof rawSource !== "string") {
    return "unknown";
  }
  if (rawSource.startsWith("./") || rawSource.startsWith("../")) {
    return "relative";
  }
  if (rawSource.startsWith("/") || rawSource.startsWith("\\")) {
    return "absolute";
  }
  return "package";
}

/**
 * Extracts import declarations, static dynamic imports, and CommonJS require calls from a TS SourceFile AST.
 *
 * Supported forms:
 * - ESM default, named, and namespace imports (`import x from 'y'`, `import { a as b } from 'y'`, `import * as y from 'y'`)
 * - Side-effect imports (`import './styles.css'`)
 * - Type-only imports (`import type { X } from 'y'` or `import { type X } from 'y'`)
 * - Dynamic imports with string literals (`import('module')`) and dynamic expressions (`import(variable)`)
 * - CommonJS require calls (`require('module')`, `const x = require('module')`)
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @returns {Array<object>} Normalized import objects conforming to IR_SCHEMA.json
 */
function extractImports(sourceFile, fileId) {
  const imports = [];
  let importCounter = 0;

  function traverse(node) {
    if (!node) return;

    // 1. ESM Import Declaration
    if (ts.isImportDeclaration(node)) {
      const location = mapNodeLocation(sourceFile, node);
      let rawSource = null;

      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        rawSource = node.moduleSpecifier.text;
      }

      const sourceKind = classifySourceKind(rawSource);
      const specifiers = [];
      const importClause = node.importClause;

      if (importClause) {
        const topLevelTypeOnly = Boolean(importClause.isTypeOnly);

        // Default import: import React from 'react'
        if (importClause.name) {
          specifiers.push({
            kind: "default",
            importedName: "default",
            localName: importClause.name.text,
            isTypeOnly: topLevelTypeOnly,
          });
        }

        // Named or Namespace imports
        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            // import * as ns from 'pkg'
            specifiers.push({
              kind: "namespace",
              importedName: "*",
              localName: importClause.namedBindings.name.text,
              isTypeOnly: topLevelTypeOnly,
            });
          } else if (ts.isNamedImports(importClause.namedBindings)) {
            // import { a, b as c, type d } from 'pkg'
            for (const elem of importClause.namedBindings.elements) {
              const elemTypeOnly = topLevelTypeOnly || Boolean(elem.isTypeOnly);
              const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
              const localName = elem.name.text;

              specifiers.push({
                kind: "named",
                importedName,
                localName,
                isTypeOnly: elemTypeOnly,
              });
            }
          }
        }
      }

      imports.push(
        createImport({
          fileId,
          index: importCounter++,
          kind: "module_import",
          rawSource,
          sourceKind,
          specifiers,
          location,
          languageMetadata: { isTypeOnly: Boolean(importClause && importClause.isTypeOnly) },
        })
      );
      return;
    }

    // 2. Dynamic import: import("./module")
    if (
      ts.isCallExpression(node) &&
      node.expression &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const location = mapNodeLocation(sourceFile, node);
      const firstArg = node.arguments[0];
      let rawSource = null;
      let isDynamic = true;

      if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        rawSource = firstArg.text;
        isDynamic = false;
      }

      imports.push(
        createImport({
          fileId,
          index: importCounter++,
          kind: "dynamic_import",
          rawSource,
          sourceKind: classifySourceKind(rawSource),
          specifiers: [],
          location,
          languageMetadata: { isDynamicExpression: isDynamic },
        })
      );
    }

    // 3. CommonJS require call: require("module")
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length >= 1
    ) {
      const location = mapNodeLocation(sourceFile, node);
      const firstArg = node.arguments[0];
      let rawSource = null;
      let isDynamic = true;

      if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        rawSource = firstArg.text;
        isDynamic = false;
      }

      // Check if assigned to a variable: const helper = require("./helper")
      const specifiers = [];
      if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        specifiers.push({
          kind: "default",
          importedName: "default",
          localName: node.parent.name.text,
          isTypeOnly: false,
        });
      }

      imports.push(
        createImport({
          fileId,
          index: importCounter++,
          kind: "require_call",
          rawSource,
          sourceKind: classifySourceKind(rawSource),
          specifiers,
          location,
          languageMetadata: { isDynamicExpression: isDynamic },
        })
      );
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return imports;
}

module.exports = {
  classifySourceKind,
  extractImports,
};

