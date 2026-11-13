const BaseAdapter = require("../BaseAdapter");
const { parsePythonSource } = require("./parserFactory");
const { extractPythonDeclarations } = require("./declarationExtractor");
const { extractPythonImports } = require("./importExtractor");
const { extractCallSites } = require("./callExtractor");
const { extractTypeFacts } = require("./typeExtractor");
const { buildFileIR, createFileId, createExport } = require("../../irBuilder");
const { mapNodeLocation } = require("./locationMapper");

/**
 * Parses Python source text and builds a normalized FileIR document.
 *
 * @param {import('../BaseAdapter')} adapter
 * @param {object} file
 * @param {object} [options]
 * @returns {Promise<object>} Validated FileIR
 */
async function parsePythonFile(adapter, file, options = {}) {
  const startTime = Date.now();
  const repository = file.repository || options.repository || {
    owner: "unknown",
    name: "unknown",
    fullName: "unknown/unknown",
    commitSha: "0000000000000000000000000000000000000000",
  };

  const fileId = file.fileId || createFileId(repository.fullName, file.path);
  const content = typeof file.content === "string" ? file.content : "";

  // 1. In-memory Tree-sitter parse and syntax error diagnostics capture
  const { tree, diagnostics, hasErrors } = parsePythonSource(content, file.path);

  // 2. Syntax fact extraction
  const symbols = extractPythonDeclarations(tree.rootNode, content, fileId);
  const imports = extractPythonImports(tree.rootNode, content, fileId);
  const callSites = extractCallSites(tree.rootNode, content, fileId, symbols);
  const { typeReferences, inheritance } = extractTypeFacts(tree.rootNode, content, fileId, symbols);

  // 3. Export extraction: detect explicit __all__ or surface top-level public symbols
  const exports = [];
  let exportCounter = 0;

  // Check for `__all__ = [...]` in the root AST
  let allExportNames = null;
  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (child.type === "expression_statement") {
      const expr = child.namedChild(0);
      if (expr && expr.type === "assignment") {
        const left = expr.childForFieldName("left");
        const right = expr.childForFieldName("right");
        if (left && left.text === "__all__" && right && (right.type === "list" || right.type === "tuple")) {
          allExportNames = [];
          for (let j = 0; j < right.namedChildCount; j++) {
            const item = right.namedChild(j);
            if (item.type === "string") {
              // Strip quotes
              const strVal = item.text.replace(/^['"]|['"]$/g, "");
              allExportNames.push({ name: strVal, node: item });
            }
          }
          break;
        }
      }
    }
  }

  if (allExportNames !== null) {
    for (const exp of allExportNames) {
      const matchingSym = symbols.find((s) => s.name === exp.name && s.parentSymbolId === null);
      const loc = mapNodeLocation(exp.node, content);
      exports.push(
        createExport({
          fileId,
          index: exportCounter++,
          kind: "named",
          symbolId: matchingSym ? matchingSym.id : null,
          exportedName: exp.name,
          source: null,
          location: loc,
          languageMetadata: {
            mechanism: "__all__",
          },
        })
      );
    }
  } else {
    // Top-level public declarations (functions, classes) are implicitly exportable in Python
    for (const sym of symbols) {
      if (sym.parentSymbolId === null && sym.isExported && ["function", "class", "variable", "constant"].includes(sym.kind)) {
        exports.push(
          createExport({
            fileId,
            index: exportCounter++,
            kind: "named",
            symbolId: sym.id,
            exportedName: sym.name,
            source: null,
            location: sym.location,
            languageMetadata: {
              mechanism: "implicit_public",
            },
          })
        );
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const status = hasErrors ? "partial" : "complete";

  return buildFileIR({
    repository,
    file: {
      fileId,
      path: file.path,
      blobSha: file.blobSha || "0000000000000000000000000000000000000000",
      language: file.language || adapter.getSupportedLanguages()[0],
      category: file.category || "source",
      sizeBytes: typeof file.size === "number" ? file.size : Buffer.byteLength(content, "utf8"),
      content,
    },
    parser: {
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      engine: adapter.engine,
      engineVersion: adapter.engineVersion,
      grammarVersion: adapter.grammarVersion,
      status,
      capabilities: adapter.capabilities,
      durationMs,
    },
    symbols,
    imports,
    exports,
    callSites,
    typeReferences,
    inheritance,
    diagnostics,
  });
}

/**
 * Python Language Parser Adapter.
 * Supports .py and .pyi files using tree-sitter-python.
 */
class PythonAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "python-adapter",
      adapterVersion: "1.0.0",
      engine: "tree-sitter",
      engineVersion: "0.25.1",
      grammarVersion: "0.25.0",
      capabilities: [
        "symbols",
        "imports",
        "exports",
        "calls",
        "type_references",
        "inheritance",
      ],
    });
  }

  getSupportedLanguages() {
    return ["python"];
  }

  async parseFile(file, options = {}) {
    return parsePythonFile(this, file, options);
  }
}

module.exports = {
  PythonAdapter,
  parsePythonFile,
};

