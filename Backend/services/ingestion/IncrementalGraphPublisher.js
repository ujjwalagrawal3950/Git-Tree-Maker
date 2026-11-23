/**
 * Cartograph Incremental Dependency Resolution & Versioned Graph Publication Service (Gate 11E).
 *
 * Implements:
 * - Incremental cross-batch dependency resolution across accumulated repository state (Batches 1..B).
 * - Preservation of existing language resolvers (JavaScript, Python, Java, C/C++).
 * - Automatic re-resolution of previously unconfirmed/unresolved imports as target files arrive.
 * - Deterministic GraphBuilder & GraphValidator execution with canonical node & edge identity stability.
 * - Monotonic snapshot versioning scoped to (repositoryId, commitSha, jobId).
 * - Immutable content-addressed snapshot persistence in Supabase Storage bucket 'graph-snapshots'.
 * - Atomic Stage 2 PostgreSQL commit guarded by fencing token, worker ownership, and active lease.
 * - In-memory GraphSnapshotStore registration and GraphQueryService indexing.
 * - Safe orphan artifact handling (no synchronous deletion on lease expiration or rejected commit).
 * - Distinct handling for Small (1 continuous run), Medium (progressive multi-batch), and Large repositories.
 * - Strict separation of ingestion and exploration: GraphQueryService operations never trigger downloads or ingestion.
 */

const crypto = require("node:crypto");
const { AppError } = require("../../lib/errors");
const { validateFileIRConsistency } = require("../graph/graphPipeline");
const { normalizeImportResolution, normalizeCallFact } = require("../graph/evidenceNormalizer");
const { GraphBuilder } = require("../graph/GraphBuilder");
const { GraphValidator } = require("../graph/GraphValidator");
const { defaultStore } = require("../graph/GraphSnapshotStore");
const { defaultJobManager } = require("./IngestionJobManager");

const { JavaScriptModuleResolver } = require("../parser/resolvers/javascript/JavaScriptModuleResolver");
const { PythonImportResolver } = require("../parser/resolvers/python/PythonImportResolver");
const { JavaImportResolver } = require("../parser/resolvers/java/JavaImportResolver");
const { CppIncludeResolver } = require("../parser/resolvers/c_cpp/CppIncludeResolver");
const { HttpRouteResolver } = require("../parser/resolvers/HttpRouteResolver");
const { expressFactStore } = require("../parser/adapters/javascript/expressRouteExtractor");
const { createFileId } = require("../parser/irBuilder");
const { normalizeHttpResolution } = require("../graph/evidenceNormalizer");

const SNAPSHOTS_BUCKET = "graph-snapshots";

/**
 * Builds deterministic immutable storage path for a graph snapshot artifact.
 * Format:
 *   snapshots/tenant_${tenant}/repo_${repo}/commit_${commit}/v${snapshotVersion}_tok${fencingToken}_${sha12}.json
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {number} params.snapshotVersion
 * @param {number} params.fencingToken
 * @param {string} params.sha256
 * @returns {string}
 */
/**
 * Verifies the integrity of a retrieved FileIR artifact before admitting it into the graph pipeline.
 * Enforces checksum match, JSON validity, schema version, repository, commit, file path, blob SHA, and parser fingerprint.
 *
 * @param {object} params
 * @param {object} params.rec - Committed database record from ingestion_job_files
 * @param {Buffer|string} params.rawData - Raw bytes downloaded from Storage
 * @param {string} params.expectedRepositoryId - Target repository ID
 * @param {string} params.expectedCommitSha - Target commit revision
 * @returns {object} Verified FileIR document
 */
function verifyAndRehydrateFileIr({
  rec,
  rawData,
  expectedRepositoryId,
  expectedCommitSha,
}) {
  if (!rawData) {
    throw new AppError(404, "FILE_IR_ARTIFACT_MISSING", `FileIR artifact payload missing for file '${rec.path}'.`);
  }

  const rawBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData, "utf8");

  // 1. Checksum verification
  const computedSha = crypto.createHash("sha256").update(rawBuffer).digest("hex");
  if (rec.file_ir_sha256 && computedSha !== rec.file_ir_sha256) {
    throw new AppError(
      422,
      "FILE_IR_CHECKSUM_MISMATCH",
      `FileIR artifact for '${rec.path}' failed checksum verification. Expected ${rec.file_ir_sha256}, got ${computedSha}.`
    );
  }

  // 2. Deserialization
  let parsed;
  try {
    parsed = JSON.parse(rawBuffer.toString("utf8"));
  } catch (e) {
    throw new AppError(422, "FILE_IR_CORRUPTED", `FileIR artifact for '${rec.path}' is malformed JSON: ${e.message}`);
  }

  // 3. Schema version verification
  if (parsed.schemaVersion !== "1.0.0") {
    throw new AppError(
      422,
      "UNSUPPORTED_FILE_IR_SCHEMA",
      `FileIR artifact for '${rec.path}' has unsupported schemaVersion '${parsed.schemaVersion}'. Expected '1.0.0'.`
    );
  }

  // 4. Repository identity verification
  const docRepo =
    (parsed.analysis && parsed.analysis.repository && parsed.analysis.repository.fullName) ||
    (typeof parsed.repository === "string" ? parsed.repository : null) ||
    (parsed.repository && parsed.repository.fullName) ||
    null;

  if (docRepo && docRepo !== expectedRepositoryId) {
    throw new AppError(
      422,
      "REPOSITORY_MISMATCH",
      `FileIR artifact for '${rec.path}' belongs to repository '${docRepo}', expected '${expectedRepositoryId}'.`
    );
  }

  // 5. Commit SHA verification (reject mixed commits)
  const docCommit =
    (parsed.analysis && parsed.analysis.repository && parsed.analysis.repository.commitSha) ||
    parsed.commitSha ||
    (parsed.repository && parsed.repository.commitSha) ||
    null;

  if (docCommit && docCommit !== expectedCommitSha) {
    throw new AppError(
      422,
      "MIXED_COMMIT_FILE_IR",
      `FileIR artifact for '${rec.path}' belongs to commit '${docCommit}', expected '${expectedCommitSha}'.`
    );
  }

  // 6. File path verification
  const docPath =
    (parsed.file && parsed.file.path) ||
    (parsed.analysis && parsed.analysis.file && parsed.analysis.file.path) ||
    null;

  if (docPath && docPath !== rec.path) {
    throw new AppError(
      422,
      "FILE_PATH_MISMATCH",
      `FileIR artifact internal path '${docPath}' mismatches database record path '${rec.path}'.`
    );
  }

  // 7. Blob SHA verification
  const docBlobSha = (parsed.file && parsed.file.blobSha);
  if (rec.blob_sha && docBlobSha && docBlobSha !== rec.blob_sha) {
    throw new AppError(
      422,
      "BLOB_SHA_MISMATCH",
      `FileIR artifact blob SHA '${docBlobSha}' mismatches database record blob SHA '${rec.blob_sha}' for '${rec.path}'.`
    );
  }

  // 8. Parser fingerprint verification
  const docFingerprint = parsed.parserFingerprint || (parsed.analysis && parsed.analysis.parserFingerprint) || null;
  if (rec.parser_fingerprint && docFingerprint && docFingerprint !== rec.parser_fingerprint) {
    throw new AppError(
      422,
      "PARSER_FINGERPRINT_MISMATCH",
      `FileIR artifact parser fingerprint '${docFingerprint}' mismatches database record '${rec.parser_fingerprint}' for '${rec.path}'.`
    );
  }

  return parsed;
}

/**
 * Builds deterministic immutable storage path for a graph snapshot artifact.
 * Format:
 *   snapshots/tenant_${tenant}/repo_${repo}/commit_${commit}/v${snapshotVersion}_tok${fencingToken}_${sha12}.json
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {number} params.snapshotVersion
 * @param {number} params.fencingToken
 * @param {string} params.sha256
 * @returns {string}
 */
function buildSnapshotStoragePath({
  organizationId,
  repositoryId,
  commitSha,
  snapshotVersion,
  fencingToken,
  sha256,
}) {
  const safeOrg = (organizationId || "global").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeRepo = (repositoryId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeCommit = (commitSha || "main").replace(/[^a-zA-Z0-9_-]/g, "_");
  const sha12 = (sha256 || "000000000000").slice(0, 12);
  return `snapshots/tenant_${safeOrg}/repo_${safeRepo}/commit_${safeCommit}/v${snapshotVersion}_tok${fencingToken}_${sha12}.json`;
}

/**
 * Computes deterministic SHA-256 hash of a snapshot payload.
 *
 * @param {object|Buffer|string} payload
 * @returns {string}
 */
function computeSnapshotSha256(payload) {
  const buf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Incremental dependency resolution and canonical graph construction.
 * Evaluates all accumulated FileIR documents against the combined repository manifest.
 *
 * @param {object} params
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {string} [params.organizationId]
 * @param {Array<object>} params.fileIRList - Accumulated FileIR documents from Batches 1..B
 * @param {object} [options]
 * @returns {{ snapshot: object, evidenceList: Array<object>, sha256: string, buffer: Buffer, stats: object }}
 */
function resolveAndBuildGraph({
  repositoryId,
  commitSha,
  organizationId = null,
  fileIRList = [],
  options = {},
}) {
  const startTime = Date.now();

  // 1. Enforce repository identity and commit revision consistency (reject mixed commits)
  validateFileIRConsistency(fileIRList, repositoryId, commitSha);

  // 2. Extract supporting config files (e.g. tsconfig.json, pom.xml) from fileIRList or options
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

  // Extract manifest paths across all accumulated files (use full manifest if supplied, otherwise fileIR paths)
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

  // 3. Instantiate resolvers with combined accumulated manifest and supporting configuration
  const jsResolver = new JavaScriptModuleResolver({ manifest: manifestPaths, supportingFiles });
  const pyResolver = new PythonImportResolver({ manifest: manifestPaths, supportingFiles });
  const javaResolver = new JavaImportResolver({ manifest: manifestPaths, supportingFiles });
  const cppResolver = new CppIncludeResolver({ manifest: manifestPaths, supportingFiles });

  const evidenceList = [];

  for (const fileIr of fileIRList) {
    const filePath = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
    if (!filePath) continue;

    const lang = (fileIr.file && fileIr.file.language) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.language);
    const imports = Array.isArray(fileIr.imports) ? fileIr.imports : [];
    const exports = Array.isArray(fileIr.exports) ? fileIr.exports : (fileIr.analysis && Array.isArray(fileIr.analysis.exports) ? fileIr.analysis.exports : []);
    const calls = Array.isArray(fileIr.calls) ? fileIr.calls : (Array.isArray(fileIr.callSites) ? fileIr.callSites : []);
    const typeReferences = fileIr.typeReferences || (fileIr.analysis && fileIr.analysis.typeReferences) || [];

    // Resolve imports / includes across languages
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

    // Resolve Re-exports (exports with a source module specifier)
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

    // Normalize call facts (without speculative resolution)
    for (const call of calls) {
      const normCall = normalizeCallFact(call, filePath);
      evidenceList.push(normCall);
    }
  }

  // 3C. Collect HTTP request facts and Express route / router mount facts
  const clientRequests = [];
  const backendRoutes = [];
  const backendMounts = [];

  // Map FileIR IDs to relative file paths for normalization
  const fileIdToPathMap = new Map();
  const pathToIdMap = new Map();

  for (const fileIr of fileIRList) {
    const filePath = (fileIr.file && fileIr.file.path) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.path);
    const fileId = (fileIr.file && fileIr.file.id) || (fileIr.analysis && fileIr.analysis.file && fileIr.analysis.file.id) || (filePath ? createFileId(repositoryId, filePath) : null);
    if (fileId && filePath) {
      fileIdToPathMap.set(fileId, filePath);
      pathToIdMap.set(filePath, fileId);
    }

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

  const resolutionDurationMs = Date.now() - startTime;
  const buildStartTime = Date.now();

  // 4. Construct canonical graph snapshot
  const builder = new GraphBuilder({
    resolverVersions: options.resolverVersions,
  });

  const snapshot = builder.build(
    {
      repositoryId,
      commitSha,
      fileIRList,
      normalizedEvidenceList: evidenceList,
      manifest: options.manifest || null,
    },
    options
  );

  // Bind snapshot to organization context if provided
  if (organizationId) {
    snapshot.organizationId = organizationId;
    if (snapshot.repository) {
      snapshot.repository.organizationId = organizationId;
    }
  }

  // Attach publication metadata
  const snapshotVersion = options.snapshotVersion || 1;
  const batchNumber = options.batchNumber || 1;
  const isFinal = Boolean(options.isFinal);

  snapshot.publication = {
    organizationId,
    repositoryId,
    commitSha,
    jobId: options.jobId || null,
    snapshotVersion,
    batchNumber,
    graphContentSha256: null, // set below
    createdAt: new Date().toISOString(),
    graphStatus: isFinal ? "complete" : "partial",
  };

  // 5. Validate graph integrity before publication
  const validation = GraphValidator.validate(snapshot);
  if (!validation.isValid) {
    const err = new AppError(422, "INVALID_GRAPH_SNAPSHOT", `Graph candidate failed validation: ${validation.errors.join("; ")}`);
    err.validationErrors = validation.errors;
    throw err;
  }

  const graphBuildDurationMs = Date.now() - buildStartTime;

  // 6. Compute deterministic snapshot JSON and checksum
  // First compute graph content hash
  const graphPayloadSha256 = computeSnapshotSha256({
    schemaVersion: snapshot.schemaVersion,
    graphId: snapshot.graphId,
    repository: snapshot.repository,
    revision: snapshot.revision,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    unresolvedReferences: snapshot.unresolvedReferences,
  });
  snapshot.publication.graphContentSha256 = graphPayloadSha256;

  // Complete artifact buffer and its content-addressed checksum
  const buffer = Buffer.from(JSON.stringify(snapshot), "utf8");
  const artifactSha256 = computeSnapshotSha256(buffer);

  return {
    snapshot,
    evidenceList,
    sha256: artifactSha256,
    buffer,
    stats: {
      resolutionDurationMs,
      graphBuildDurationMs,
      totalNodes: snapshot.statistics ? snapshot.statistics.totalNodes : 0,
      totalEdges: snapshot.statistics ? snapshot.statistics.totalEdges : 0,
      unresolvedCount: snapshot.statistics ? snapshot.statistics.unresolvedCount : 0,
      ambiguousCount: snapshot.statistics ? snapshot.statistics.ambiguousCount : 0,
      bytes: buffer.length,
    },
  };
}

/**
 * Incremental Graph Publisher class coordinating resolution, storage upload,
 * atomic database publication, and in-memory cache indexing.
 */
class IncrementalGraphPublisher {
  /**
   * @param {object} [options]
   * @param {import('./IngestionJobManager').IngestionJobManager} [options.jobManager=defaultJobManager]
   * @param {import('../graph/GraphSnapshotStore').GraphSnapshotStore} [options.store=defaultStore]
   * @param {object} [options.storageClient]
   */
  constructor(options = {}) {
    this.jobManager = options.jobManager || defaultJobManager;
    this.store = options.store || defaultStore;
    this.storageClient = options.storageClient || null;
  }

  /**
   * Resolves accumulated FileIR state, builds canonical graph, uploads immutable snapshot to Storage,
   * commits the database pointer guarded by fencing token, and indexes into GraphSnapshotStore.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.organizationId]
   * @param {string} params.workerId
   * @param {number} params.fencingToken
   * @param {number} params.snapshotVersion
   * @param {number} [params.expectedPriorVersion=null]
   * @param {number} [params.batchNumber]
   * @param {boolean} [params.isFinal=false]
   * @param {Array<object>} [params.fileIRList] - Optional pre-loaded accumulated FileIR documents
   * @param {object} [options]
   * @returns {Promise<object>} Publication outcome summary
   */
  async publishIncrementalSnapshot({
    jobId,
    organizationId = null,
    workerId,
    fencingToken,
    snapshotVersion,
    expectedPriorVersion = null,
    batchNumber = 1,
    isFinal = false,
    fileIRList = null,
    options = {},
  }) {
    // 1. Fetch current job state & verify worker ownership / fencing before expensive graph resolution
    const job = await this.jobManager.getJob(jobId, organizationId);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `Job ${jobId} not found.`);

    if (job.claimed_by !== workerId) {
      throw new AppError(403, "WORKER_MISMATCH", `Worker ${workerId} does not own job ${jobId}.`);
    }
    if (Number(job.fencing_token) !== Number(fencingToken)) {
      throw new AppError(409, "STALE_FENCING_TOKEN", `Fencing token ${fencingToken} rejected. Current is ${job.fencing_token}.`);
    }
    if (!job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= Date.now()) {
      throw new AppError(403, "LEASE_EXPIRED", "Cannot publish snapshot: Worker lease has expired.");
    }
    if (["cancelled", "cancel_requested", "failed", "completed", "completed_with_errors", "completed_partial"].includes(job.status)) {
      throw new AppError(409, "JOB_NOT_ACTIVE", `Cannot publish snapshot: Job is in inactive state '${job.status}'.`);
    }

    const orgId = organizationId || job.organization_id;
    const repoId = job.repository_id;
    const commitSha = job.commit_sha;

    // 2. Load accumulated FileIR documents from Batches 1..B
    let accumulatedFileIRs = fileIRList || (options && options.fileIRList);

    if (!accumulatedFileIRs || !Array.isArray(accumulatedFileIRs)) {
      accumulatedFileIRs = [];
      const committedRecords = await this.jobManager.getCommittedFileRecords(jobId, orgId);

      const storage = options.storageClient || this.storageClient;
      if (!storage && committedRecords.length > 0) {
        throw new AppError(500, "STORAGE_CLIENT_REQUIRED", "storageClient is required to rehydrate committed FileIR artifacts.");
      }

      if (storage) {
        for (const rec of committedRecords) {
          if (!rec.file_ir_storage_path) {
            throw new AppError(404, "FILE_IR_ARTIFACT_MISSING", `Committed record for '${rec.path}' has no storage path.`);
          }
          const { data, error } = await storage.from("fileir-artifacts").download(rec.file_ir_storage_path);
          if (error || !data) {
            throw new AppError(
              404,
              "FILE_IR_ARTIFACT_MISSING",
              `FileIR artifact missing at '${rec.file_ir_storage_path}' for file '${rec.path}': ${error ? error.message : "Not found"}`
            );
          }
          const verifiedIR = verifyAndRehydrateFileIr({
            rec,
            rawData: data,
            expectedRepositoryId: repoId,
            expectedCommitSha: commitSha,
          });
          accumulatedFileIRs.push(verifiedIR);
        }
      }
    }

    // 3. Execute incremental resolution, canonical graph building, and validation
    const resolutionOutcome = resolveAndBuildGraph({
      repositoryId: repoId,
      commitSha,
      organizationId: orgId,
      fileIRList: accumulatedFileIRs,
      options: {
        ...options,
        jobId,
        snapshotVersion,
        batchNumber,
        isFinal,
      },
    });

    const { snapshot, sha256, buffer, stats } = resolutionOutcome;

    // 4. Build immutable storage path
    const snapshotStoragePath = buildSnapshotStoragePath({
      organizationId: orgId,
      repositoryId: repoId,
      commitSha,
      snapshotVersion,
      fencingToken,
      sha256,
    });

    // 5. Upload immutable snapshot artifact to Storage
    const storage = options.storageClient || this.storageClient;
    if (storage) {
      const uploadStartTime = Date.now();
      const { error: uploadError } = await storage
        .from(SNAPSHOTS_BUCKET)
        .upload(snapshotStoragePath, buffer, {
          contentType: "application/json",
          upsert: false,
        });

      if (uploadError) {
        throw new AppError(500, "STORAGE_UPLOAD_FAILED", `Snapshot storage upload failed: ${uploadError.message}`);
      }
      stats.uploadDurationMs = Date.now() - uploadStartTime;
    }

    // 6. Stage 2: Atomic database commit with fencing and lease guards
    // If this fails, the candidate artifact is preserved in storage as a safe orphan (never deleted synchronously)
    const dbCommitStartTime = Date.now();
    const confirmedEdges = snapshot.statistics ? snapshot.statistics.totalEdges : 0;
    const unresolvedReferences = snapshot.statistics
      ? snapshot.statistics.unresolvedCount + snapshot.statistics.ambiguousCount
      : 0;

    const dbCommitResult = await this.jobManager.publishSnapshot({
      jobId,
      organizationId: orgId,
      workerId,
      fencingToken,
      snapshotVersion,
      expectedPriorVersion,
      snapshotStoragePath,
      snapshotSha256: sha256,
      snapshotBytes: buffer.length,
      confirmedEdges,
      unresolvedReferences,
      isFinal,
    });
    stats.dbCommitDurationMs = Date.now() - dbCommitStartTime;

    // 7. Register and index into in-memory GraphSnapshotStore
    const store = options.store || this.store;
    const storeResult = store.put(snapshot, { organizationId: orgId });
    store.bindRepositoryToOrganization(repoId, orgId);
    store.bindRepositoryToOrganization(repoId, orgId);

    return {
      success: true,
      jobId,
      snapshot,
      queryService: storeResult.queryService,
      cacheKey: storeResult.cacheKey,
      snapshotVersion,
      snapshotStoragePath,
      snapshotSha256: sha256,
      snapshotBytes: buffer.length,
      confirmedEdges,
      unresolvedReferences,
      isFinal,
      graphStatus: dbCommitResult.graphStatus,
      status: dbCommitResult.status,
      stats,
    };
  }

  /**
   * Rehydrates and verifies a published snapshot from Storage.
   * Validates checksum integrity, schema version, and expected metadata.
   *
   * @param {object} params
   * @param {string} params.snapshotStoragePath
   * @param {string} params.expectedSha256
   * @param {string} params.expectedRepositoryId
   * @param {string} params.expectedCommitSha
   * @param {number} params.expectedVersion
   * @param {object} [params.storageClient]
   * @returns {Promise<object>} Verified snapshot
   */
  async rehydrateSnapshot({
    snapshotStoragePath,
    expectedSha256,
    expectedRepositoryId,
    expectedCommitSha,
    expectedVersion,
    storageClient = null,
  }) {
    const storage = storageClient || this.storageClient;
    if (!storage) {
      throw new AppError(500, "STORAGE_CLIENT_REQUIRED", "storageClient is required for snapshot rehydration.");
    }

    const { data, error } = await storage.from(SNAPSHOTS_BUCKET).download(snapshotStoragePath);
    if (error || !data) {
      throw new AppError(404, "SNAPSHOT_NOT_FOUND", `Snapshot artifact not found at ${snapshotStoragePath}.`);
    }

    const rawBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const computedSha = computeSnapshotSha256(rawBuffer);

    if (computedSha !== expectedSha256) {
      throw new AppError(
        422,
        "SNAPSHOT_INTEGRITY_VIOLATION",
        `Snapshot checksum mismatch. Expected: ${expectedSha256}, computed: ${computedSha}.`
      );
    }

    let snapshot;
    try {
      snapshot = JSON.parse(rawBuffer.toString("utf8"));
    } catch (e) {
      throw new AppError(422, "SNAPSHOT_CORRUPTED", `Failed to parse snapshot JSON: ${e.message}`);
    }

    if (snapshot.repository.repositoryId !== expectedRepositoryId) {
      throw new AppError(
        422,
        "SNAPSHOT_METADATA_MISMATCH",
        `Repository mismatch: expected '${expectedRepositoryId}', got '${snapshot.repository.repositoryId}'.`
      );
    }

    if (snapshot.revision.commitSha !== expectedCommitSha) {
      throw new AppError(
        422,
        "SNAPSHOT_METADATA_MISMATCH",
        `Commit SHA mismatch: expected '${expectedCommitSha}', got '${snapshot.revision.commitSha}'.`
      );
    }

    if (snapshot.publication && snapshot.publication.snapshotVersion !== expectedVersion) {
      throw new AppError(
        422,
        "SNAPSHOT_METADATA_MISMATCH",
        `Version mismatch: expected '${expectedVersion}', got '${snapshot.publication.snapshotVersion}'.`
      );
    }

    const val = GraphValidator.validate(snapshot);
    if (!val.isValid) {
      throw new AppError(422, "INVALID_GRAPH_SNAPSHOT", `Rehydrated snapshot failed validation: ${val.errors.join("; ")}`);
    }

    return snapshot;
  }

  /**
   * Rehydrates the latest published snapshot for a job from storage and indexes it into GraphSnapshotStore.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.organizationId]
   * @param {object} [params.store]
   * @param {object} [params.storageClient]
   * @returns {Promise<object|null>} Rehydrated snapshot entry or null if no snapshot published
   */
  async rehydrateLatestSnapshot({
    jobId,
    organizationId = null,
    store = null,
    storageClient = null,
  }) {
    const job = await this.jobManager.getJob(jobId, organizationId);
    if (!job || !job.snapshot_version || !job.snapshot_storage_path) {
      return null;
    }

    const storage = storageClient || this.storageClient;
    const targetStore = store || this.store;

    const snapshot = await this.rehydrateSnapshot({
      snapshotStoragePath: job.snapshot_storage_path,
      expectedSha256: job.snapshot_sha256,
      expectedRepositoryId: job.repository_id,
      expectedCommitSha: job.commit_sha,
      expectedVersion: job.snapshot_version,
      storageClient: storage,
    });

    const storeResult = targetStore.put(snapshot, { organizationId: job.organization_id });
    targetStore.bindRepositoryToOrganization(job.repository_id, job.organization_id);

    return {
      snapshot,
      queryService: storeResult.queryService,
      cacheKey: storeResult.cacheKey,
      snapshotVersion: job.snapshot_version,
      snapshotStoragePath: job.snapshot_storage_path,
    };
  }
}

/**
 * High-level orchestration helper for processing repository ingestion batches
 * according to Small, Medium, or Large repository policy.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {string} params.workerId
 * @param {number} params.fencingToken
 * @param {import('./ManifestScheduler').ManifestScheduler} params.scheduler
 * @param {IncrementalGraphPublisher} params.publisher
 * @param {object} [params.options]
 * @returns {Promise<object>} Orchestration summary
 */
async function processRepositoryIngestion({
  jobId,
  workerId,
  fencingToken,
  scheduler,
  publisher,
  options = {},
}) {
  const jobManager = scheduler.jobManager;
  const job = await jobManager.getJob(jobId);
  const mode = job.mode || "small";

  const publishedSnapshots = [];
  let batchCount = 0;
  let hasMore = true;

  while (hasMore) {
    // Process next batch (download, parse, and Stage 1 durable commit)
    const batchResult = await scheduler.processNextBatch({
      jobId,
      workerId,
      fencingToken,
      batchSize: options.batchSize || 100,
      options: {
        ...options,
        parseAndCommit: true,
      },
    });

    if (!batchResult.batchProcessed) {
      hasMore = false;
      break;
    }

    batchCount++;
    const currentJob = await jobManager.getJob(jobId);
    const pendingRemaining = currentJob.remaining_files;
    const isJobComplete = pendingRemaining === 0;

    if (mode === "small") {
      // Small repository policy:
      // Ingest all files in one continuous run, publishing 1 final complete graph at the end.
      if (isJobComplete) {
        const pubResult = await publisher.publishIncrementalSnapshot({
          jobId,
          organizationId: job.organization_id,
          workerId,
          fencingToken,
          snapshotVersion: 1,
          batchNumber: batchCount,
          isFinal: true,
          options,
        });
        publishedSnapshots.push(pubResult);
        hasMore = false;
      }
    } else {
      // Medium / Large repository policy:
      // Progressively publish graph updates starting from Batch 1, continuing automatically.
      const nextVersion = publishedSnapshots.length + 1;
      const pubResult = await publisher.publishIncrementalSnapshot({
        jobId,
        organizationId: job.organization_id,
        workerId,
        fencingToken,
        snapshotVersion: nextVersion,
        batchNumber: batchCount,
        isFinal: isJobComplete,
        options,
      });
      publishedSnapshots.push(pubResult);

      if (isJobComplete) {
        hasMore = false;
      }
    }
  }

  return {
    success: true,
    jobId,
    mode,
    batchesProcessed: batchCount,
    snapshotsPublished: publishedSnapshots.length,
    publishedSnapshots,
  };
}

const defaultPublisher = new IncrementalGraphPublisher();

module.exports = {
  SNAPSHOTS_BUCKET,
  buildSnapshotStoragePath,
  computeSnapshotSha256,
  verifyAndRehydrateFileIr,
  resolveAndBuildGraph,
  IncrementalGraphPublisher,
  processRepositoryIngestion,
  defaultPublisher,
};
