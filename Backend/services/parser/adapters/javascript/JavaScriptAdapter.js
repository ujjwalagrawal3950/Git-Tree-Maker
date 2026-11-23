const BaseAdapter = require("../BaseAdapter");
const { createSourceAST } = require("./parserFactory");
const { extractDeclarations } = require("./declarationExtractor");
const { extractImports } = require("./importExtractor");
const { extractExports } = require("./exportExtractor");
const { extractCallSites } = require("./callExtractor");
const { extractTypeFacts } = require("./typeExtractor");
const { extractHttpRequests } = require("./httpRequestExtractor");
const {
  extractExpressFacts,
  getExpressRouteFacts,
  expressFactStore,
} = require("./expressRouteExtractor");
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
  const httpRequests = extractHttpRequests(sourceFile, fileId, symbols);
  const expressFacts = extractExpressFacts(sourceFile, fileId, {
    symbols,
    filePath: file.path,
    repository,
    moduleResolver: options.moduleResolver,
  });

  const durationMs = Date.now() - startTime;
  const status = hasErrors ? "partial" : "complete";

  const fileIr = buildFileIR({
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

  // Attach HTTP request facts as a non-enumerable property:
  // 1. Keeps FileIR v1.0.0 JSON serialization completely pure and schema-compliant.
  // 2. Provides direct in-memory access for future resolver pipelines (Stage 2/3).
  Object.defineProperty(fileIr, "httpRequests", {
    value: httpRequests,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  // Attach Express route and router mount facts as non-enumerable properties:
  // 1. Keeps FileIR v1.0.0 JSON serialization completely pure and schema-compliant.
  // 2. Provides direct in-memory access for future resolver pipelines (Stage 2/3).
  // 3. Facts are also redundantly retained in expressFactStore by fileId for clone/serialization safety.
  Object.defineProperty(fileIr, "expressRoutes", {
    value: expressFacts.routes,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(fileIr, "expressMounts", {
    value: expressFacts.mounts,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return fileIr;
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

  extractHttpRequests(sourceFile, fileId, symbols = []) {
    return extractHttpRequests(sourceFile, fileId, symbols);
  }

  extractExpressFacts(sourceFile, fileId, options = {}) {
    return extractExpressFacts(sourceFile, fileId, options);
  }

  getExpressRouteFacts(fileIdOrIr) {
    return getExpressRouteFacts(fileIdOrIr);
  }
}

module.exports = {
  JavaScriptAdapter,
  parseJsTsFile,
  extractHttpRequests,
  extractExpressFacts,
  getExpressRouteFacts,
  expressFactStore,
};

