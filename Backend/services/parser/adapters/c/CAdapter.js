const BaseAdapter = require("../BaseAdapter");
const { parseCSource } = require("./parserFactory");
const { extractDirectives } = require("../c_cpp_shared/directiveExtractor");
const { extractCDeclarations } = require("./declarationExtractor");
const { extractCCallSites } = require("./callExtractor");
const { extractCTypeFacts } = require("./typeExtractor");
const { buildFileIR, createFileId, createExport } = require("../../irBuilder");

/**
 * Parses C source text and builds a normalized FileIR document.
 *
 * @param {import('../BaseAdapter')} adapter
 * @param {object} file
 * @param {object} [options]
 * @returns {Promise<object>} Validated FileIR
 */
async function parseCFile(adapter, file, options = {}) {
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
  const { tree, diagnostics, hasErrors } = parseCSource(content, file.path);

  // 2. Syntax fact extraction
  const { imports, macroSymbols } = extractDirectives(tree.rootNode, fileId);
  const declSymbols = extractCDeclarations(tree.rootNode, content, fileId);
  const symbols = [...declSymbols, ...macroSymbols];

  const callSites = extractCCallSites(tree.rootNode, fileId, symbols);
  const { typeReferences, inheritance } = extractCTypeFacts(tree.rootNode, fileId, symbols);

  // 3. Top-level public/extern declarations are exportable in C
  const exports = [];
  let exportCounter = 0;
  for (const sym of symbols) {
    if (
      sym.parentSymbolId === null &&
      sym.isExported &&
      ["function", "struct", "enum", "type_alias", "variable", "constant"].includes(sym.kind)
    ) {
      exports.push(
        createExport({
          fileId,
          index: exportCounter++,
          kind: "named",
          symbolId: sym.id,
          exportedName: sym.name,
          source: null,
          location: sym.location,
          languageMetadata: {},
        })
      );
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
 * C Language Parser Adapter.
 * Supports .c files using tree-sitter-c.
 */
class CAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "c-adapter",
      adapterVersion: "1.0.0",
      engine: "tree-sitter",
      engineVersion: "0.25.1",
      grammarVersion: "0.24.1",
      capabilities: [
        "symbols",
        "imports",
        "exports",
        "calls",
        "type_references",
      ],
    });
  }

  getSupportedLanguages() {
    return ["c"];
  }

  async parseFile(file, options = {}) {
    return parseCFile(this, file, options);
  }
}

module.exports = {
  CAdapter,
  parseCFile,
};
