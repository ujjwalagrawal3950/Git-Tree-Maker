const BaseAdapter = require("../BaseAdapter");
const { parseJavaSource } = require("./parserFactory");
const { extractJavaDeclarations } = require("./declarationExtractor");
const { extractJavaImports } = require("./importExtractor");
const { extractJavaCallSites } = require("./callExtractor");
const { extractJavaTypeFacts } = require("./typeExtractor");
const { buildFileIR, createFileId, createExport } = require("../../irBuilder");

/**
 * Parses Java source text and builds a normalized FileIR document.
 *
 * @param {import('../BaseAdapter')} adapter
 * @param {object} file
 * @param {object} [options]
 * @returns {Promise<object>} Validated FileIR
 */
async function parseJavaFile(adapter, file, options = {}) {
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
  const { tree, diagnostics, hasErrors } = parseJavaSource(content, file.path);

  // 2. Syntax fact extraction
  const { packageName, symbols } = extractJavaDeclarations(tree.rootNode, content, fileId);
  const imports = extractJavaImports(tree.rootNode, fileId, packageName);
  const callSites = extractJavaCallSites(tree.rootNode, fileId, symbols);
  const { typeReferences, inheritance } = extractJavaTypeFacts(tree.rootNode, fileId, symbols);
  const exports = [];

  // Top-level public declarations are exportable in Java
  let exportCounter = 0;
  for (const sym of symbols) {
    if (sym.parentSymbolId === null && sym.isExported && ["class", "interface", "enum"].includes(sym.kind)) {
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
            packageName,
          },
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
 * Java Language Parser Adapter.
 * Supports .java files using tree-sitter-java.
 */
class JavaAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "java-adapter",
      adapterVersion: "1.0.0",
      engine: "tree-sitter",
      engineVersion: "0.25.1",
      grammarVersion: "0.23.5",
      capabilities: [
        "symbols",
        "imports",
        "calls",
        "type_references",
        "inheritance",
      ],
    });
  }

  getSupportedLanguages() {
    return ["java"];
  }

  async parseFile(file, options = {}) {
    return parseJavaFile(this, file, options);
  }
}

module.exports = {
  JavaAdapter,
  parseJavaFile,
};

