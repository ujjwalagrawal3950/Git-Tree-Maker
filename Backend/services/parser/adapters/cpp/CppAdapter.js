const BaseAdapter = require("../BaseAdapter");
const { parseCppSource } = require("./parserFactory");
const { extractDirectives } = require("../c_cpp_shared/directiveExtractor");
const { extractCppDeclarations } = require("./declarationExtractor");
const { extractCppCallSites } = require("./callExtractor");
const { extractCppTypeFacts } = require("./typeExtractor");
const { buildFileIR, createFileId, createExport } = require("../../irBuilder");

/**
 * Parses C++ source text and builds a normalized FileIR document.
 *
 * @param {import('../BaseAdapter')} adapter
 * @param {object} file
 * @param {object} [options]
 * @returns {Promise<object>} Validated FileIR
 */
async function parseCppFile(adapter, file, options = {}) {
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
  const { tree, diagnostics, hasErrors } = parseCppSource(content, file.path);

  // 2. Syntax fact extraction
  const { imports, macroSymbols } = extractDirectives(tree.rootNode, fileId);
  const declSymbols = extractCppDeclarations(tree.rootNode, content, fileId);
  const symbols = [...declSymbols, ...macroSymbols];

  const callSites = extractCppCallSites(tree.rootNode, fileId, symbols);
  const { typeReferences, inheritance } = extractCppTypeFacts(tree.rootNode, fileId, symbols);

  // 3. Top-level and namespace public declarations are exportable
  const exports = [];
  let exportCounter = 0;
  for (const sym of symbols) {
    if (
      sym.isExported &&
      (sym.parentSymbolId === null || sym.kind === "class" || sym.kind === "struct" || sym.kind === "function") &&
      ["function", "class", "struct", "enum", "type_alias", "variable", "constant", "namespace"].includes(sym.kind)
    ) {
      exports.push(
        createExport({
          fileId,
          index: exportCounter++,
          kind: "named",
          symbolId: sym.id,
          exportedName: sym.qualifiedName || sym.name,
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
 * C++ Language Parser Adapter.
 * Supports .cpp, .cc, .cxx, .hpp, .hh, .hxx files using tree-sitter-cpp.
 */
class CppAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "cpp-adapter",
      adapterVersion: "1.0.0",
      engine: "tree-sitter",
      engineVersion: "0.25.1",
      grammarVersion: "0.23.4",
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
    return ["cpp"];
  }

  async parseFile(file, options = {}) {
    return parseCppFile(this, file, options);
  }
}

module.exports = {
  CppAdapter,
  parseCppFile,
};
