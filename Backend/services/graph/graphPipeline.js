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
const {
  normalizeImportResolution,
  normalizeCallFact,
  normalizeHttpResolution,
} = require("./evidenceNormalizer");
const { defaultStore } = require("./GraphSnapshotStore");

const { JavaScriptModuleResolver } = require("../parser/resolvers/javascript/JavaScriptModuleResolver");
const { PythonImportResolver } = require("../parser/resolvers/python/PythonImportResolver");
const { JavaImportResolver } = require("../parser/resolvers/java/JavaImportResolver");
const { CppIncludeResolver } = require("../parser/resolvers/c_cpp/CppIncludeResolver");
const { HttpRouteResolver } = require("../parser/resolvers/HttpRouteResolver");
const { expressFactStore } = require("../parser/adapters/javascript/expressRouteExtractor");
const { createFileId } = require("../parser/irBuilder");

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

    // Extract supporting config files (e.g. tsconfig.json, pom.xml) from fileIRList or options
    const supportingFiles = { ...(options.supportingFiles || {}) };
    for (const f of fileIRList) {
      const p = (f.file && f.file.path) || (f.analysis && f.analysis.file && f.analysis.file.path) || "";
      const content = (f.file && f.file.content) || (f.analysis && f.analysis.file && f.analysis.file.content);
      if (content && typeof content === "string") {
        const base = p.split("/").pop();
        if (base && !supportingFiles[base]) {
          supportingFiles[base] = content;
        }
      }
    }

    // Manifest paths for candidate resolution (use full manifest if supplied, otherwise fileIR paths)
    let manifestPaths = null;
    if (options.manifest) {
      const m = Array.isArray(options.manifest.files) ? options.manifest.files : options.manifest;
      manifestPaths = Array.isArray(m) ? m.map((x) => (typeof x === "string" ? x : x.path)).filter(Boolean) : null;
    }
    if (!manifestPaths || manifestPaths.length === 0) {
      manifestPaths = fileIRList
        .map((f) => {
          if (!f) return null;
          if (f.file && f.file.path) return f.file.path;
          if (f.analysis && f.analysis.file && f.analysis.file.path) return f.analysis.file.path;
          return null;
        })
        .filter(Boolean);
    }

    // Instantiate resolver families with supporting configuration
    const jsResolver = new JavaScriptModuleResolver({ manifest: manifestPaths, supportingFiles });
    const pyResolver = new PythonImportResolver({ manifest: manifestPaths, supportingFiles });
    const javaResolver = new JavaImportResolver({ manifest: manifestPaths, supportingFiles });
    const cppResolver = new CppIncludeResolver({ manifest: manifestPaths, supportingFiles });

    for (const fileIr of fileIRList) {
      const filePath = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
      if (!filePath) continue;

      const lang = (fileIr.file && fileIr.file.language) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.language);
      const imports = Array.isArray(fileIr.imports) ? fileIr.imports : [];
      const exports = Array.isArray(fileIr.exports) ? fileIr.exports : (fileIr.analysis && Array.isArray(fileIr.analysis.exports) ? fileIr.analysis.exports : []);
      const calls = Array.isArray(fileIr.calls) ? fileIr.calls : (Array.isArray(fileIr.callSites) ? fileIr.callSites : []);
      const typeReferences = fileIr.typeReferences || (fileIr.analysis && fileIr.analysis.typeReferences) || [];

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
          res = javaResolver.resolveImport(filePath, rawSource, {
            ...(imp.languageMetadata || {}),
            typeReferences,
          });
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

      // 2. Resolve Re-exports (exports with a source module specifier)
      for (const exp of exports) {
        const rawSource = exp.source || exp.rawSource;
        if (!rawSource || typeof rawSource !== "string") continue;

        let res = null;
        let resolverName = "unknown";

        if (lang === "javascript" || lang === "typescript") {
          res = jsResolver.resolveSpecifier(filePath, rawSource);
          resolverName = "JavaScriptModuleResolver";
        }

        if (res) {
          const normEv = normalizeImportResolution(
            {
              ...res,
              id: exp.id || `reexp_${evidenceList.length}`,
              rawSource,
              evidence: {
                sourceFile: filePath,
                location: exp.location,
                resolverName,
                isReexport: true,
                exportedName: exp.exportedName || "*",
                ...(exp.languageMetadata || {}),
              },
            },
            { resolverName, sourceFile: filePath }
          );
          evidenceList.push(normEv);
        }
      }

      // 3. Normalize Call Sites (without speculative resolution)
      for (const call of calls) {
        const normCall = normalizeCallFact(call, filePath);
        evidenceList.push(normCall);
      }
    }

    // 4. Resolve HTTP Routes (Stage 4 Dynamic API Route Extraction)
    const clientRequests = [];
    const backendRoutes = [];
    const backendMounts = [];

    // Build reliable lookup structures connecting FileIR identifiers to repository-relative file paths
    const fileIdToPathMap = new Map();
    const pathToIdMap = new Map();

    for (const fileIr of fileIRList) {
      const p = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
      const fid =
        (fileIr.file && (fileIr.file.fileId || fileIr.file.id)) ||
        (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.fileId) ||
        fileIr.fileId ||
        fileIr.id ||
        (p ? createFileId(repositoryId, p) : null);

      if (p && fid) {
        fileIdToPathMap.set(fid, p);
        pathToIdMap.set(p, fid);
        fileIdToPathMap.set(p, p);
      }
    }

    if (Array.isArray(manifestPaths)) {
      for (const p of manifestPaths) {
        if (p && !pathToIdMap.has(p)) {
          const fid = createFileId(repositoryId, p);
          pathToIdMap.set(p, fid);
          fileIdToPathMap.set(fid, p);
        }
      }
    }

    for (const fileIr of fileIRList) {
      const rawPath = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
      const filePath = rawPath && typeof rawPath === "string" ? rawPath.replace(/\\/g, "/") : rawPath;
      const fileId =
        (fileIr.file && (fileIr.file.fileId || fileIr.file.id)) ||
        (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.fileId) ||
        fileIr.fileId ||
        fileIr.id ||
        (filePath ? pathToIdMap.get(filePath) : null);

      const httpReqs = fileIr.httpRequests || (fileIr.analysis && fileIr.analysis.httpRequests);
      if (Array.isArray(httpReqs)) {
        clientRequests.push(...httpReqs);
      }

      const expRoutes =
        fileIr.expressRoutes ||
        (fileIr.analysis && fileIr.analysis.expressRoutes) ||
        (fileId ? expressFactStore.getFacts(fileId)?.routes : null) ||
        (filePath ? expressFactStore.getFacts(filePath)?.routes : null);
      if (Array.isArray(expRoutes)) {
        backendRoutes.push(...expRoutes);
      }

      const expMounts =
        fileIr.expressMounts ||
        (fileIr.analysis && fileIr.analysis.expressMounts) ||
        (fileId ? expressFactStore.getFacts(fileId)?.mounts : null) ||
        (filePath ? expressFactStore.getFacts(filePath)?.mounts : null);
      if (Array.isArray(expMounts)) {
        for (const m of expMounts) {
          const mCopy = { ...m };
          // If importedModuleSpecifier is present and importedFileId is not yet resolved,
          // resolve the target module using the authoritative JavaScriptModuleResolver.
          if (!mCopy.importedFileId && mCopy.importedModuleSpecifier && filePath) {
            const res = jsResolver.resolveSpecifier(filePath, mCopy.importedModuleSpecifier);
            if (res && res.status === "internal_resolved" && res.resolvedPath) {
              const targetId = pathToIdMap.get(res.resolvedPath) || createFileId(repositoryId, res.resolvedPath);
              mCopy.importedFileId = targetId;
              mCopy.resolutionStatus = "resolved";
              mCopy.resolvedPath = res.resolvedPath;
            } else if (res && res.status === "ambiguous") {
              mCopy.importedFileId = null;
              mCopy.resolutionStatus = "ambiguous";
              mCopy.candidates = Array.isArray(res.candidates) ? [...res.candidates] : null;
            } else {
              mCopy.importedFileId = null;
              mCopy.resolutionStatus = (res && res.status) || "unresolved";
            }
          }
          backendMounts.push(mCopy);
        }
      }
    }

    if (clientRequests.length > 0) {
      const httpResolver = new HttpRouteResolver();
      const httpResolutionResult = httpResolver.resolve({
        clientRequests,
        backendRoutes,
        backendMounts,
      });

      for (const res of httpResolutionResult.resolutions) {
        const normEv = normalizeHttpResolution(res, {
          fileIdToPathMap,
          sourceFile: fileIdToPathMap.get(res.clientFileId) || res.clientFileId,
          targetFile: fileIdToPathMap.get(res.backendFileId) || res.backendFileId,
        });
        evidenceList.push(normEv);
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
    manifest: options.manifest || null,
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
