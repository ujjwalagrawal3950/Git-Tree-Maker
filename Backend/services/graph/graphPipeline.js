/**
 * Cartograph Unified Graph Construction Pipeline.
 *
 * Coordinates resolver execution, evidence normalization, deterministic graph construction,
 * validation, and caching.
 *
 * Enforces:
 * - Strict repository and revision verification on every FileIR document.
 * - Rejection of mixed-commit FileIR documents.
 * - Server-side resolution across language ecosystems.
 * - Tenant-bound snapshot storage.
 */

const { AppError } = require("../../lib/errors");
const { GraphBuilder } = require("./GraphBuilder");
const { normalizeImportResolution, normalizeCallFact } = require("./evidenceNormalizer");
const { defaultStore } = require("./GraphSnapshotStore");

const { JavaScriptModuleResolver } = require("../parser/resolvers/javascript/JavaScriptModuleResolver");
const { PythonImportResolver } = require("../parser/resolvers/python/PythonImportResolver");
const { JavaImportResolver } = require("../parser/resolvers/java/JavaImportResolver");
const { CppIncludeResolver } = require("../parser/resolvers/c_cpp/CppIncludeResolver");

/**
 * Validates repository and revision consistency across all FileIR documents.
 *
 * @param {Array<object>} fileIRList
 * @param {string} repositoryId
 * @param {string} commitSha
 */
function validateFileIRConsistency(fileIRList, repositoryId, commitSha) {
  if (!Array.isArray(fileIRList)) {
    throw new AppError(400, "INVALID_FILE_IR_LIST", "fileIRList must be an array of FileIR documents");
  }

  for (const ir of fileIRList) {
    if (!ir || typeof ir !== "object") {
      throw new AppError(400, "MALFORMED_FILE_IR", "FileIR document must be an object");
    }

    const filePath = (ir.file && ir.file.path) || (ir.analysis && ir.analysis.file && ir.analysis.file.path) || "unknown";

    // 1. Commit SHA verification (reject mixed commits)
    const docCommitSha =
      (ir.analysis && ir.analysis.repository && ir.analysis.repository.commitSha) ||
      ir.commitSha ||
      (ir.repository && ir.repository.commitSha) ||
      null;

    if (docCommitSha && docCommitSha !== commitSha) {
      throw new AppError(
        400,
        "MIXED_COMMIT_FILE_IR",
        `FileIR document '${filePath}' has commit SHA '${docCommitSha}', which does not match requested revision '${commitSha}'. FileIR documents from mixed commits are rejected.`
      );
    }

    // 2. Repository identity verification
    const docRepo =
      (ir.analysis && ir.analysis.repository && ir.analysis.repository.fullName) ||
      (typeof ir.repository === "string" ? ir.repository : null) ||
      (ir.repository && ir.repository.fullName) ||
      null;

    if (docRepo && docRepo !== repositoryId) {
      throw new AppError(
        400,
        "REPOSITORY_MISMATCH",
        `FileIR document '${filePath}' belongs to repository '${docRepo}', which does not match target repository '${repositoryId}'.`
      );
    }
  }
}

/**
 * Builds, validates, and caches a unified dependency graph from FileIR documents.
 *
 * @param {object} params
 * @param {string} params.repositoryId - Repository identifier (e.g. "owner/repo" or id)
 * @param {string} params.commitSha - Git commit SHA
 * @param {Array<object>} params.fileIRList - Validated FileIR documents
 * @param {Array<object>} [params.normalizedEvidenceList] - Optional pre-normalized evidence records
 * @param {string} [params.organizationId] - Owning organization ID
 * @param {object} [options]
 * @param {GraphSnapshotStore} [options.store=defaultStore] - Store instance to use
 * @returns {Promise<{ snapshot: object, queryService: object, cacheKey: string }>}
 */
async function buildRepositoryGraph({
  repositoryId,
  commitSha,
  fileIRList = [],
  normalizedEvidenceList = null,
  organizationId = null,
}, options = {}) {
  const store = options.store || defaultStore;

  // Enforce repository identity and commit revision consistency (reject mixed commits)
  validateFileIRConsistency(fileIRList, repositoryId, commitSha);

  let evidenceList = normalizedEvidenceList;

  // If normalized evidence is not pre-supplied, extract and resolve across all supported languages
  if (!evidenceList || !Array.isArray(evidenceList)) {
    evidenceList = [];

    // Manifest paths for candidate resolution
    const manifestPaths = fileIRList
      .map((f) => {
        if (!f) return null;
        if (f.file && f.file.path) return f.file.path;
        if (f.analysis && f.analysis.file && f.analysis.file.path) return f.analysis.file.path;
        return null;
      })
      .filter(Boolean);

    // Instantiate resolver families
    const jsResolver = new JavaScriptModuleResolver({ manifest: manifestPaths });
    const pyResolver = new PythonImportResolver({ manifest: manifestPaths });
    const javaResolver = new JavaImportResolver({ manifest: manifestPaths });
    const cppResolver = new CppIncludeResolver({ manifest: manifestPaths });

    for (const fileIr of fileIRList) {
      const filePath = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
      if (!filePath) continue;

      const lang = (fileIr.file && fileIr.file.language) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.language);
      const imports = Array.isArray(fileIr.imports) ? fileIr.imports : [];
      const calls = Array.isArray(fileIr.calls) ? fileIr.calls : (Array.isArray(fileIr.callSites) ? fileIr.callSites : []);

      // 1. Resolve Imports / Includes
      for (const imp of imports) {
        const rawSource = imp.rawSource || imp.source || imp.specifier;
        if (!rawSource) continue;

        let res = null;
        let resolverName = "unknown";

        if (lang === "javascript" || lang === "typescript") {
          res = jsResolver.resolveSpecifier(filePath, rawSource);
          resolverName = "JavaScriptModuleResolver";
        } else if (lang === "python") {
          res = pyResolver.resolveImport(filePath, rawSource, imp.languageMetadata || {});
          resolverName = "PythonImportResolver";
        } else if (lang === "java") {
          res = javaResolver.resolveImport(filePath, rawSource, imp.languageMetadata || {});
          resolverName = "JavaImportResolver";
        } else if (lang === "c" || lang === "cpp" || lang === "c_cpp_header") {
          res = cppResolver.resolveInclude(filePath, rawSource, imp.languageMetadata || {});
          resolverName = "CppIncludeResolver";
        }

        if (res) {
          const normEv = normalizeImportResolution(
            {
              ...res,
              id: imp.id || `imp_${evidenceList.length}`,
              rawSource,
              evidence: {
                sourceFile: filePath,
                location: imp.location,
                resolverName,
                ...(imp.languageMetadata || {}),
              },
            },
            { resolverName, sourceFile: filePath }
          );
          evidenceList.push(normEv);
        }
      }

      // 2. Normalize Call Sites (without speculative resolution)
      for (const call of calls) {
        const normCall = normalizeCallFact(call, filePath);
        evidenceList.push(normCall);
      }
    }
  }

  // Build canonical snapshot
  const builder = new GraphBuilder({
    resolverVersions: options.resolverVersions,
  });

  const snapshot = builder.build({
    repositoryId,
    commitSha,
    fileIRList,
    normalizedEvidenceList: evidenceList,
  }, options);

  // Bind snapshot to organization context if provided
  if (organizationId) {
    snapshot.organizationId = organizationId;
    if (snapshot.repository) {
      snapshot.repository.organizationId = organizationId;
    }
  }

  // Validate and cache snapshot in bounded store
  const storeResult = store.put(snapshot, { organizationId });

  return storeResult;
}

module.exports = {
  buildRepositoryGraph,
  validateFileIRConsistency,
};
