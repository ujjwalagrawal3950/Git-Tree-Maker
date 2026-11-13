const ts = require("typescript");
const { createExport } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts export declarations, re-exports, default exports, and CommonJS export patterns from a TS SourceFile AST.
 *
 * Supported forms:
 * - Named exports: `export { a, b as c }`
 * - Re-exports: `export { x } from './module'`, `export * as ns from './module'`
 * - Wildcard re-exports: `export * from './module'`
 * - Exported declarations: `export function f() {}`, `export class C {}`, `export const x = 1`
 * - Default exports: `export default expression`, `export default function() {}`
 * - CommonJS: `module.exports = ...`, `module.exports.foo = ...`, `exports.bar = ...`
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} fileId
 * @param {Array<object>} [symbols] - Optional pre-extracted symbols to link symbolId
 * @returns {Array<object>} Normalized export objects conforming to IR_SCHEMA.json
 */
function extractExports(sourceFile, fileId, symbols = []) {
  const exports = [];
  let exportCounter = 0;

  // Build name-to-symbolId lookup map for linking
  const symbolMap = new Map();
  for (const sym of symbols) {
    if (sym.name && !symbolMap.has(sym.name)) {
      symbolMap.set(sym.name, sym.id);
    }
  }

  function traverse(node) {
    if (!node) return;

    // 1. Export Declaration: export { a, b as c } or export { a } from './module' or export * from './module'
    if (ts.isExportDeclaration(node)) {
      const location = mapNodeLocation(sourceFile, node);
      let source = null;

      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        source = node.moduleSpecifier.text;
      }

      if (node.exportClause) {
        if (ts.isNamedExports(node.exportClause)) {
          for (const elem of node.exportClause.elements) {
            const exportedName = elem.name.text;
            const localName = elem.propertyName ? elem.propertyName.text : elem.name.text;
            const symbolId = source ? null : (symbolMap.get(localName) || null);

            exports.push(
              createExport({
                fileId,
                index: exportCounter++,
                kind: source ? "reexport" : "named",
                symbolId,
                exportedName,
                source,
                location: mapNodeLocation(sourceFile, elem),
                languageMetadata: {
                  localName,
                  isTypeOnly: Boolean(node.isTypeOnly || elem.isTypeOnly),
                },
              })
            );
          }
        } else if (ts.isNamespaceExport && ts.isNamespaceExport(node.exportClause)) {
          // export * as ns from './module'
          const exportedName = node.exportClause.name.text;
          exports.push(
            createExport({
              fileId,
              index: exportCounter++,
              kind: "reexport",
              symbolId: null,
              exportedName,
              source,
              location,
              languageMetadata: { isNamespaceReexport: true },
            })
          );
        }
      } else {
        // export * from './module'
        exports.push(
          createExport({
            fileId,
            index: exportCounter++,
            kind: "wildcard",
            symbolId: null,
            exportedName: "*",
            source,
            location,
            languageMetadata: { isWildcardReexport: true },
          })
        );
      }
      return;
    }

    // 2. Export Default Declaration: export default function / class / expr
    if (ts.isExportAssignment(node)) {
      const location = mapNodeLocation(sourceFile, node);
      let symbolId = null;

      if (ts.isIdentifier(node.expression)) {
        symbolId = symbolMap.get(node.expression.text) || null;
      }

      exports.push(
        createExport({
          fileId,
          index: exportCounter++,
          kind: "default",
          symbolId,
          exportedName: "default",
          source: null,
          location,
          languageMetadata: { isExportAssignment: true },
        })
      );
      return;
    }

    // 3. Exported Declarations (export function f() {}, export class C {}, export const v = 1)
    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node) || [];
      const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

      if (hasExport) {
        const location = mapNodeLocation(sourceFile, node);

        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
          const name = node.name ? node.name.text : (hasDefault ? "default" : "anonymous");
          const symbolId = node.name ? (symbolMap.get(name) || null) : null;

          exports.push(
            createExport({
              fileId,
              index: exportCounter++,
              kind: hasDefault ? "default" : "named",
              symbolId,
              exportedName: hasDefault ? "default" : name,
              source: null,
              location,
              languageMetadata: {},
            })
          );
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (decl.name && ts.isIdentifier(decl.name)) {
              const name = decl.name.text;
              const symbolId = symbolMap.get(name) || null;

              exports.push(
                createExport({
                  fileId,
                  index: exportCounter++,
                  kind: "named",
                  symbolId,
                  exportedName: name,
                  source: null,
                  location: mapNodeLocation(sourceFile, decl),
                  languageMetadata: {},
                })
              );
            }
          }
        } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
          const name = node.name.text;
          const symbolId = symbolMap.get(name) || null;

          exports.push(
            createExport({
              fileId,
              index: exportCounter++,
              kind: "named",
              symbolId,
              exportedName: name,
              source: null,
              location,
              languageMetadata: { isTypeDeclaration: true },
            })
          );
        }
      }
    }

    // 4. CommonJS Exports: module.exports = ... or exports.name = ... or module.exports.name = ...
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const location = mapNodeLocation(sourceFile, node);

      // module.exports = ...
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "module" &&
        left.name.text === "exports"
      ) {
        exports.push(
          createExport({
            fileId,
            index: exportCounter++,
            kind: "default",
            symbolId: null,
            exportedName: "default",
            source: null,
            location,
            languageMetadata: { isCommonJS: true, target: "module.exports" },
          })
        );
      }
      // exports.foo = ... or module.exports.foo = ...
      else if (
        ts.isPropertyAccessExpression(left) &&
        (
          (ts.isIdentifier(left.expression) && left.expression.text === "exports") ||
          (
            ts.isPropertyAccessExpression(left.expression) &&
            ts.isIdentifier(left.expression.expression) &&
            left.expression.expression.text === "module" &&
            left.expression.name.text === "exports"
          )
        )
      ) {
        const exportedName = left.name.text;
        exports.push(
          createExport({
            fileId,
            index: exportCounter++,
            kind: "named",
            symbolId: null,
            exportedName,
            source: null,
            location,
            languageMetadata: { isCommonJS: true, target: "named_property" },
          })
        );
      }
    }

    ts.forEachChild(node, traverse);
  }

  ts.forEachChild(sourceFile, traverse);
  return exports;
}

module.exports = {
  extractExports,
};

