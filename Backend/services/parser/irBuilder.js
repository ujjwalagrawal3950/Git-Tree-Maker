/**
 * Cartograph Unified Intermediate Representation (FileIR) Builder.
 * Constructs normalized, schema-compliant FileIR documents matching IR_SCHEMA.json (v1.0.0).
 */

const IR_VERSION = "1.0.0";

/**
 * Creates a normalized source location range.
 * Coordinates follow Cartograph standard:
 * - Line is 1-based (minimum 1).
 * - Column is 0-based (minimum 0).
 * - End positions are exclusive.
 *
 * @param {number} startLine
 * @param {number} startColumn
 * @param {number} endLine
 * @param {number} endColumn
 * @returns {object}
 */
function createLocation(startLine, startColumn, endLine, endColumn) {
  return {
    start: {
      line: Math.max(1, parseInt(startLine, 10) || 1),
      column: Math.max(0, parseInt(startColumn, 10) || 0),
    },
    end: {
      line: Math.max(1, parseInt(endLine, 10) || startLine || 1),
      column: Math.max(0, parseInt(endColumn, 10) || 0),
    },
  };
}

/**
 * Builds a deterministic file ID from repository and relative path.
 *
 * @param {string} repository - e.g. "owner/repo"
 * @param {string} path - e.g. "src/index.ts"
 * @returns {string}
 */
function createFileId(repository, path) {
  const cleanRepo = (repository || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanPath = (path || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `file_${cleanRepo}_${cleanPath}`;
}

/**
 * Counts total lines in source code.
 *
 * @param {string} content
 * @returns {number}
 */
function countLines(content) {
  if (!content || typeof content !== "string") return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++; // '\n'
  }
  return count;
}

/**
 * Constructs a schema-compliant Diagnostic object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {"info"|"warning"|"error"} [params.severity]
 * @param {string} params.message
 * @param {object|null} [params.location]
 * @returns {object}
 */
function createDiagnostic({ code, severity = "info", message, location = null }) {
  return {
    code: String(code || "DIAGNOSTIC"),
    severity: ["info", "warning", "error"].includes(severity) ? severity : "info",
    message: String(message || ""),
    location: location ? { ...location } : null,
  };
}

/**
 * Deterministic Symbol ID Limitation:
 * Symbol IDs follow the format `${fileId}#sym_${index}` (zero-based index).
 * This is deterministic only when fileId and AST declaration traversal order are deterministic.
 * Modifying or prepending declarations earlier in a file will shift subsequent indices.
 * Symbol IDs are scoped strictly to immutable file and repository commit revisions;
 * they do not guarantee cross-revision stability across arbitrary source edits.
 *
 * @param {object} params
 * @returns {object}
 */
function createSymbol({
  fileId,
  index = 0,
  id,
  name,
  qualifiedName = null,
  kind = "unknown",
  languageKind = null,
  parentSymbolId = null,
  location,
  nameLocation = null,
  signature = null,
  parameters = [],
  returnType = null,
  typeParameters = [],
  modifiers = [],
  visibility = "public",
  isExported = false,
  documentation = null,
  languageMetadata = {},
}) {
  const symbolId = id || (fileId ? `${fileId}#sym_${index}` : `sym_${index}`);
  return {
    id: symbolId,
    name: String(name || "unknown"),
    qualifiedName,
    kind,
    languageKind,
    parentSymbolId,
    location,
    nameLocation,
    signature,
    parameters,
    returnType,
    typeParameters,
    modifiers,
    visibility,
    isExported,
    ...(documentation !== null ? { documentation } : {}),
    languageMetadata,
  };
}

/**
 * Constructs a schema-compliant Import object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @returns {object}
 */
function createImport({
  fileId,
  index = 0,
  id,
  kind = "module_import",
  rawSource = null,
  sourceKind = "unknown",
  specifiers = [],
  location,
  languageMetadata = {},
}) {
  const importId = id || (fileId ? `${fileId}#import_${index}` : `import_${index}`);
  return {
    id: importId,
    kind,
    rawSource,
    sourceKind,
    specifiers,
    location,
    languageMetadata,
  };
}

/**
 * Constructs a schema-compliant Export object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @returns {object}
 */
function createExport({
  fileId,
  index = 0,
  id,
  kind = "named",
  symbolId = null,
  exportedName = null,
  source = null,
  location,
  languageMetadata = {},
}) {
  const exportId = id || (fileId ? `${fileId}#export_${index}` : `export_${index}`);
  return {
    id: exportId,
    kind,
    symbolId,
    exportedName,
    source,
    location,
    languageMetadata,
  };
}

/**
 * Constructs a schema-compliant CallSite object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @returns {object}
 */
function createCallSite({
  fileId,
  index = 0,
  id,
  calleeText,
  calleeKind = "identifier",
  enclosingSymbolId = null,
  argumentCount = 0,
  location,
  resolution = { status: "not_attempted", targetSymbolId: null },
}) {
  const callId = id || (fileId ? `${fileId}#call_${index}` : `call_${index}`);
  return {
    id: callId,
    calleeText: String(calleeText || "unknown"),
    calleeKind,
    enclosingSymbolId,
    argumentCount: typeof argumentCount === "number" ? Math.max(0, argumentCount) : null,
    location,
    resolution,
  };
}

/**
 * Constructs a schema-compliant TypeReference object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @returns {object}
 */
function createTypeReference({
  fileId,
  index = 0,
  id,
  text,
  context = "other",
  enclosingSymbolId = null,
  location,
  resolution = { status: "not_attempted", targetSymbolId: null },
}) {
  const refId = id || (fileId ? `${fileId}#typeref_${index}` : `typeref_${index}`);
  return {
    id: refId,
    text: String(text || "unknown"),
    context,
    enclosingSymbolId,
    location,
    resolution,
  };
}

/**
 * Constructs a schema-compliant Inheritance object matching IR_SCHEMA.json.
 *
 * @param {object} params
 * @returns {object}
 */
function createInheritance({
  fileId,
  index = 0,
  id,
  kind = "extends",
  targetText,
  sourceSymbolId = null,
  location,
}) {
  const inhId = id || (fileId ? `${fileId}#inh_${index}` : `inh_${index}`);
  return {
    id: inhId,
    kind,
    targetText: String(targetText || "unknown"),
    sourceSymbolId,
    location,
  };
}

/**
 * Builds a schema-compliant FileIR document.
 *
 * @param {object} params
 * @param {object} params.repository - { owner, name, fullName, commitSha, provider? }
 * @param {object} params.file - { path, blobSha, language, category?, sizeBytes?, content? }
 * @param {object} params.parser - { adapterId, adapterVersion, engine, engineVersion, grammarVersion?, status, capabilities?, durationMs? }
 * @param {Array<object>} [params.symbols]
 * @param {Array<object>} [params.imports]
 * @param {Array<object>} [params.exports]
 * @param {Array<object>} [params.occurrences]
 * @param {Array<object>} [params.callSites]
 * @param {Array<object>} [params.typeReferences]
 * @param {Array<object>} [params.inheritance]
 * @param {Array<object>} [params.diagnostics]
 * @param {object} [params.stats]
 * @returns {object} Normalized FileIR object matching IR_SCHEMA.json
 */
function buildFileIR({
  repository,
  file,
  parser,
  symbols = [],
  imports = [],
  exports = [],
  occurrences = [],
  callSites = [],
  typeReferences = [],
  inheritance = [],
  diagnostics = [],
  stats,
}) {
  const repoOwner = repository.owner || (repository.fullName ? repository.fullName.split("/")[0] : "unknown");
  const repoName = repository.name || (repository.fullName ? repository.fullName.split("/")[1] : "unknown");
  const repoFullName = repository.fullName || `${repoOwner}/${repoName}`;
  const commitSha = repository.commitSha || "0000000000000000000000000000000000000000";

  const fileId = file.fileId || createFileId(repoFullName, file.path);
  const sizeBytes = typeof file.sizeBytes === "number" ? file.sizeBytes : (file.content ? Buffer.byteLength(file.content, "utf8") : 0);
  const linesCount = typeof file.linesOfCode === "number" ? file.linesOfCode : (file.content ? countLines(file.content) : 0);

  const calculatedStats = stats || {
    lines: linesCount,
    symbols: symbols.length,
    imports: imports.length,
    exports: exports.length,
    occurrences: occurrences.length,
    callSites: callSites.length,
    typeReferences: typeReferences.length,
  };

  return {
    irVersion: IR_VERSION,
    analysis: {
      repository: {
        provider: "github",
        owner: repoOwner,
        name: repoName,
        fullName: repoFullName,
        commitSha,
      },
      file: {
        fileId,
        path: file.path,
        blobSha: file.blobSha || "0000000000000000000000000000000000000000",
        language: file.language || "unknown",
        category: file.category || "source",
        sizeBytes,
      },
    },
    parser: {
      adapterId: parser.adapterId || "unknown-adapter",
      adapterVersion: parser.adapterVersion || "1.0.0",
      engine: parser.engine || "generic",
      engineVersion: parser.engineVersion || "1.0.0",
      grammarVersion: parser.grammarVersion || null,
      status: parser.status || "complete",
      capabilities: Array.isArray(parser.capabilities) ? parser.capabilities : ["symbols", "imports", "exports"],
      durationMs: typeof parser.durationMs === "number" ? Math.max(0, parser.durationMs) : 0,
    },
    symbols,
    imports,
    exports,
    occurrences,
    callSites,
    typeReferences,
    inheritance,
    diagnostics,
    stats: calculatedStats,
  };
}

module.exports = {
  IR_VERSION,
  createLocation,
  createFileId,
  countLines,
  buildFileIR,
  createFileIR: buildFileIR,
  createDiagnostic,
  createSymbol,
  createImport,
  createExport,
  createCallSite,
  createTypeReference,
  createInheritance,
};

