const BaseAdapter = require("../BaseAdapter");
const { createSourceAST } = require("./parserFactory");
const { extractDeclarations } = require("./declarationExtractor");
const { extractImports } = require("./importExtractor");
const { extractExports } = require("./exportExtractor");
const { extractCallSites } = require("./callExtractor");
const { extractTypeFacts } = require("./typeExtractor");
const { buildFileIR, createFileId } = require("../../irBuilder");

/**
 * Common parse execution for JavaScript and TypeScript source files.
 *
 * @param {import('../BaseAdapter')} adapter
 * @param {object} file
 * @param {object} [options]
 * @returns {Promise<object>} Validated FileIR
 */
async function parseJsTsFile(adapter, file, options = {}) {
  const startTime = Date.now();
  const repository = file.repository || options.repository || {
    owner: "unknown",
    name: "unknown",
    fullName: "unknown/unknown",
    commitSha: "0000000000000000000000000000000000000000",
  };

  const fileId = file.fileId || createFileId(repository.fullName, file.path);
  const content = typeof file.content === "string" ? file.content : "";

  // 1. AST creation and parse diagnostics capture
  const { sourceFile, diagnostics, hasErrors } = createSourceAST(file.path, content);

  // 2. Syntax fact extraction
  const symbols = extractDeclarations(sourceFile, fileId);
  const imports = extractImports(sourceFile, fileId);
  const exports = extractExports(sourceFile, fileId, symbols);
  const callSites = extractCallSites(sourceFile, fileId, symbols);
  const { typeReferences, inheritance } = extractTypeFacts(sourceFile, fileId, symbols);

  const durationMs = Date.now() - startTime;
  const status = hasErrors ? "partial" : "complete";

  return buildFileIR({
    repository,
    file: {
      fileId,
      path: file.path,
      blobSha: file.blobSha || "0000000000000000000000000000000000000000",
      language: file.language || (adapter.getSupportedLanguages()[0]),
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
 * JavaScript Language Parser Adapter.
 * Supports .js, .jsx, .mjs, and .cjs files.
 */
class JavaScriptAdapter extends BaseAdapter {
  constructor() {
    super({
      adapterId: "javascript-adapter",
      adapterVersion: "1.0.0",
      engine: "typescript",
      engineVersion: "5.9.3",
      grammarVersion: null,
      capabilities: ["symbols", "imports", "exports", "calls", "type_references", "inheritance"],
    });
  }

  getSupportedLanguages() {
    return ["javascript"];
  }

  async parseFile(file, options = {}) {
    return parseJsTsFile(this, file, options);
  }
}

module.exports = {
  JavaScriptAdapter,
  parseJsTsFile,
};

