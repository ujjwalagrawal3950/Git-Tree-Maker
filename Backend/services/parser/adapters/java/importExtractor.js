const { createImport } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Extracts all import declarations (single-type, wildcard, static single-member, static wildcard)
 * from a Java Tree-sitter AST root node.
 *
 * @param {import('tree-sitter').SyntaxNode} rootNode
 * @param {string} fileId
 * @param {string|null} currentPackageName Enclosing package name (if declared)
 * @returns {Array<object>} Array of schema-compliant Import objects
 */
function extractJavaImports(rootNode, fileId, currentPackageName = null) {
  const imports = [];
  let importCounter = 0;

  if (!rootNode) return imports;

  for (const child of rootNode.children) {
    if (child.type !== "import_declaration") continue;

    const location = mapNodeLocation(child);
    const isStatic = child.children.some((c) => c.type === "static");
    const isWildcard = child.children.some((c) => c.type === "asterisk");

    const nameNode = child.namedChildren.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier"
    );

    const nameText = nameNode ? nameNode.text : "";
    const rawSource = isWildcard ? `${nameText}.*` : nameText;

    let importKind = isWildcard ? "package_import" : "module_import";
    let packageName = "";
    let className = null;
    let memberName = null;
    let importedType = null;
    let specifierKind = isWildcard ? "wildcard" : "named";
    let importedName = isWildcard ? "*" : null;
    let localName = isWildcard ? "*" : null;

    if (!isWildcard && !isStatic) {
      // Normal single-type import: e.g. java.util.List or RootClass
      const parts = nameText.split(".");
      importedName = parts[parts.length - 1];
      localName = importedName;
      packageName = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
      importedType = importedName;
    } else if (isWildcard && !isStatic) {
      // Wildcard on-demand import: e.g. java.util.*
      packageName = nameText;
    } else if (!isWildcard && isStatic) {
      // Static single-member import: e.g. java.lang.Math.PI
      const parts = nameText.split(".");
      memberName = parts[parts.length - 1];
      importedName = memberName;
      localName = memberName;
      className = parts.length > 1 ? parts[parts.length - 2] : null;
      packageName = parts.length > 2 ? parts.slice(0, -2).join(".") : "";
    } else if (isWildcard && isStatic) {
      // Static wildcard import: e.g. java.lang.Math.*
      const parts = nameText.split(".");
      className = parts[parts.length - 1];
      packageName = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
    }

    const specifiers = [
      {
        kind: specifierKind,
        importedName,
        localName,
        isTypeOnly: false,
      },
    ];

    const languageMetadata = {
      isStatic,
      isWildcard,
      packageName,
      ...(className !== null ? { className } : {}),
      ...(memberName !== null ? { memberName } : {}),
      ...(importedType !== null ? { importedType } : {}),
      fullyQualifiedName: rawSource,
      ...(currentPackageName ? { currentPackage: currentPackageName } : {}),
    };

    imports.push(
      createImport({
        fileId,
        index: importCounter++,
        kind: importKind,
        rawSource,
        sourceKind: "package",
        specifiers,
        location,
        languageMetadata,
      })
    );
  }

  return imports;
}

module.exports = {
  extractJavaImports,
};

