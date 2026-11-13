/**
 * Cartograph Unified Dependency Graph - Canonical Identities and Edge Semantics.
 *
 * Defines deterministic, collision-resistant identities for files, symbols, external packages,
 * edges, snapshots, and cache keys across language ecosystems and repository revisions.
 *
 * Scoped strictly to immutable repository IDs, commit SHAs, and FileIR v1.0.0 semantics.
 */

const GRAPH_BUILDER_VERSION = "1.0.0";
const FILE_IR_VERSION = "1.0.0";

/**
 * Canonical Edge Semantics Documentation and Constants.
 *
 * Distinctions between structural containment, member containment, and definition:
 *
 * - CONTAINS ("contains"):
 *   Represents lexical top-level containment where a file structurally encloses a top-level
 *   declaration (File -> Symbol). Represents file-level ownership.
 *
 * - MEMBER_OF ("member_of"):
 *   Represents member-level lexical or logical containment where a declaration is owned by
 *   an enclosing symbol (e.g., Method -> Class, Field -> Struct, Function -> Namespace,
 *   InnerClass -> OuterClass).
 *
 * - DEFINES ("defines"):
 *   Represents concrete definition or implementation relationship (File -> Symbol).
 *   Crucial for languages like C, C++, and TypeScript where a declaration (e.g. forward
 *   declaration in a header file or .d.ts) is distinct from its concrete implementation body
 *   (e.g. function body in a .c/.cpp file).
 */
const EDGE_SEMANTICS = Object.freeze({
  CONTAINS: "contains",
  MEMBER_OF: "member_of",
  DEFINES: "defines",
  IMPORTS: "imports",
  CALLS: "calls",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
});

const EDGE_SEMANTICS_DESCRIPTIONS = Object.freeze({
  [EDGE_SEMANTICS.CONTAINS]: "File structurally encloses a top-level symbol declaration",
  [EDGE_SEMANTICS.MEMBER_OF]: "Enclosing parent symbol owns a member symbol (e.g. class contains method/field)",
  [EDGE_SEMANTICS.DEFINES]: "File provides concrete implementation or definition body for a symbol",
  [EDGE_SEMANTICS.IMPORTS]: "Source file or module depends on target file or external module",
  [EDGE_SEMANTICS.CALLS]: "Source function/method invokes target function/method (call site)",
  [EDGE_SEMANTICS.EXTENDS]: "Source class or interface inherits from target class or interface",
  [EDGE_SEMANTICS.IMPLEMENTS]: "Source class implements target interface",
});

/**
 * Normalizes repository relative file paths to POSIX format.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeRelativePath(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Creates a canonical, revision-scoped File Node ID.
 *
 * Format: `${repositoryId}@${commitSha}:${filePath}`
 * Example: "octocat/Hello-World@7fd1a60b01f91b314f59955a4e4d4e80d8edf11d:src/index.ts"
 *
 * @param {string} repository - Repository full name or unique ID (e.g. "owner/repo")
 * @param {string} commitSha - Full 40-character Git commit SHA
 * @param {string} filePath - Repository-relative file path
 * @returns {string}
 */
function createFileNodeId(repository, commitSha, filePath) {
  const repo = repository || "unknown_repo";
  const sha = commitSha || "HEAD";
  const path = normalizeRelativePath(filePath);
  return `${repo}@${sha}:${path}`;
}

/**
 * Formats parameter signature into a deterministic string.
 *
 * @param {Array<object|string>} parameters
 * @returns {string}
 */
function formatParameterSignature(parameters) {
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return "";
  }

  const types = parameters.map((p) => {
    if (typeof p === "string") return p;
    if (p && typeof p === "object") {
      return p.type || p.dataType || p.name || "unknown";
    }
    return "unknown";
  });

  return types.join(",");
}

/**
 * Creates a canonical, revision-scoped Symbol Node ID.
 *
 * Disambiguation strategy:
 * 1. If FileIR symbol has a reliable ID (e.g. "sym_0"), it is scoped to the fileNodeId:
 *    `${fileNodeId}#${symLocalId}`.
 * 2. If options.preferDeterministicCoordinates is true or symbol lacks an ID:
 *    Deterministic identity incorporates:
 *    - symbol.kind (e.g. "function", "class", "method")
 *    - qualifiedName or name (e.g. "Math::Vector::add")
 *    - parameter types / signature (to disambiguate overloaded functions in C++, Java, etc.)
 *    - source location coordinates (start line and start column to disambiguate same-named
 *      declarations, nested scopes, or identical signatures)
 *
 * Format with coordinates:
 * `${fileNodeId}#${kind}:${qualifiedName || name}(${paramSig}):${startLine}_${startCol}`
 *
 * @param {string} fileNodeId - Canonical File Node ID
 * @param {object} symbol - FileIR Symbol object
 * @param {object} [options]
 * @param {boolean} [options.preferDeterministicCoordinates=false]
 * @returns {string}
 */
function createSymbolNodeId(fileNodeId, symbol, options = {}) {
  if (!fileNodeId) {
    throw new Error("createSymbolNodeId requires a valid fileNodeId");
  }
  if (!symbol || typeof symbol !== "object") {
    throw new Error("createSymbolNodeId requires a valid symbol object");
  }

  const preferDeterministic = options.preferDeterministicCoordinates === true;

  // If FileIR symbol has an ID and deterministic coordinates are not explicitly requested:
  if (symbol.id && !preferDeterministic) {
    const rawId = String(symbol.id);
    const localId = rawId.includes("#") ? rawId.split("#").pop() : rawId;
    return `${fileNodeId}#${localId}`;
  }

  // Construct deterministic identity with signature and coordinates disambiguation
  const kind = symbol.kind || "unknown";
  const name = symbol.qualifiedName || symbol.name || "anonymous";

  let paramSig = "";
  if (symbol.parameters && Array.isArray(symbol.parameters)) {
    paramSig = `(${formatParameterSignature(symbol.parameters)})`;
  } else if (typeof symbol.signature === "string" && symbol.signature.includes("(")) {
    const match = symbol.signature.match(/\((.*?)\)/);
    paramSig = match ? `(${match[1]})` : "()";
  }

  const startLine = symbol.location && symbol.location.start ? symbol.location.start.line : 1;
  const startCol = symbol.location && symbol.location.start ? symbol.location.start.column : 0;

  return `${fileNodeId}#${kind}:${name}${paramSig}:${startLine}_${startCol}`;
}

/**
 * Creates an External Node ID for third-party packages or runtime builtins.
 *
 * Format:
 * - Packages: `external:${ecosystem}:${packageName}` or `external:${ecosystem}:${packageName}@${version}`
 * - Builtins: `builtin:${ecosystem}:${moduleName}`
 *
 * @param {string} ecosystem - e.g. "npm", "pypi", "maven", "c_cpp", "system"
 * @param {string} name - Package or module name
 * @param {object} [options]
 * @param {string} [options.version]
 * @param {boolean} [options.isBuiltin=false]
 * @returns {string}
 */
function createExternalNodeId(ecosystem, name, options = {}) {
  const eco = (ecosystem || "generic").toLowerCase();
  const cleanName = (name || "unknown").trim();
  if (options.isBuiltin) {
    return `builtin:${eco}:${cleanName}`;
  }
  const ver = options.version ? `@${options.version}` : "";
  return `external:${eco}:${cleanName}${ver}`;
}

/**
 * Creates a deterministic Edge ID between two graph nodes.
 *
 * Format: `${sourceNodeId} -[${edgeType}${qualifier ? `:${qualifier}` : ""}]-> ${targetNodeId}`
 *
 * @param {string} sourceNodeId
 * @param {string} edgeType - One of EDGE_SEMANTICS
 * @param {string} targetNodeId
 * @param {string|null} [semanticQualifier=null] - Optional disambiguator (e.g. member name, call line)
 * @returns {string}
 */
function createEdgeId(sourceNodeId, edgeType, targetNodeId, semanticQualifier = null) {
  if (!sourceNodeId || !edgeType || !targetNodeId) {
    throw new Error("createEdgeId requires sourceNodeId, edgeType, and targetNodeId");
  }
  const qualifier = semanticQualifier ? `:${semanticQualifier}` : "";
  return `${sourceNodeId} -[${edgeType}${qualifier}]-> ${targetNodeId}`;
}

/**
 * Computes a deterministic resolver fingerprint across all active parser & resolver families.
 *
 * Format: `ir_${fileIrVersion}_bld_${builderVersion}_js_${jsVer}_py_${pyVer}_java_${javaVer}_cpp_${cppVer}`
 *
 * @param {object} [resolverVersions]
 * @param {string} [resolverVersions.js="1.0.0"]
 * @param {string} [resolverVersions.python="1.0.0"]
 * @param {string} [resolverVersions.java="1.0.0"]
 * @param {string} [resolverVersions.cpp="1.0.0"]
 * @returns {string}
 */
function computeResolverFingerprint(resolverVersions = {}) {
  const jsVer = resolverVersions.js || "1.0.0";
  const pyVer = resolverVersions.python || "1.0.0";
  const javaVer = resolverVersions.java || "1.0.0";
  const cppVer = resolverVersions.cpp || "1.0.0";

  return `ir_${FILE_IR_VERSION}_bld_${GRAPH_BUILDER_VERSION}_js_${jsVer}_py_${pyVer}_java_${javaVer}_cpp_${cppVer}`;
}

/**
 * Creates a unique Graph Snapshot ID.
 *
 * @param {object} params
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {string} [params.builderVersion=GRAPH_BUILDER_VERSION]
 * @param {string} [params.fileIrVersion=FILE_IR_VERSION]
 * @param {string} [params.resolverFingerprint]
 * @returns {string}
 */
function createGraphSnapshotId({
  repositoryId,
  commitSha,
  builderVersion = GRAPH_BUILDER_VERSION,
  fileIrVersion = FILE_IR_VERSION,
  resolverFingerprint = null,
}) {
  if (!repositoryId || !commitSha) {
    throw new Error("createGraphSnapshotId requires repositoryId and commitSha");
  }

  const cleanRepo = String(repositoryId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const fingerprint = resolverFingerprint || computeResolverFingerprint();
  return `graph_snapshot_${cleanRepo}_${commitSha}_bld_${builderVersion}_ir_${fileIrVersion}_${fingerprint}`;
}

/**
 * Computes the 5-dimensional deterministic Graph Cache Key.
 *
 * Accounts for:
 * 1. repository ID
 * 2. full commit SHA
 * 3. graph builder version
 * 4. FileIR version
 * 5. parser/resolver version fingerprint
 *
 * Format:
 * `cartograph:graph:${repositoryId}:${commitSha}:bld_${builderVersion}:ir_${fileIrVersion}:rf_${resolverFingerprint}`
 *
 * @param {object} params
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {string} [params.builderVersion=GRAPH_BUILDER_VERSION]
 * @param {string} [params.fileIrVersion=FILE_IR_VERSION]
 * @param {string} [params.resolverFingerprint]
 * @returns {string}
 */
function computeGraphCacheKey({
  repositoryId,
  commitSha,
  builderVersion = GRAPH_BUILDER_VERSION,
  fileIrVersion = FILE_IR_VERSION,
  resolverFingerprint = null,
}) {
  if (!repositoryId || !commitSha) {
    throw new Error("computeGraphCacheKey requires repositoryId and commitSha");
  }

  const fingerprint = resolverFingerprint || computeResolverFingerprint();
  return `cartograph:graph:${repositoryId}:${commitSha}:bld_${builderVersion}:ir_${fileIrVersion}:rf_${fingerprint}`;
}

module.exports = {
  GRAPH_BUILDER_VERSION,
  FILE_IR_VERSION,
  EDGE_SEMANTICS,
  EDGE_SEMANTICS_DESCRIPTIONS,
  normalizeRelativePath,
  createFileNodeId,
  createSymbolNodeId,
  createExternalNodeId,
  createEdgeId,
  computeResolverFingerprint,
  createGraphSnapshotId,
  computeGraphCacheKey,
};

